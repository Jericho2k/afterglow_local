import { randomUUID } from "node:crypto";
import { conversationCharacter, ownedConversation } from "@/lib/access";
import { asUser, getUserSettings, messageFromRow, personaFromRow, worldFromRow } from "@/lib/db";
import { streamCompletion, type LLMUsage } from "@/lib/llm";
import { maybeConsolidate, relevantContinuity } from "@/lib/memory";
import { focusedRetrievalQuery, maybeBackfillMemoryEmbeddings, maybeCurateCanon, memoryRetrievalV2Enabled, retrieveContinuityV2 } from "@/lib/memory-v2";
import { continueSceneCue, roleplayPrompt } from "@/lib/prompts";
import { recallText, selectRecentMessages } from "@/lib/context";
import { chatSchema } from "@/lib/schemas";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";
import { recordUsageEvent } from "@/lib/usage";
import { providerModelId, resolveEngine, resolveModel, taskModelSelection } from "@/lib/provider";
import type { AppSettings } from "@/lib/types";

export const maxDuration = 120;

export async function POST(request: Request) {
  // Authorisation happens before anything is written and, critically, before
  // any paid model call: an unauthenticated or unauthorised request must never
  // reach DeepSeek.
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`chat:${account.id}`, 60, 60_000); if (limited) return limited;
  const ipLimited = checkRateLimit(`chat-ip:${clientIp(request)}`, 120, 60_000); if (ipLimited) return ipLimited;
  const parsed = chatSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  const { conversationId, content, action } = parsed.data;
  if (action === "send" && !content) return Response.json({ error: "Message cannot be empty" }, { status: 400 });

  // Phase one: resolve and validate everything the prompt needs, inside a
  // single account-scoped transaction.
  const prepared = await asUser(account.id, async (client) => {
    const row = await ownedConversation(client, account.id, conversationId);
    if (!row) return { error: "Conversation not found" as const };
    const { character, owned } = await conversationCharacter(client, account.id, row);
    if (!character) return { error: "Character not found" as const };

    const settings = await getUserSettings(client, account.id);
    // Worlds only apply to the caller's own characters. A published character
    // carries its lore in the frozen snapshot instead, so a creator cannot
    // reach into a stranger's prompt by editing an attached world.
    const worldResult = owned
      ? await client.query(
        "SELECT w.* FROM worlds w JOIN character_worlds cw ON cw.world_id=w.id WHERE cw.character_id=$1 AND w.user_id=$2 ORDER BY w.updated_at DESC",
        [row.character_id, account.id],
      )
      : { rows: [] as Array<Record<string, unknown>> };
    const personaResult = row.persona_id
      ? await client.query("SELECT * FROM personas WHERE id=$1 AND user_id=$2", [row.persona_id, account.id])
      : await client.query("SELECT * FROM personas WHERE user_id=$1 AND is_default=true LIMIT 1", [account.id]);

    return {
      row,
      character,
      settings,
      worlds: worldResult.rows.map(worldFromRow),
      persona: personaResult.rows[0] ? personaFromRow(personaResult.rows[0]) : null,
    };
  });
  if ("error" in prepared) return Response.json({ error: prepared.error }, { status: 404 });
  const { row, character, settings, worlds, persona } = prepared;
  const conversationSelection = {
    providerId: String(row.provider_id || settings.providerId),
    modelId: String(row.model_id || settings.model),
  };
  let selection: typeof conversationSelection;
  try {
    selection = taskModelSelection("rp_generation",conversationSelection);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The RP model route is unavailable" },{ status:409 });
  }
  const engineId = String(row.rp_engine_id || settings.roleplayPreset) as AppSettings["roleplayPreset"];
  const conversationModelDefinition = resolveModel(conversationSelection.providerId,conversationSelection.modelId);
  const modelDefinition = resolveModel(selection.providerId, selection.modelId);
  const engineDefinition = resolveEngine(engineId);
  if (!conversationModelDefinition || !modelDefinition || !engineDefinition) return Response.json({ error: "This chat's model or roleplay engine is no longer available. Choose another one in chat tools." }, { status: 409 });

  // Memory maintenance is deliberately not on the reply's critical path. The
  // recent transcript already carries the newest accepted turns, while the
  // rolling summary is updated in the background after successful replies.
  const currentSummary = String(row.summary || "");

  const staged = await asUser(account.id, async (client) => {
    let regenerateTarget: ReturnType<typeof messageFromRow> | null = null;
    let userMessageId: string | null = null;

    if (action === "send") {
      userMessageId = parsed.data.userMessageId ?? randomUUID();
      await client.query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user',$4)", [userMessageId, conversationId, account.id, content]);
      await client.query(
        `UPDATE conversations SET message_count=message_count+1,updated_at=now(),
         title=CASE WHEN message_count <= 1 AND title LIKE 'Chat with %' THEN left($2,120) ELSE title END WHERE id=$1 AND user_id=$3`,
        [conversationId, content.replace(/\s+/g, " "), account.id],
      );
    } else if (action === "regenerate") {
      const last = await client.query("SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [conversationId, account.id]);
      if (last.rows[0]?.role === "assistant") regenerateTarget = messageFromRow(last.rows[0]);
    }

    const historyResult = await client.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3",
      [conversationId, account.id, settings.contextMessages],
    );
    const availableHistory = historyResult.rows.reverse().map(messageFromRow).filter((message) => message.id !== regenerateTarget?.id);
    const history = selectRecentMessages(availableHistory, settings.contextMessages, settings.contextTokenBudget);
    const lastUserInput = [...history].reverse().find((message) => message.role === "user")?.content ?? content;
    const recallContext = recallText(history, lastUserInput || character.scenario || character.name);
    return { regenerateTarget, userMessageId, history, lastUserInput, recallContext };
  });

  const { regenerateTarget, userMessageId, history, lastUserInput, recallContext } = staged;
  if (!lastUserInput && action !== "continue") return Response.json({ error: "Nothing to regenerate" }, { status: 400 });

  let memories; let arcs; let coreCanon = [] as Awaited<ReturnType<typeof retrieveContinuityV2>>["coreCanon"];
  if (memoryRetrievalV2Enabled(account.id)) {
    try {
      const continuity = await retrieveContinuityV2({
        userId:account.id,characterId:row.character_id,conversationId,
        query:focusedRetrievalQuery(history,lastUserInput || character.scenario || character.name),
        messageId:userMessageId,limit:settings.memoryLimit,tokenBudget:settings.memoryTokenBudget,
      });
      ({memories,arcs,coreCanon}=continuity);
    } catch (error) {
      // Schema/configuration mistakes must not take chat down during the staged
      // rollout. The complete V1 path remains the operational fallback.
      console.error("Memory Retrieval V2 failed; using V1",error);
      ({memories,arcs}=await asUser(account.id,(client)=>relevantContinuity(client,account.id,row.character_id,conversationId,recallContext,settings.memoryLimit,settings.memoryTokenBudget)));
    }
  } else {
    ({memories,arcs}=await asUser(account.id,(client)=>relevantContinuity(client,account.id,row.character_id,conversationId,recallContext,settings.memoryLimit,settings.memoryTokenBudget)));
  }

  const system = roleplayPrompt(character, currentSummary, memories, arcs, { ...settings, roleplayPreset: engineId }, {
    worlds,
    persona,
    coreCanon,
    instructionPresets: Array.isArray(row.instruction_presets) ? row.instruction_presets : [],
    customInstructions: String(row.custom_instructions || ""),
  });
  const modelHistory = history.map((message) => ({ role: message.role, content: message.content }));
  if (action === "continue") modelHistory.push({ role: "user", content: continueSceneCue });

  const completionMessages = [{ role: "system" as const, content: system },...modelHistory];
  const completionOptions = { signal: request.signal, maxTokens: settings.maxTokens, temperature: settings.temperature, thinking: engineDefinition.thinking && modelDefinition.supportsThinking };
  let upstream: ReadableStream<Uint8Array>;
  const requestStartedAt = Date.now();
  try {
    upstream = await streamCompletion(selection,completionMessages,completionOptions);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Model request failed" }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const assistantId = regenerateTarget?.id ?? parsed.data.assistantMessageId ?? randomUUID();
  const responseStream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let assistant = "";
      let usage: LLMUsage | null = null;
      let providerRequestId: string | undefined;
      let actualProviderModel = providerModelId(selection.providerId,selection.modelId) ?? selection.modelId;
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      const recordAttemptUsage = async () => {
        if (!usage) return;
        await recordUsageEvent({ userId: account.id, conversationId, providerId: selection.providerId, model: selection.modelId, actualModel: actualProviderModel, rpEngineId: engineId, kind: action === "send" ? "chat" : action, taskRoute: "rp_generation", usage });
      };
      const consume = async (stream: ReadableStream<Uint8Array>,startedAt: number) => {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const data = JSON.parse(payload);
                if (typeof data?.id === "string") providerRequestId = data.id;
                if (typeof data?.model === "string") actualProviderModel = data.model;
                const delta = data?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta) { assistant += delta; send({ type: "delta", content: delta }); }
                if (data?.usage) usage = {
                  ...data.usage,
                  provider_request_id: providerRequestId,
                  actual_model: actualProviderModel,
                  latency_ms: Math.max(0,Date.now() - startedAt),
                };
              } catch { /* ignore malformed upstream chunks */ }
            }
          }
        } finally { reader.releaseLock(); }
      };
      try {
        await consume(upstream,requestStartedAt);
        if (!assistant.trim()) {
          // Some routed providers occasionally finish a successful HTTP stream
          // without text. Account for that attempt, then transparently retry
          // once so the user does not have to delete and resend their turn.
          await recordAttemptUsage();
          buffer = ""; usage = null; providerRequestId = undefined;
          actualProviderModel = providerModelId(selection.providerId,selection.modelId) ?? selection.modelId;
          const retryStartedAt = Date.now();
          const retry = await streamCompletion(selection,completionMessages,completionOptions);
          await consume(retry,retryStartedAt);
        }
        if (!assistant.trim()) throw new Error("The model returned no text after two attempts. Please try again.");
        let variants: string[];
        let selectedVariant: number;
        if (regenerateTarget) {
          variants = [...regenerateTarget.variants,assistant]; selectedVariant = variants.length - 1;
          await asUser(account.id, async (client) => {
            await client.query("UPDATE messages SET content=$1,variants=$2::jsonb,selected_variant=$3,memory_ids=$4::uuid[],memory_arc_ids=$5::uuid[] WHERE id=$6 AND user_id=$7", [assistant,JSON.stringify(variants),selectedVariant,memories.map((memory) => memory.id),arcs.map((arc) => arc.id),assistantId,account.id]);
            await client.query("UPDATE conversations SET updated_at=now() WHERE id=$1 AND user_id=$2", [conversationId,account.id]);
          });
        } else {
          variants = [assistant]; selectedVariant = 0;
          await asUser(account.id, async (client) => {
            await client.query("INSERT INTO messages (id,conversation_id,user_id,role,content,variants,selected_variant,memory_ids,memory_arc_ids) VALUES ($1,$2,$3,'assistant',$4,$5::jsonb,0,$6::uuid[],$7::uuid[])", [assistantId,conversationId,account.id,assistant,JSON.stringify(variants),memories.map((memory) => memory.id),arcs.map((arc) => arc.id)]);
            await client.query("UPDATE conversations SET message_count=message_count+1,updated_at=now() WHERE id=$1 AND user_id=$2", [conversationId,account.id]);
          });
        }
        await recordAttemptUsage();
        send({ type: "done", id: assistantId, userMessageId, variants, selectedVariant, memoriesUsed: memories.map((memory) => memory.id), arcsUsed: arcs.map((arc) => arc.id), usage });
        controller.close();
        if (!regenerateTarget) void (async () => {
          await maybeConsolidate(account.id,conversationId);
          await maybeCurateCanon(account.id,conversationId);
          await maybeBackfillMemoryEmbeddings(account.id,conversationId);
        })().catch((error) => console.error("Memory maintenance failed",error));
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "Stream failed" });
        controller.close();
      }
    },
  });
  return new Response(responseStream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
