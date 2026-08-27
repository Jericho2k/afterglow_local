import { asUser } from "@/lib/db";
import { creatorProfilePayload, type CreatorCreationFilter, type CreatorCreationSort } from "@/lib/creator-profile";
import { creatorStanding, refreshCreatorStatsIfStale, syncOwnCreatorStanding } from "@/lib/creator-stats";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * A public creator profile.
 *
 * Addressed by username rather than by id, because a username is the creator's
 * explicit opt-in to being public — `profiles_select_own_or_public` will not
 * return a profile without one, so an account that never chose a username has
 * no addressable profile at all rather than one that happens to be empty.
 *
 * Everything the page draws comes back in one response. That is a deliberate
 * choice against the alternative, which is a page that renders and then makes
 * six more requests to fill itself in: the reads are independent, they are
 * issued together inside one transaction, and the payload carries only lean
 * card projections. See src/lib/creator-profile.ts for what is and is not
 * selected.
 */

const sorts: CreatorCreationSort[] = ["popular", "newest"];
const filters: CreatorCreationFilter[] = ["all", "character", "cast", "scenario"];

export async function GET(request: Request, context: { params: Promise<{ username: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { username } = await context.params;
  const handle = decodeURIComponent(username || "").trim().toLowerCase();
  // The same shape the profile constraint enforces, checked before a lookup so
  // a malformed handle costs nothing.
  if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(handle)) {
    return Response.json({ error: "Creator not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const sort = sorts.find((value) => value === url.searchParams.get("sort")) ?? "popular";
  const filter = filters.find((value) => value === url.searchParams.get("filter")) ?? "all";

  /*
   * The standings are refreshed BEFORE the page's transaction opens, in one of
   * their own.
   *
   * PostgreSQL aborts a transaction after any failed statement, so a ranking
   * rebuild that fails inside the page's transaction would take the page with
   * it — on a deployment that has not applied 0021 yet, every profile would
   * 500 rather than showing a stale rank. Isolating it is what makes "never
   * throws" true rather than merely intended.
   */
  await refreshCreatorStatsIfStale(account.id);

  const payload = await asUser(account.id, async (client) => {
    const profile = await client.query("SELECT * FROM profiles WHERE username=$1", [handle]);
    if (!profile.rowCount) return null;
    return creatorProfilePayload(client, { row: profile.rows[0], viewerId: account.id, sort, filter });
  });

  // Recording a creator's own newly-observed achievements is a write, and it
  // happens after the page has been read rather than in the middle of reading
  // it. A badge that arrives one page view late is not a defect; a profile that
  // fails because a badge could not be written would be.
  if (payload?.owner) {
    await syncOwnCreatorStanding(account.id, await asUser(account.id, (client) => creatorStanding(client, account.id)));
  }

  if (!payload) return Response.json({ error: "Creator not found" }, { status: 404 });
  return Response.json(payload);
}
