import { randomUUID } from "node:crypto";
import { readableCharacter } from "@/lib/access";
import { asUser } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { commentSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";
import type { CharacterComment } from "@/lib/types";

/**
 * Comments — social discussion, not star reviews.
 *
 * One route serves creations and worlds. They are two tables, because
 * `character_comments` carries a working policy set keyed to character
 * visibility and rewriting it into a polymorphic table would risk a live
 * relation for tidiness. What they share is everything above the table: the
 * same shape, the same attribution rule, the same rate limit and the same
 * authorisation posture — a comment is readable exactly where its subject is.
 *
 * Visibility is enforced by the policies in migrations 0009 and 0014
 * independently of the predicates here, so a mistake in either is caught by
 * the other.
 */

type Target = { table: "character_comments"; column: "character_id"; id: string }
  | { table: "world_comments"; column: "world_id"; id: string };

function commentFromRow(row: Record<string, unknown>, viewerId: string): CharacterComment {
  const authorId = String(row.user_id ?? "");
  return {
    id: String(row.id),
    characterId: String(row.character_id ?? ""),
    worldId: String(row.world_id ?? ""),
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

/** Which subject this request is about. Exactly one, or none. */
function targetFrom(characterId?: string | null, worldId?: string | null): Target | null {
  if (characterId && !worldId) return { table: "character_comments", column: "character_id", id: characterId };
  if (worldId && !characterId) return { table: "world_comments", column: "world_id", id: worldId };
  return null;
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const params = new URL(request.url).searchParams;
  const target = targetFrom(params.get("characterId"), params.get("worldId"));
  if (!target) return Response.json({ error: "Provide a characterId or a worldId" }, { status: 400 });

  const comments = await asUser(account.id, async (client) => {
    // The table name is chosen from a closed set above, never interpolated
    // from caller input; the subject id is always a bound parameter.
    const result = await client.query(
      `SELECT k.*,p.username author_username,p.display_name author_display_name,p.avatar_path author_avatar_path
       FROM ${target.table} k
       LEFT JOIN profiles p ON p.id=k.user_id AND (p.id=$2 OR p.username IS NOT NULL)
       WHERE k.${target.column}=$1
       ORDER BY k.created_at DESC
       LIMIT 100`,
      [target.id, account.id],
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
  const target = targetFrom(value.characterId, value.worldId);
  if (!target) return Response.json({ error: "Provide a characterId or a worldId" }, { status: 400 });

  const comment = await asUser(account.id, async (client) => {
    // The subject id arrives from the browser, so it is verified rather than
    // trusted: something private belonging to somebody else resolves to null
    // and the insert never runs.
    if (target.table === "character_comments") {
      if (!(await readableCharacter(client, account.id, target.id))) return null;
    } else {
      const world = await client.query(
        "SELECT 1 FROM worlds WHERE id=$1 AND (user_id=$2 OR visibility IN ('public','unlisted'))",
        [target.id, account.id],
      );
      if (!world.rowCount) return null;
    }
    const result = await client.query(
      `WITH inserted AS (
         INSERT INTO ${target.table} (id,${target.column},user_id,parent_id,body) VALUES ($1,$2,$3,$4,$5) RETURNING *
       )
       SELECT i.*,p.username author_username,p.display_name author_display_name,p.avatar_path author_avatar_path
       FROM inserted i LEFT JOIN profiles p ON p.id=i.user_id`,
      [randomUUID(), target.id, account.id, value.parentId ?? null, value.body],
    );
    return result.rows[0] ? commentFromRow(result.rows[0], account.id) : null;
  });

  if (!comment) return Response.json({ error: target.table === "world_comments" ? "World not found" : "Character not found" }, { status: 404 });
  return Response.json({ comment }, { status: 201 });
}

export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  // Which table the comment is in, said explicitly rather than guessed by
  // deleting from both and seeing which one had it.
  const table = params.get("worldId") ? "world_comments" : "character_comments";

  // Authors remove their own; a subject's owner may also remove one from their
  // page. The delete policies allow exactly those two cases and nothing here
  // widens them.
  const result = await asUser(account.id, (client) => client.query(`DELETE FROM ${table} WHERE id=$1`, [id]));
  if (!result.rowCount) return Response.json({ error: "Comment not found" }, { status: 404 });
  return Response.json({ ok: true });
}
