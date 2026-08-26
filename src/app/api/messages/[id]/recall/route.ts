import { asUser, memoryArcFromRow, memoryFromRow, messageFromRow } from "@/lib/db";
import { adminRequired, currentAccount, unauthorized } from "@/lib/session";

/**
 * What one reply actually recalled.
 *
 * "Recalled 6" used to be counted from the ids stored on the message, while the
 * panel behind it resolved those ids against a list the browser had loaded when
 * the CHAT was opened. Memory consolidation runs after every reply, so any
 * memory created since then was recalled by name and then found by nobody: the
 * count said six and the panel said nothing. Two sources, one of them stale.
 *
 * There is one source now, and it is this. The count and the contents are the
 * same array, so they cannot disagree — including for a memory that has since
 * been edited away or deleted, which is reported as an item rather than
 * silently dropped. A number that does not match what is under it is worse than
 * a smaller number.
 *
 * What it deliberately does NOT return: embeddings, similarity scores, ranking
 * weights, retrieval-run internals, provider identifiers. Those are diagnostics
 * about the machine, and this answers a question about the story. Row level
 * security scopes every read to the caller's own rows, so a published creation
 * never exposes anybody else's continuity.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = adminRequired(account); if (denied) return denied;
  const { id } = await context.params;

  const payload = await asUser(account.id, async (client) => {
    const messageResult = await client.query("SELECT * FROM messages WHERE id=$1 AND user_id=$2", [id, account.id]);
    if (!messageResult.rowCount) return null;
    const message = messageFromRow(messageResult.rows[0]);

    /*
     * Explicit placeholders rather than `= ANY($1::uuid[])`.
     *
     * The array form is fine in PostgreSQL and unsupported by the in-memory
     * engine the tests run against, and a query shape that cannot be tested is
     * worse than a slightly longer one — the same trade the worlds route makes.
     * Both lists are bounded by the account's own recall limits, so this can
     * never grow a statement without bound.
     */
    const byIds = async (table: "memories" | "memory_arcs", ids: string[]) => {
      if (!ids.length) return [] as Array<Record<string, unknown>>;
      const placeholders = ids.map((_value, index) => `$${index + 2}`).join(",");
      const result = await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND id IN (${placeholders})`, [account.id, ...ids]);
      return result.rows;
    };
    const memories = { rows: await byIds("memories", message.memoryIds) };
    const arcs = { rows: await byIds("memory_arcs", message.arcIds) };

    const memoryById = new Map(memories.rows.map((row) => [String(row.id), memoryFromRow(row)]));
    const arcById = new Map(arcs.rows.map((row) => [String(row.id), memoryArcFromRow(row)]));

    // Stored order is recall order, and every stored id produces exactly one
    // item — present or not. That equality is the whole fix.
    const items = [
      ...message.memoryIds.map((memoryId) => {
        const memory = memoryById.get(memoryId);
        return memory
          ? {
            kind: "memory" as const, id: memoryId, available: true as const,
            content: memory.content, memoryKind: memory.kind, status: memory.status,
            importance: memory.importance, resolution: memory.resolution,
            scope: memory.conversationId ? ("chat" as const) : ("creation" as const),
          }
          : { kind: "memory" as const, id: memoryId, available: false as const };
      }),
      ...message.arcIds.map((arcId) => {
        const arc = arcById.get(arcId);
        return arc
          ? {
            kind: "arc" as const, id: arcId, available: true as const,
            summary: arc.summary, startMessageCount: arc.startMessageCount, endMessageCount: arc.endMessageCount,
          }
          : { kind: "arc" as const, id: arcId, available: false as const };
      }),
    ];

    return {
      items,
      counts: {
        memories: message.memoryIds.length,
        arcs: message.arcIds.length,
        unavailable: items.filter((item) => !item.available).length,
        total: items.length,
      },
    };
  });

  if (!payload) return Response.json({ error: "Message not found" }, { status: 404 });
  return Response.json(payload);
}
