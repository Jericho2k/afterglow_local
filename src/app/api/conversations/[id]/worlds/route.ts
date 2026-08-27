import { ownedConversation } from "@/lib/access";
import { asUser, worldSummaryFromRow } from "@/lib/db";
import {
  attachConversationWorld, conversationWorldSummaries, detachConversationWorld, ensureConversationWorlds,
} from "@/lib/conversation-worlds";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * The worlds one story is written with.
 *
 * A story's set, never a Creation's. The chat used to reach this through
 * `PATCH /api/characters/{id}`, which rewrites `character_worlds` — so a reader
 * adding a world to their own story silently added it to the Creation, to the
 * creator's published canon, and to every other reader's prompt. This endpoint
 * cannot do that: it writes exactly one table and that table is scoped to one
 * conversation and one account.
 *
 * Three refusals are worth naming, because each is a different leak:
 *
 *   NOT YOUR CONVERSATION → 404. `ownedConversation` carries the `user_id`
 *   predicate and row level security carries the policy; the two fail
 *   independently.
 *
 *   NOT A WORLD YOU MAY READ → 403. Attaching is filtered by the same
 *   predicate the world list uses, so a private world belonging to somebody
 *   else cannot be linked into a prompt even by id.
 *
 *   NOT A UUID → 400, before anything is looked up.
 */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The worlds this account may attach: their own, plus anything published. */
async function attachableWorlds(userId: string) {
  return asUser(userId, async (client) => {
    const result = await client.query(
      `SELECT w.id,w.user_id,w.name,w.description,w.cover_path,w.cover_url,w.visibility,w.save_count,w.created_at,w.updated_at,
         (mine.world_id IS NOT NULL) saved_by_viewer,
         p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path
       FROM worlds w
       LEFT JOIN world_saves mine ON mine.world_id=w.id AND mine.user_id=$1
       LEFT JOIN profiles p ON p.id=w.user_id
       WHERE w.user_id=$1 OR mine.world_id IS NOT NULL
       ORDER BY (w.user_id=$1) DESC, w.updated_at DESC
       LIMIT 100`,
      [userId],
    );
    return result.rows.map((row) => worldSummaryFromRow(row, userId));
  });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  if (!uuid.test(id)) return Response.json({ error: "Conversation not found" }, { status: 404 });

  const attached = await asUser(account.id, async (client) => {
    const row = await ownedConversation(client, account.id, id);
    if (!row) return null;
    // A story from before this relation existed gets its snapshot here rather
    // than appearing to have deliberately no worlds.
    await ensureConversationWorlds(client, account.id, row);
    return conversationWorldSummaries(client, account.id, id);
  });
  if (!attached) return Response.json({ error: "Conversation not found" }, { status: 404 });

  // Both lists in one response: the picker needs "attached to this story" and
  // "available to attach", and asking for them separately would be two round
  // trips to draw one sheet.
  return Response.json({ worlds: attached, available: await attachableWorlds(account.id) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const worldId = typeof body.worldId === "string" ? body.worldId : "";
  if (!uuid.test(id)) return Response.json({ error: "Conversation not found" }, { status: 404 });
  if (!uuid.test(worldId)) return Response.json({ error: "Invalid world" }, { status: 400 });

  const result = await asUser(account.id, async (client) => {
    const row = await ownedConversation(client, account.id, id);
    if (!row) return { error: "Conversation not found" as const, status: 404 as const };
    await ensureConversationWorlds(client, account.id, row);
    const attached = await attachConversationWorld(client, account.id, id, worldId);
    if (!attached) return { error: "That world is not available to you" as const, status: 403 as const };
    return { worlds: await conversationWorldSummaries(client, account.id, id) };
  });
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const worldId = new URL(request.url).searchParams.get("worldId") ?? "";
  if (!uuid.test(id)) return Response.json({ error: "Conversation not found" }, { status: 404 });
  if (!uuid.test(worldId)) return Response.json({ error: "Invalid world" }, { status: 400 });

  const result = await asUser(account.id, async (client) => {
    const row = await ownedConversation(client, account.id, id);
    if (!row) return { error: "Conversation not found" as const, status: 404 as const };
    await detachConversationWorld(client, account.id, id, worldId);
    // Removing the last world from a story is a decision, so the story stays
    // marked initialized and will not silently re-inherit the Creation's
    // defaults the next time it is opened.
    await client.query("UPDATE conversations SET worlds_initialized=true WHERE id=$1 AND user_id=$2", [id, account.id]);
    return { worlds: await conversationWorldSummaries(client, account.id, id) };
  });
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
