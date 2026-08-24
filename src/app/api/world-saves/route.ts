import { asUser } from "@/lib/db";
import { worldSaveSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Saving a world.
 *
 * The same product action as saving a creation, over its own relation: worlds
 * and creations are different tables with different owners and different
 * visibility checks, and the counter trigger behind each is bound to one of
 * them. What is shared is the contract — save, unsave, an authoritative total
 * back — which is what lets one client helper drive both.
 *
 * `world_saves` is readable only by the account that wrote it, so the public
 * total is visible to everybody while nobody can enumerate who saved what.
 */

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = worldSaveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid world" }, { status: 400 });
  const { worldId } = parsed.data;

  // The select inside the insert is the authorisation: a private world, or the
  // caller's own, produces no row rather than an error to interpret.
  const result = await asUser(account.id, (client) => client.query(
    `INSERT INTO world_saves (user_id,world_id)
     SELECT $1,id FROM worlds WHERE id=$2 AND user_id<>$1 AND visibility IN ('public','unlisted')
     ON CONFLICT DO NOTHING RETURNING world_id`,
    [account.id, worldId],
  ));
  if (!result.rowCount) {
    // Nothing inserted is either "already saved", which is success, or "not
    // yours to save", which is not.
    const exists = await asUser(account.id, (client) => client.query(
      "SELECT 1 FROM world_saves WHERE user_id=$1 AND world_id=$2", [account.id, worldId],
    ));
    if (!exists.rowCount) return Response.json({ error: "World not found" }, { status: 404 });
  }
  return Response.json({ ok: true, saved: true, saveCount: await savedTotal(account.id, worldId) });
}

export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = worldSaveSchema.safeParse({ worldId: new URL(request.url).searchParams.get("worldId") });
  if (!parsed.success) return Response.json({ error: "Invalid world" }, { status: 400 });
  await asUser(account.id, (client) => client.query(
    "DELETE FROM world_saves WHERE user_id=$1 AND world_id=$2", [account.id, parsed.data.worldId],
  ));
  return Response.json({ ok: true, saved: false, saveCount: await savedTotal(account.id, parsed.data.worldId) });
}

/**
 * The authoritative global total after the write, so an optimistic card can
 * settle on the real number rather than trusting its own arithmetic. Null when
 * the world is no longer readable, which the caller renders as "leave it".
 */
async function savedTotal(userId: string, worldId: string) {
  const result = await asUser(userId, (client) => client.query(
    "SELECT save_count FROM worlds WHERE id=$1 AND (user_id=$2 OR visibility IN ('public','unlisted'))",
    [worldId, userId],
  ));
  return result.rows[0] ? Number(result.rows[0].save_count || 0) : null;
}
