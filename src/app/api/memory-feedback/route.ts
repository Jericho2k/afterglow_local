import { randomUUID } from "node:crypto";
import { asUser } from "@/lib/db";
import { memoryFeedbackSchema } from "@/lib/schemas";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * A reader saying "she got this wrong".
 *
 * The cheapest high-quality signal available to the memory programme: the
 * person who was actually in the story tells us a specific reply broke it, and
 * the row points at the retrieval run that produced it. One join against
 * `memory_retrieval_runs` then turns a complaint into the exact ranked list,
 * the exact scores and the exact token allocations behind it.
 *
 * Nothing is copied. The label references the message; the message stays where
 * it lives under the policies it already has.
 */
export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`memory-feedback:${account.id}`, 60, 60_000);
  if (limited) return limited;

  const parsed = memoryFeedbackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid feedback" }, { status: 400 });
  const { messageId, conversationId, category, note } = parsed.data;

  const saved = await asUser(account.id, async (client) => {
    // Ownership is proved first and explicitly: the message must be the
    // caller's own assistant reply in the conversation they named, or a
    // crafted id could attach a label to somebody else's story.
    const owned = await client.query(
      "SELECT id FROM messages WHERE id=$1 AND user_id=$2 AND conversation_id=$3 AND role='assistant'",
      [messageId, account.id, conversationId],
    );
    if (!owned.rowCount) return null;

    // The retrieval run behind this reply, which is the entire value of the
    // label: one join later it becomes the exact ranked list and its scores.
    // Preferring the run stamped with this message, falling back to the most
    // recent one in the conversation for replies generated before that
    // stamping existed.
    const exact = await client.query(
      "SELECT id FROM memory_retrieval_runs WHERE user_id=$1 AND message_id=$2 ORDER BY created_at DESC LIMIT 1",
      [account.id, messageId],
    );
    const fallback = exact.rowCount ? exact : await client.query(
      "SELECT id FROM memory_retrieval_runs WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 1",
      [account.id, conversationId],
    );
    const retrievalRunId = fallback.rows[0]?.id ?? null;

    const result = await client.query(
      `INSERT INTO memory_feedback (id,user_id,conversation_id,message_id,retrieval_run_id,category,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id,message_id)
         DO UPDATE SET category=EXCLUDED.category, note=EXCLUDED.note, created_at=now()
       RETURNING id,category,retrieval_run_id`,
      [randomUUID(), account.id, conversationId, messageId, retrievalRunId, category, note],
    );
    return result.rows[0] ?? null;
  });

  if (!saved) return Response.json({ error: "Message not found" }, { status: 404 });
  return Response.json({
    feedback: {
      id: String(saved.id),
      category: String(saved.category),
      // Returned so the admin diagnostics can jump straight to the run.
      retrievalRunId: saved.retrieval_run_id ? String(saved.retrieval_run_id) : null,
    },
  });
}

/** Withdrawing a label. A reader who changes their mind leaves no trace. */
export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const messageId = new URL(request.url).searchParams.get("messageId") ?? "";
  if (!/^[0-9a-fA-F-]{36}$/.test(messageId)) return Response.json({ error: "Invalid message" }, { status: 400 });

  const result = await asUser(account.id, (client) => client.query(
    "DELETE FROM memory_feedback WHERE user_id=$1 AND message_id=$2 RETURNING id",
    [account.id, messageId],
  ));
  if (!result.rowCount) return Response.json({ error: "Feedback not found" }, { status: 404 });
  return Response.json({ ok: true });
}
