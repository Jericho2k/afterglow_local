import { asUser, worldFromRow } from "@/lib/db";
import { worldSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * A world is a first-class public object with its own page, so it is readable
 * by anyone the creator published it to — not only by its owner. Characters
 * referencing it are listed too, which is what makes the relationship
 * "world used by many characters" rather than "world embedded in one".
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;

  const detail = await asUser(account.id, async (client) => {
    const result = await client.query(
      "SELECT * FROM worlds WHERE id=$1 AND (user_id=$2 OR visibility IN ('public','unlisted'))",
      [id, account.id],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    // Only characters the viewer is allowed to see are listed back.
    const characters = await client.query(
      `SELECT c.id,c.name,c.tagline,c.avatar_path,c.avatar_url,c.accent
       FROM characters c JOIN character_worlds cw ON cw.character_id=c.id
       WHERE cw.world_id=$1 AND (c.user_id=$2 OR c.visibility IN ('public','unlisted'))
       ORDER BY c.updated_at DESC LIMIT 24`,
      [id, account.id],
    );
    return {
      world: worldFromRow(row),
      owner: String(row.user_id ?? "") === account.id,
      characters: characters.rows.map((character) => ({
        id: String(character.id),
        name: String(character.name),
        tagline: String(character.tagline ?? ""),
        avatarPath: String(character.avatar_path ?? ""),
        avatarUrl: String(character.avatar_url ?? ""),
        accent: String(character.accent ?? "#e879a9"),
      })),
    };
  });

  if (!detail) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json(detail);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = worldSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid world" }, { status: 400 });
  const value = parsed.data;
  const result = await asUser(account.id, (client) => client.query(
    "UPDATE worlds SET name=$1,description=$2,content=$3,visibility=$4,cover_path=$7,cover_url=$8,updated_at=now() WHERE id=$5 AND user_id=$6 RETURNING *",
    [value.name,value.description,value.content,value.visibility,id,account.id,value.coverPath,value.coverUrl],
  ));
  if (!result.rowCount) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json({ world: worldFromRow(result.rows[0]) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const result = await asUser(account.id, (client) => client.query("DELETE FROM worlds WHERE id=$1 AND user_id=$2", [id, account.id]));
  if (!result.rowCount) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json({ ok: true });
}
