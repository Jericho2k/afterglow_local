import { asUser, creationSummaryFromRow } from "@/lib/db";
import { characterLikeSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Saving a creation.
 *
 * "Save" is the product's only affinity action, and it is one persistence
 * model: the `character_likes` table and the `characters.like_count` counter
 * it maintains. Those storage names predate the rename and are deliberately
 * untouched — introducing a second table for the same user action would be the
 * expensive mistake, not the old column name.
 *
 * The counter is maintained by a SECURITY DEFINER trigger, so the public total
 * is readable by everybody while the rows that make it up stay behind
 * `character_likes_all_own`: nobody can enumerate who saved what.
 */

/** The caller's saved library. Only ever their own rows — RLS enforces it too. */
export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const creations = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.tagline,c.avatar_url,c.avatar_path,c.accent,
         c.tags,c.hashtags,c.content_mode,c.nsfw_enabled,c.message_count,c.chat_count,c.like_count,c.published_at,c.created_at,
         p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,
         true saved_by_viewer
       FROM character_likes l
       JOIN characters c ON c.id=l.character_id AND c.visibility IN ('public','unlisted')
       LEFT JOIN profiles p ON p.id=c.user_id
       WHERE l.user_id=$1 ORDER BY l.created_at DESC`,
      [account.id],
    );
    return result.rows.map((row) => creationSummaryFromRow(row, account.id));
  });
  return Response.json({ creations });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = characterLikeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid creation" }, { status: 400 });
  // The select inside the insert is the authorisation: a private creation, or
  // the caller's own, produces no row rather than an error to interpret.
  const result = await asUser(account.id, (client) => client.query(
    `INSERT INTO character_likes (user_id,character_id)
     SELECT $1,id FROM characters WHERE id=$2 AND user_id<>$1 AND visibility IN ('public','unlisted')
     ON CONFLICT DO NOTHING RETURNING character_id`,
    [account.id,parsed.data.characterId],
  ));
  if (!result.rowCount) {
    // Nothing inserted is either "already saved", which is success, or "not
    // yours to save", which is not.
    const exists = await asUser(account.id, (client) => client.query("SELECT 1 FROM character_likes WHERE user_id=$1 AND character_id=$2", [account.id,parsed.data.characterId]));
    if (!exists.rowCount) return Response.json({ error: "Creation not found" }, { status: 404 });
  }
  const total = await savedTotal(account.id, parsed.data.characterId);
  return Response.json({ ok: true, saved: true, saveCount: total });
}

export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const characterId = new URL(request.url).searchParams.get("characterId");
  const parsed = characterLikeSchema.safeParse({ characterId });
  if (!parsed.success) return Response.json({ error: "Invalid creation" }, { status: 400 });
  await asUser(account.id, (client) => client.query("DELETE FROM character_likes WHERE user_id=$1 AND character_id=$2", [account.id,parsed.data.characterId]));
  const total = await savedTotal(account.id, parsed.data.characterId);
  return Response.json({ ok: true, saved: false, saveCount: total });
}

/**
 * The authoritative global total after the write, so an optimistic card can
 * settle on the real number instead of trusting its own arithmetic. Null when
 * the creation is no longer readable, which the caller renders as "leave it".
 */
async function savedTotal(userId: string, characterId: string) {
  const result = await asUser(userId, (client) => client.query(
    "SELECT like_count FROM characters WHERE id=$1 AND (user_id=$2 OR visibility IN ('public','unlisted'))",
    [characterId, userId],
  ));
  return result.rows[0] ? Number(result.rows[0].like_count || 0) : null;
}
