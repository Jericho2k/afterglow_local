import { asUser } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Following a creator.
 *
 * Two operations and one relation. The interesting decisions are all refusals,
 * and each of them is enforced in the database as well as here, so a mistake in
 * this file cannot become a data problem:
 *
 *   FOLLOWING YOURSELF is refused by a CHECK constraint.
 *   FOLLOWING AS SOMEBODY ELSE is refused by the insert policy.
 *   FOLLOWING A PRIVATE ACCOUNT is refused by the same policy, which requires
 *   the target to have chosen a public username.
 *   FOLLOWING TWICE is the primary key, so a double tap is idempotent rather
 *   than an error the client has to interpret.
 *
 * The response carries the authoritative follower count, so an optimistic
 * button settles on the real number instead of trusting its own arithmetic —
 * the same contract `/api/saves` already uses.
 */

async function followerCount(client: Parameters<Parameters<typeof asUser>[1]>[0], creatorId: string) {
  const result = await client.query("SELECT follower_count FROM profiles WHERE id=$1", [creatorId]);
  return result.rowCount ? Number(result.rows[0].follower_count || 0) : null;
}

/** Resolves a username to the account behind it, or null when it is not public. */
async function creatorByUsername(client: Parameters<Parameters<typeof asUser>[1]>[0], username: string) {
  const result = await client.query("SELECT id FROM profiles WHERE username=$1", [username]);
  return result.rowCount ? String(result.rows[0].id) : null;
}

function handleFrom(value: unknown) {
  const handle = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,29}$/.test(handle) ? handle : "";
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`follow:${account.id}`, 120, 60_000); if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const handle = handleFrom(body.username);
  if (!handle) return Response.json({ error: "Creator not found" }, { status: 404 });

  const result = await asUser(account.id, async (client) => {
    const creatorId = await creatorByUsername(client, handle);
    if (!creatorId) return { error: "Creator not found" as const, status: 404 as const };
    if (creatorId === account.id) return { error: "You cannot follow yourself" as const, status: 400 as const };
    await client.query(
      "INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [account.id, creatorId],
    );
    return { following: true, followers: await followerCount(client, creatorId) };
  });

  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}

export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`follow:${account.id}`, 120, 60_000); if (limited) return limited;
  const handle = handleFrom(new URL(request.url).searchParams.get("username"));
  if (!handle) return Response.json({ error: "Creator not found" }, { status: 404 });

  const result = await asUser(account.id, async (client) => {
    const creatorId = await creatorByUsername(client, handle);
    if (!creatorId) return { error: "Creator not found" as const, status: 404 as const };
    await client.query(
      "DELETE FROM profile_follows WHERE follower_user_id=$1 AND creator_user_id=$2",
      [account.id, creatorId],
    );
    return { following: false, followers: await followerCount(client, creatorId) };
  });

  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
