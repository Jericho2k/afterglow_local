import { asUser, characterFromRow } from "@/lib/db";
import { characterLikeSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const characters = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT c.*,p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,true liked_by_viewer
       FROM character_likes l
       JOIN characters c ON c.id=l.character_id AND c.visibility IN ('public','unlisted')
       LEFT JOIN profiles p ON p.id=c.user_id
       WHERE l.user_id=$1 ORDER BY l.created_at DESC`,
      [account.id],
    );
    return result.rows.map((row) => characterFromRow({ ...row, world_ids: [] }, account.id));
  });
  return Response.json({ characters });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = characterLikeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid character" }, { status: 400 });
  const result = await asUser(account.id, (client) => client.query(
    `INSERT INTO character_likes (user_id,character_id)
     SELECT $1,id FROM characters WHERE id=$2 AND user_id<>$1 AND visibility IN ('public','unlisted')
     ON CONFLICT DO NOTHING RETURNING character_id`,
    [account.id,parsed.data.characterId],
  ));
  if (!result.rowCount) {
    const exists = await asUser(account.id, (client) => client.query("SELECT 1 FROM character_likes WHERE user_id=$1 AND character_id=$2", [account.id,parsed.data.characterId]));
    if (!exists.rowCount) return Response.json({ error: "Character not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const characterId = new URL(request.url).searchParams.get("characterId");
  const parsed = characterLikeSchema.safeParse({ characterId });
  if (!parsed.success) return Response.json({ error: "Invalid character" }, { status: 400 });
  await asUser(account.id, (client) => client.query("DELETE FROM character_likes WHERE user_id=$1 AND character_id=$2", [account.id,parsed.data.characterId]));
  return Response.json({ ok: true });
}
