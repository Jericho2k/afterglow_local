import { randomUUID } from "node:crypto";
import { conversationCharacter, ownedConversation } from "@/lib/access";
import { asUser, getUserSettings, messageFromRow, personaFromRow, worldFromRow } from "@/lib/db";
import { streamCompletion, type LLMUsage } from "@/lib/llm";
import { maybeConsolidate, relevantContinuity } from "@/lib/memory";
import { focusedRetrievalQuery, maybeBackfillMemoryEmbeddings, maybeCurateCanon, memoryRetrievalV2Enabled, retrieveContinuityV2 } from "@/lib/memory-v2";
import { continueSceneCue, roleplayPrompt } from "@/lib/prompts";
import { sceneStateEnabled, sceneStateRetrievalHintEnabled } from "@/lib/memory-flags";
import { sceneFieldsOf, sceneRetrievalCue } from "@/lib/scene-state";
import { currentSceneState, dropSceneStateForMessage, maybeUpdateSceneState } from "@/lib/scene-state-store";
import { anchoredFetchLimit, recallText, selectAnchoredMessages } from "@/lib/context";
import { chatSchema } from "@/lib/schemas";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { currentAccount, isAdminAccount, unauthorized } from "@/lib/session";
import { recordUsageEvent } from "@/lib/usage";
import { providerModelId, resolveEngine, resolveModel, taskModelSelection } from "@/lib/provider";
import { responseLengths, type AppSettings, type ResponseLength } from "@/lib/types";
import { responseLengthPlan } from "@/lib/response-length";
import { inferenceSessionId } from "@/lib/inference-session";
import { ProviderError, logProviderDiagnostic, publicErrorMessage, publicErrorStatus } from "@/lib/provider-errors";

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
      worlds: worldResult.rows.map((row) => worldFromRow(row)),
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
    // A deployment routing mistake is an operator problem. The reader is told
    // what they can act on, not what the environment variable is called.
    console.error("[provider] RP_MODEL_ROUTE is misconfigured", error instanceof Error ? error.message : error);
    return Response.json({ error: "This chat's model is not available on this deployment. Choose another model in chat tools.", reason: "model_unavailable" },{ status:409 });
  }
  const engineId = String(row.rp_engine_id || settings.roleplayPreset) as AppSettings["roleplayPreset"];
  const storedResponseLength = String(row.response_length || "");
  const responseLength: ResponseLength = responseLengths.includes(storedResponseLength as ResponseLength) ? storedResponseLength as ResponseLength : settings.responseLength;
  const temperature = row.temperature == null ? settings.temperature : Math.min(2,Math.max(0,Number(row.temperature)));
  const conversationModelDefinition = resolveModel(conversationSelection.providerId,conversationSelection.modelId);
  const modelDefinition = resolveModel(selection.providerId, selection.modelId);
  const engineDefinition = resolveEngine(engineId);
  /*
   * Model retirement, handled rather than crashed into.
   *
   * A conversation stores the provider and model it was started with, and an
   * upstream model can be retired underneath it. That must not turn the whole
   * chat into a mystery: the reply is refused with a sentence that says what
   * happened and what to do, and `reason` lets the client offer the model
   * picker directly. Nothing is silently substituted — the writer a reader
   * chose is never swapped for another one behind their back.
   */
  if (!conversationModelDefinition || !modelDefinition || !engineDefinition) {
    return Response.json({
      error: !engineDefinition
        ? "This chat's roleplay engine is no longer available. Choose another one in chat tools."
        : "This chat's model is no longer available. Choose another model in chat tools — your story, memories and settings are untouched.",
      reason: !engineDefinition ? "engine_unavailable" : "model_unavailable",
    }, { status: 409 });
  }

  // Memory maintenance is deliberately not on the reply's critical path. The
  // recent transcript already carries the newest accepted turns, while the
  // rolling summary is updated in the background after successful replies.
  const currentSummary = String(row.summary || "");
  const sceneEnabled = sceneStateEnabled(account.id);

  const staged = await asUser(account.id, async (client) => {
    let regenerateTarget: ReturnType<typeof messageFromRow> | null = null;
    let userMessageId: string | null = null;

    if (action === "send") {
      userMessageId = parsed.data.userMessageId ?? randomUUID();
      await client.query("INSERT INTO messages (id,conversation_id,user_id,role,content,authored_event_id) VALUES ($1,$2,$3,'user',$4,$1)", [userMessageId, conversationId, account.id, content]);
      await client.query(
        `UPDATE conversations SET message_count=message_count+1,updated_at=now(),
         title=CASE WHEN message_count <= 1 AND title LIKE 'Chat with %' THEN left($2,120) ELSE title END WHERE id=$1 AND user_id=$3`,
        [conversationId, content.replace(/\s+/g, " "), account.id],
      );
    } else if (action === "regenerate") {
      const last = await client.query("SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [conversationId, account.id]);
      if (last.rows[0]?.role === "assistant") regenerateTarget = messageFromRow(last.rows[0]);
      // The reply about to be replaced may have moved the scene. Dropping the
      // state read out of it here means the discarded generation cannot leave
      // its location, cast, or open loops behind, whatever happens next.
      if (regenerateTarget && sceneEnabled) await dropSceneStateForMessage(client,conversationId,regenerateTarget.id,account.id);
    }

    // A few rows past the context limit, so the anchored window below has the
    // messages it may keep. The extra rows are read, not necessarily sent.
    const historyResult = await client.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3",
      [conversationId, account.id, anchoredFetchLimit(settings.contextMessages)],
    );
    const totalMessages = await client.query(
      "SELECT COUNT(*)::int count FROM messages WHERE conversation_id=$1 AND user_id=$2",
      [conversationId, account.id],
    );
    const availableHistory = historyResult.rows.reverse().map(messageFromRow).filter((message) => message.id !== regenerateTarget?.id);
    // Anchored rather than strictly sliding: the same transcript the budget
    // would have selected, with its start quantised so a provider's prompt
    // cache survives more than one turn. Never fewer messages than before.
    const history = selectAnchoredMessages(availableHistory, Number(totalMessages.rows[0]?.count || availableHistory.length), settings.contextMessages, settings.contextTokenBudget);
    const lastUserInput = [...history].reverse().find((message) => message.role === "user")?.content ?? content;
    const recallContext = recallText(history, lastUserInput || character.scenario || character.name);
    // Where and when this reply happens. Read after any regeneration cleanup so
    // a replaced generation's scene is already out of the way.
    const sceneState = sceneEnabled ? await currentSceneState(client,account.id,conversationId) : null;
    return { regenerateTarget, userMessageId, history, lastUserInput, recallContext, sceneState };
  });

  const { regenerateTarget, userMessageId, history, lastUserInput, recallContext, sceneState } = staged;
  // Selection stays relevance-driven. The cue is opt-in and additive so an
  // A/B comparison can separate grounding from ranking.
  const sceneRetrievalHint = sceneState && sceneStateRetrievalHintEnabled() ? sceneRetrievalCue(sceneFieldsOf(sceneState)) : "";
  if (!lastUserInput && action !== "continue") return Response.json({ error: "Nothing to regenerate" }, { status: 400 });

  const continuationRetrievalAnchor = action === "continue" && history.at(-1)?.role === "assistant" ? history.at(-1)!.content : "";
  let memories; let arcs; let coreCanon = [] as Awaited<ReturnType<typeof retrieveContinuityV2>>["coreCanon"];
  if (memoryRetrievalV2Enabled(account.id)) {
    try {
      const continuity = await retrieveContinuityV2({
        userId:account.id,characterId:row.character_id,conversationId,
        // A continuation is asked about where the scene IS, not about the turn
        // that is already answered, so its retrieval anchor is the reply being
        // continued rather than the reader's older message.
        query:focusedRetrievalQuery(history,(action === "continue" ? continuationRetrievalAnchor : "") || lastUserInput || character.scenario || character.name,sceneRetrievalHint),
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

  // With the layer off, the writer prompt is byte-identical to today's: no
  // scene block, and no historical tags even on memories stamped while it was
  // on. That is what makes an enabled/disabled comparison mean something.
  const groundedMemories = sceneEnabled ? memories : memories.map((memory) => ({ ...memory, scene: null }));
  const groundedArcs = sceneEnabled ? arcs : arcs.map((arc) => ({ ...arc, storyDayStart: null, storyDayEnd: null, locations: [] }));
  const system = roleplayPrompt(character, currentSummary, groundedMemories, groundedArcs, { ...settings, roleplayPreset: engineId, responseLength }, {
    worlds,
    persona,
    coreCanon,
    sceneState: sceneState ? sceneFieldsOf(sceneState) : null,
    instructionPresets: Array.isArray(row.instruction_presets) ? row.instruction_presets : [],
    customInstructions: String(row.custom_instructions || ""),
  });
  const modelHistory = history.map((message) => ({ role: message.role, content: message.content }));
  /*
   * Continue is a continuation, not another attempt.
   *
   * Two conditions have to hold for that to be true, and neither used to be
   * checked. The transcript must actually END with the reply being continued —
   * a "continue from your last reply" instruction with no last reply in the
   * transcript is exactly the state in which the writer answers the reader's
   * earlier turn again, which is Regenerate wearing Continue's label. And the
   * cue must name where to start, which is why it quotes that reply's final
   * sentences back; see `continueSceneCue`.
   *
   * When there is nothing to continue from — a reply that failed to persist, a
   * story whose newest message is the reader's — the cue is omitted entirely
   * and this becomes an ordinary generation. That is the honest behaviour: a
   * next reply is what the reader wanted, and pretending to continue from a
   * reply that is not there is what produced the bug.
   */
  const continuedReply = action === "continue" && history.at(-1)?.role === "assistant" ? history.at(-1)!.content : "";
  if (action === "continue" && continuedReply.trim()) modelHistory.push({ role: "user", content: continueSceneCue(continuedReply) });

  const completionMessages = [{ role: "system" as const, content: system },...modelHistory];
  // Response Length owns the output envelope as well as the directive. The
  // account's `maxTokens` is the Natural baseline the other two scale from, so
  // Concise has a genuinely lower ceiling than Detailed without any mode ever
  // being cut off: see src/lib/response-length.ts for why each ceiling sits
  // far above the words its own directive asks for.
  const lengthPlan = responseLengthPlan(responseLength, settings.maxTokens);
  const completionOptions = {
    signal: request.signal,
    maxTokens: lengthPlan.maxTokens,
    temperature,
    thinking: engineDefinition.thinking && modelDefinition.supportsThinking,
    // Conversation-scoped provider stickiness. Sequential turns in one story
    // ask for the same upstream host, which is what lets its prompt cache stay
    // warm; a different story is a different session and shares nothing.
    sessionId: inferenceSessionId("rp_generation", conversationId),
  };
  let upstream: ReadableStream<Uint8Array>;
  const requestStartedAt = Date.now();
  try {
    upstream = await streamCompletion(selection,completionMessages,completionOptions);
  } catch (error) {
    // The operator gets the status, the route and the upstream body; the
    // reader gets one sentence. These are two different strings on purpose —
    // returning `error.message` here is what used to put raw provider JSON
    // inside a roleplay.
    logProviderDiagnostic("rp generation failed before streaming", error instanceof ProviderError
      ? error.withDiagnostic({ conversationId, provider: selection.providerId, model: selection.modelId })
      : error);
    return Response.json({ error: publicErrorMessage(error) }, { status: publicErrorStatus(error) });
  }
  if (userMessageId) {
    await asUser(account.id, (client) => client.query(
      "UPDATE messages SET generation_started_at=COALESCE(generation_started_at,now()) WHERE id=$1 AND user_id=$2 AND role='user'",
      [userMessageId, account.id],
    ));
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
      let upstreamProvider: string | undefined;
      let ttftMs: number | undefined;
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      const recordAttemptUsage = async () => {
        if (!usage) return;
        await recordUsageEvent({ userId: account.id, conversationId, providerId: selection.providerId, model: selection.modelId, actualModel: actualProviderModel, rpEngineId: engineId, responseLength, kind: action === "send" ? "chat" : action, taskRoute: "rp_generation", usage });
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
                if (typeof data?.provider === "string") upstreamProvider = data.provider;
                const delta = data?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta) { if(ttftMs===undefined)ttftMs=Math.max(0,Date.now()-startedAt); assistant += delta; send({ type: "delta", content: delta }); }
                if (data?.usage) usage = {
                  ...data.usage,
                  provider_request_id: providerRequestId,
                  actual_model: actualProviderModel,
                  latency_ms: Math.max(0,Date.now() - startedAt),
                  ttft_ms:ttftMs,
                  upstream_provider:upstreamProvider,
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
          //
          // The guard is deliberately "no visible text at all". A generation
          // that already streamed prose is never retried: appending a second,
          // independent continuation on top of it would produce a doubled or
          // self-contradicting reply, which is a worse failure than the one it
          // would be papering over.
          await recordAttemptUsage();
          buffer = ""; usage = null; providerRequestId = undefined; upstreamProvider=undefined; ttftMs=undefined;
          actualProviderModel = providerModelId(selection.providerId,selection.modelId) ?? selection.modelId;
          const retryStartedAt = Date.now();
          const retry = await streamCompletion(selection,completionMessages,completionOptions);
          await consume(retry,retryStartedAt);
        }
        if (!assistant.trim()) throw new ProviderError("empty_response", { conversationId, provider: selection.providerId, model: selection.modelId, actualModel: actualProviderModel, upstreamProvider, attempt: 2, detail: "two attempts produced no text" });
        const variants: string[] = regenerateTarget ? [...regenerateTarget.variants, assistant] : [assistant];
        const selectedVariant = variants.length - 1;
        const memoryIds = memories.map((memory) => memory.id);
        const arcIds = arcs.map((arc) => arc.id);

        // The reply is complete and every field the client needs is already
        // known here, so the completion event is emitted before the write
        // rather than after it. Holding it until the database round trips
        // finished left the text sitting on screen for seconds with its
        // controls still hidden, which read as a freeze.
        send({ type: "done", id: assistantId, userMessageId, variants, selectedVariant, ...(isAdminAccount(account)?{memoriesUsed: memoryIds, arcsUsed: arcIds, usage}: {}) });

        try {
          // One statement per transaction: each extra round trip to a pooled
          // remote database is latency the reader would otherwise wait through.
          if (regenerateTarget) {
            await asUser(account.id, (client) => client.query(
              `WITH saved AS (
                 UPDATE messages SET content=$1,variants=$2::jsonb,selected_variant=$3,memory_ids=$4::uuid[],memory_arc_ids=$5::uuid[]
                 WHERE id=$6 AND user_id=$7 RETURNING conversation_id
               )
               UPDATE conversations SET updated_at=now() WHERE id=(SELECT conversation_id FROM saved) AND user_id=$7`,
              [assistant,JSON.stringify(variants),selectedVariant,memoryIds,arcIds,assistantId,account.id],
            ));
          } else {
            await asUser(account.id, (client) => client.query(
              `WITH saved AS (
                 INSERT INTO messages (id,conversation_id,user_id,role,content,variants,selected_variant,memory_ids,memory_arc_ids)
                 VALUES ($1,$2,$3,'assistant',$4,$5::jsonb,0,$6::uuid[],$7::uuid[]) RETURNING conversation_id
               )
               UPDATE conversations SET message_count=message_count+1,updated_at=now()
               WHERE id=(SELECT conversation_id FROM saved) AND user_id=$3`,
              [assistantId,conversationId,account.id,assistant,JSON.stringify(variants),memoryIds,arcIds],
            ));
          }
        } catch (error) {
          // The reader was already told the reply finished, so a failed write
          // has to be reported rather than swallowed: the text on their screen
          // would otherwise disappear on the next reload with no explanation.
          console.error("Reply persistence failed", error);
          send({ type: "error", error: "That reply could not be saved. Reload the chat before continuing." });
        }

        // Accounting must not hold the accepted-message event (and therefore
        // the post-stream controls) behind another database round trip.
        void recordAttemptUsage().catch((error)=>console.error("Usage accounting failed",error));
        controller.close();
        void (async () => {
          // Scene State first: consolidation stamps the memories it creates
          // with whatever the scene ledger knows by then. A failure in either
          // is logged and dropped — the reply has already been delivered.
          await maybeUpdateSceneState(account.id,conversationId);
          if (regenerateTarget) return;
          await maybeConsolidate(account.id,conversationId);
          await maybeCurateCanon(account.id,conversationId);
          await maybeBackfillMemoryEmbeddings(account.id,conversationId);
        })().catch((error) => console.error("Memory maintenance failed",error));
      } catch (error) {
        logProviderDiagnostic("rp generation failed mid-stream", error instanceof ProviderError
          ? error.withDiagnostic({ conversationId, provider: selection.providerId, model: selection.modelId, actualModel: actualProviderModel, upstreamProvider })
          : error);
        send({ type: "error", error: publicErrorMessage(error) });
        controller.close();
      }
    },
  });
  return new Response(responseStream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
