import { asUser, profileFromRow } from "@/lib/db";
import { profileSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const profile = await asUser(account.id, (client) => client.query("SELECT * FROM profiles WHERE id=$1", [account.id]));
  if (!profile.rowCount) return Response.json({ error: "Profile not found" }, { status: 404 });
  return Response.json({ profile: profileFromRow(profile.rows[0]) });
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
