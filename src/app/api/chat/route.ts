import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { characterFromRow, getSettings, messageFromRow, query, transaction } from "@/lib/db";
import { streamCompletion } from "@/lib/deepseek";
import { maybeConsolidate, relevantMemories } from "@/lib/memory";
import { roleplayPrompt } from "@/lib/prompts";
import { chatSchema } from "@/lib/schemas";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export const maxDuration = 120;

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const limited = checkRateLimit(`chat:${clientIp(request)}`, 60, 60_000); if (limited) return limited;
  const parsed = chatSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  const { conversationId, content, action } = parsed.data;

  const conversationResult = await query(
    `SELECT c.*, row_to_json(ch.*) character FROM conversations c JOIN characters ch ON ch.id=c.character_id WHERE c.id=$1`,
    [conversationId],
  );
  if (!conversationResult.rowCount) return Response.json({ error: "Conversation not found" }, { status: 404 });
  const row = conversationResult.rows[0];
  const character = characterFromRow(row.character);
  const settings = await getSettings();
  let removedAssistant: { id: string; content: string; created_at: Date } | null = null;
  const restoreRemovedAssistant = async () => {
    if (!removedAssistant) return;
    await query(
      "INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'assistant',$3,$4) ON CONFLICT (id) DO NOTHING",
      [removedAssistant.id,conversationId,removedAssistant.content,removedAssistant.created_at],
    );
    await query("UPDATE conversations SET message_count=(SELECT COUNT(*) FROM messages WHERE conversation_id=$1),updated_at=now() WHERE id=$1",[conversationId]);
  };

  if (action === "send" && !content) return Response.json({ error: "Message cannot be empty" }, { status: 400 });
  if (action === "send") {
    await query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user',$3)", [randomUUID(),conversationId,content]);
    await query(
      `UPDATE conversations SET message_count=message_count+1,updated_at=now(),
       title=CASE WHEN message_count <= 1 AND title LIKE 'Chat with %' THEN left($2,120) ELSE title END WHERE id=$1`,
      [conversationId, content.replace(/\s+/g, " ")],
    );
  } else {
    await transaction(async (client) => {
      const last = await client.query("SELECT id,role,content,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [conversationId]);
      if (last.rows[0]?.role === "assistant") {
        removedAssistant = last.rows[0] as { id: string; content: string; created_at: Date };
        await client.query("DELETE FROM messages WHERE id=$1", [last.rows[0].id]);
        await client.query("UPDATE conversations SET message_count=GREATEST(0,message_count-1),updated_at=now() WHERE id=$1", [conversationId]);
      }
    });
  }

  const historyResult = await query("SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT $2", [conversationId, settings.contextMessages]);
  const history = historyResult.rows.reverse().map(messageFromRow);
  const lastUserInput = [...history].reverse().find((message) => message.role === "user")?.content ?? content;
  if (!lastUserInput) return Response.json({ error: "Nothing to regenerate" }, { status: 400 });
  const memories = await relevantMemories(character.id, lastUserInput, settings.memoryLimit);
  const system = roleplayPrompt(character, String(row.summary || ""), memories, settings);

  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await streamCompletion([
      { role: "system", content: system },
      ...history.map((message) => ({ role: message.role, content: message.content })),
    ], { signal: request.signal, model: settings.model, maxTokens: settings.maxTokens, temperature: settings.temperature });
  } catch (error) {
    await restoreRemovedAssistant();
    return Response.json({ error: error instanceof Error ? error.message : "Model request failed" }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const assistantId = randomUUID();
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
        await query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'assistant',$3)", [assistantId,conversationId,assistant]);
        await query("UPDATE conversations SET message_count=message_count+1,updated_at=now() WHERE id=$1", [conversationId]);
        if (usage) await query(
          "INSERT INTO usage_events (id,conversation_id,model,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [randomUUID(),conversationId,settings.model,usage.prompt_tokens ?? 0,usage.completion_tokens ?? 0,usage.prompt_cache_hit_tokens ?? 0,usage.prompt_cache_miss_tokens ?? 0],
        );
        send({ type: "done", id: assistantId, memoriesUsed: memories.map((memory) => memory.id), usage });
        controller.close();
        void maybeConsolidate(conversationId).catch((error) => console.error("Memory consolidation failed", error));
      } catch (error) {
        await restoreRemovedAssistant().catch((restoreError) => console.error("Could not restore regenerated message",restoreError));
        send({ type: "error", error: error instanceof Error ? error.message : "Stream failed" });
        controller.close();
      }
    },
  });
  return new Response(responseStream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
