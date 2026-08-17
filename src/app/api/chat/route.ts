import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { characterFromRow, getSettings, messageFromRow, query } from "@/lib/db";
import { streamCompletion } from "@/lib/deepseek";
import { maybeConsolidate, relevantMemories } from "@/lib/memory";
import { continueSceneCue, roleplayPrompt } from "@/lib/prompts";
import { recallText, selectRecentMessages } from "@/lib/context";
import { chatSchema } from "@/lib/schemas";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export const maxDuration = 120;

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const limited = checkRateLimit(`chat:${clientIp(request)}`, 60, 60_000); if (limited) return limited;
  const parsed = chatSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  const { conversationId, content, action } = parsed.data;

  const conversationResult = await query("SELECT * FROM conversations WHERE id=$1", [conversationId]);
  if (!conversationResult.rowCount) return Response.json({ error: "Conversation not found" }, { status: 404 });
  const row = conversationResult.rows[0];
  const characterResult = await query("SELECT * FROM characters WHERE id=$1", [row.character_id]);
  if (!characterResult.rowCount) return Response.json({ error: "Character not found" }, { status: 404 });
  const character = characterFromRow(characterResult.rows[0]);
  const settings = await getSettings();
  let currentSummary = String(row.summary || "");
  // If a previous background consolidation was interrupted by a deploy or cold
  // shutdown, catch it up before building the next prompt.
  const caughtUp = await maybeConsolidate(conversationId).catch((error) => {
    console.error("Pre-reply memory consolidation failed", error); return false;
  });
  if (caughtUp) {
    const refreshed = await query("SELECT summary FROM conversations WHERE id=$1", [conversationId]);
    currentSummary = String(refreshed.rows[0]?.summary || currentSummary);
  }
  let regenerateTarget: ReturnType<typeof messageFromRow> | null = null;
  let userMessageId: string | null = null;

  if (action === "send" && !content) return Response.json({ error: "Message cannot be empty" }, { status: 400 });
  if (action === "send") {
    userMessageId = parsed.data.userMessageId ?? randomUUID();
    await query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user',$3)", [userMessageId,conversationId,content]);
    await query(
      `UPDATE conversations SET message_count=message_count+1,updated_at=now(),
       title=CASE WHEN message_count <= 1 AND title LIKE 'Chat with %' THEN left($2,120) ELSE title END WHERE id=$1`,
      [conversationId, content.replace(/\s+/g, " ")],
    );
  } else if (action === "regenerate") {
    const last = await query("SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [conversationId]);
    if (last.rows[0]?.role === "assistant") regenerateTarget = messageFromRow(last.rows[0]);
  }

  const historyResult = await query("SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2", [conversationId, settings.contextMessages]);
  const availableHistory = historyResult.rows.reverse().map(messageFromRow).filter((message) => message.id !== regenerateTarget?.id);
  const history = selectRecentMessages(availableHistory, settings.contextMessages, settings.contextTokenBudget);
  const lastUserInput = [...history].reverse().find((message) => message.role === "user")?.content ?? content;
  if (!lastUserInput && action !== "continue") return Response.json({ error: "Nothing to regenerate" }, { status: 400 });
  const recallContext = recallText(history, lastUserInput || character.scenario || character.name);
  const memories = await relevantMemories(character.id, recallContext, settings.memoryLimit);
  const system = roleplayPrompt(character, currentSummary, memories, settings);
  const modelHistory = history.map((message) => ({ role: message.role, content: message.content }));
  if (action === "continue") modelHistory.push({ role: "user", content: continueSceneCue });

  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await streamCompletion([
      { role: "system", content: system },
      ...modelHistory,
    ], { signal: request.signal, model: settings.model, maxTokens: settings.maxTokens, temperature: settings.temperature, thinking: settings.roleplayPreset === "deliberate" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Model request failed" }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const assistantId = regenerateTarget?.id ?? parsed.data.assistantMessageId ?? randomUUID();
  const responseStream = new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      let assistant = "";
      let usage: Record<string, number> | null = null;
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
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
              const delta = data?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) { assistant += delta; send({ type: "delta", content: delta }); }
              if (data?.usage) usage = data.usage;
            } catch { /* ignore malformed upstream chunks */ }
          }
        }
        if (!assistant.trim()) throw new Error("The model returned an empty response");
        let variants: string[];
        let selectedVariant: number;
        if (regenerateTarget) {
          variants = [...regenerateTarget.variants,assistant]; selectedVariant = variants.length - 1;
          await query("UPDATE messages SET content=$1,variants=$2::jsonb,selected_variant=$3,memory_ids=$4::uuid[] WHERE id=$5", [assistant,JSON.stringify(variants),selectedVariant,memories.map((memory) => memory.id),assistantId]);
          await query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
        } else {
          variants = [assistant]; selectedVariant = 0;
          await query("INSERT INTO messages (id,conversation_id,role,content,variants,selected_variant,memory_ids) VALUES ($1,$2,'assistant',$3,$4::jsonb,0,$5::uuid[])", [assistantId,conversationId,assistant,JSON.stringify(variants),memories.map((memory) => memory.id)]);
          await query("UPDATE conversations SET message_count=message_count+1,updated_at=now() WHERE id=$1", [conversationId]);
        }
        if (usage) await query(
          "INSERT INTO usage_events (id,conversation_id,model,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [randomUUID(),conversationId,settings.model,usage.prompt_tokens ?? 0,usage.completion_tokens ?? 0,usage.prompt_cache_hit_tokens ?? 0,usage.prompt_cache_miss_tokens ?? 0],
        );
        send({ type: "done", id: assistantId, userMessageId, variants, selectedVariant, memoriesUsed: memories.map((memory) => memory.id), usage });
        controller.close();
        if (!regenerateTarget) void maybeConsolidate(conversationId).catch((error) => console.error("Memory consolidation failed", error));
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "Stream failed" });
        controller.close();
      }
    },
  });
  return new Response(responseStream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
