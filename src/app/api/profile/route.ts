import { asUser, characterFromRow, profileFromRow } from "@/lib/db";
import { profileSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET(request?: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const username = request ? new URL(request.url).searchParams.get("username")?.trim().toLowerCase() : "";
  const payload = await asUser(account.id, async (client) => {
    const profile = username
      ? await client.query("SELECT * FROM profiles WHERE username=$1", [username])
      : await client.query("SELECT * FROM profiles WHERE id=$1", [account.id]);
    if (!profile.rowCount) return null;
    if (!username) return { profile: profileFromRow(profile.rows[0]), characters: [] };
    const creatorId = String(profile.rows[0].id);
    const result = await client.query(
      `SELECT c.*,p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,
         (mine.character_id IS NOT NULL) liked_by_viewer
       FROM characters c JOIN profiles p ON p.id=c.user_id
       LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$1
       WHERE c.user_id=$2 AND c.visibility='public'
       ORDER BY c.published_at DESC NULLS LAST,c.like_count DESC`,
      [account.id,creatorId],
    );
    return { profile: profileFromRow(profile.rows[0]), characters: result.rows.map((row) => characterFromRow({ ...row,world_ids:[] },account.id)) };
  });
  if (!payload) return Response.json({ error: "Profile not found" }, { status: 404 });
  return Response.json(payload);
}

export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = profileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid profile" }, { status: 400 });
  const value = parsed.data;

  try {
    const row = await asUser(account.id, async (client) => {
      // The id predicate is redundant with the policy and kept deliberately:
      // the two layers fail independently.
      const result = await client.query(
        "UPDATE profiles SET username=$1,display_name=$2,bio=$3,avatar_path=$4,updated_at=now() WHERE id=$5 RETURNING *",
        [value.username || null, value.displayName, value.bio, value.avatarPath, account.id],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return Response.json({ error: "Profile not found" }, { status: 404 });
    return Response.json({ profile: profileFromRow(row) });
  } catch (error) {
    if (error instanceof Error && error.message.includes("profiles_username_key")) {
      return Response.json({ error: "That username is already taken" }, { status: 409 });
    }
    throw error;
  }
}
