import { randomUUID } from "node:crypto";
import { readableCharacter } from "@/lib/access";
import { asUser } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { commentSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";
import type { CharacterComment } from "@/lib/types";

/**
 * Public character comments — social discussion, not star reviews.
 *
 * Visibility follows the character: a comment is readable wherever the
 * character is readable, and the policies in migration 0009 enforce that
 * independently of these predicates.
 */
function commentFromRow(row: Record<string, unknown>, viewerId: string): CharacterComment {
  const authorId = String(row.user_id ?? "");
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    body: String(row.body ?? ""),
    likeCount: Number(row.like_count ?? 0),
    createdAt: new Date(String(row.created_at)).toISOString(),
    // Attribution is public only for accounts that opted into a username,
    // matching how creator attribution already works.
    author: row.author_username || authorId === viewerId
      ? {
        id: authorId,
        username: String(row.author_username ?? ""),
        displayName: String(row.author_display_name ?? ""),
        avatarPath: String(row.author_avatar_path ?? ""),
      }
      : null,
    authoredByViewer: authorId === viewerId,
  };
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const characterId = new URL(request.url).searchParams.get("characterId");
  if (!characterId) return Response.json({ error: "characterId is required" }, { status: 400 });

  const comments = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT k.*,p.username author_username,p.display_name author_display_name,p.avatar_path author_avatar_path
       FROM character_comments k
       LEFT JOIN profiles p ON p.id=k.user_id AND (p.id=$2 OR p.username IS NOT NULL)
       WHERE k.character_id=$1
       ORDER BY k.created_at DESC
       LIMIT 100`,
      [characterId, account.id],
    );
    return result.rows.map((row) => commentFromRow(row, account.id));
  });

  return Response.json({ comments });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`comment:${account.id}`, 20, 10 * 60_000); if (limited) return limited;
  const parsed = commentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid comment" }, { status: 400 });
  const value = parsed.data;

  const comment = await asUser(account.id, async (client) => {
    // The character id arrives from the browser, so it is verified rather than
    // trusted: a private character belonging to somebody else resolves to null.
    if (!(await readableCharacter(client, account.id, value.characterId))) return null;
    const result = await client.query(
      `WITH inserted AS (
         INSERT INTO character_comments (id,character_id,user_id,parent_id,body) VALUES ($1,$2,$3,$4,$5) RETURNING *
       )
       SELECT i.*,p.username author_username,p.display_name author_display_name,p.avatar_path author_avatar_path
       FROM inserted i LEFT JOIN profiles p ON p.id=i.user_id`,
      [randomUUID(), value.characterId, account.id, value.parentId ?? null, value.body],
    );
    return result.rows[0] ? commentFromRow(result.rows[0], account.id) : null;
  });

  if (!comment) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ comment }, { status: 201 });
}

export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  // Authors remove their own; a character's owner may also remove one from
  // their page. The delete policy allows exactly those two cases.
  const result = await asUser(account.id, (client) => client.query("DELETE FROM character_comments WHERE id=$1", [id]));
  if (!result.rowCount) return Response.json({ error: "Comment not found" }, { status: 404 });
  return Response.json({ ok: true });
}
