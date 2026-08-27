import { asUser, creationSummaryFromRow, profileFromRow } from "@/lib/db";
import { creatorStanding, creatorStandingFor, refreshCreatorStatsIfStale, syncOwnCreatorStanding } from "@/lib/creator-stats";
import { isProfileBorderId, unlockedBorders } from "@/lib/cosmetics";
import { profileSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * The caller's own profile, and the legacy username lookup.
 *
 * `?username=` predates the creator profile and is kept working, but the page
 * that used to be built from it now lives at `/api/creators/{username}` —
 * everything a creator profile shows comes back in one payload there, and
 * splitting it across two endpoints would mean two round trips to draw one
 * page. This route stays the OWNER's endpoint: read your own profile, write
 * your own profile.
 */
export async function GET(request?: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const username = request ? new URL(request.url).searchParams.get("username")?.trim().toLowerCase() : "";
  if (!username) {
    // Own profile: refresh and record in their own transactions first, for the
    // reason spelled out in `refreshCreatorStatsIfStale`.
    await refreshCreatorStatsIfStale(account.id);
    await syncOwnCreatorStanding(account.id, await asUser(account.id, (client) => creatorStanding(client, account.id)));
  }
  const payload = await asUser(account.id, async (client) => {
    const profile = username
      ? await client.query("SELECT * FROM profiles WHERE username=$1", [username])
      : await client.query("SELECT * FROM profiles WHERE id=$1", [account.id]);
    if (!profile.rowCount) return null;
    const row = profile.rows[0];

    if (!username) {
      /*
       * The owner's own view.
       *
       * The standing is read here as well as on the public page because this
       * is the surface a creator uses to CHANGE their profile, and it cannot
       * offer a border or a featured achievement without knowing which of them
       * are genuinely unlocked. It is also where a creator's own achievements
       * and milestones get recorded — by `syncOwnCreatorStanding` above,
       * outside this transaction.
       */
      const standing = await creatorStandingFor(client, account.id);
      return {
        profile: publicProfile(row),
        creations: [],
        stats: {
          followers: standing.standing.followers,
          following: Number(row.following_count || 0),
          messages: standing.standing.userMessages,
          creations: standing.standing.publishedCreations,
          worlds: standing.standing.publishedWorlds,
        },
        rank: { position: standing.standing.rank, total: standing.standing.rankTotal, percentile: standing.percentile },
        achievements: standing.achievements,
        unlockedBorders: standing.unlockedBorders,
      };
    }

    const creatorId = String(row.id);
    /*
     * What a creator has published, as cards.
     *
     * This used to be `SELECT c.*` mapped through `characterFromRow` with no
     * page limit and no visitor scrub — so asking for somebody's public
     * profile returned their greetings, personalities, backstories, response
     * directives, boundaries and cast definitions in full. That is the hidden
     * half of a creation, it is not what publishing shares, and a profile page
     * has never rendered any of it.
     *
     * The same lean summary discovery uses, capped at a page. Nothing hidden
     * is selected, so there is nothing here to blank out and nothing to leak
     * by forgetting to.
     */
    const result = await client.query(
      `SELECT c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.tagline,c.avatar_url,c.avatar_path,c.accent,
         c.tags,c.hashtags,c.nsfw_enabled,c.message_count,c.user_message_count,c.chat_count,c.like_count,c.published_at,c.created_at,
         p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,
         (mine.character_id IS NOT NULL) saved_by_viewer
       FROM characters c JOIN profiles p ON p.id=c.user_id
       LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$1
       WHERE c.user_id=$2 AND c.visibility='public'
       ORDER BY c.published_at DESC NULLS LAST,c.like_count DESC LIMIT 60`,
      [account.id, creatorId],
    );
    return { profile: publicProfile(row), creations: result.rows.map((row) => creationSummaryFromRow(row, account.id)) };
  });
  if (!payload) return Response.json({ error: "Profile not found" }, { status: 404 });
  return Response.json(payload);
}

/** The profile fields that leave the server, cosmetics included. */
function publicProfile(row: Record<string, unknown>) {
  return {
    ...profileFromRow(row),
    coverPath: String(row.cover_path || ""),
    profileBorder: String(row.profile_border || "default"),
    featuredAchievements: Array.isArray(row.featured_achievements)
      ? (row.featured_achievements as unknown[]).filter((value): value is string => typeof value === "string")
      : [],
    followerCount: Number(row.follower_count || 0),
    followingCount: Number(row.following_count || 0),
  };
}

export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = profileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid profile" }, { status: 400 });
  const value = parsed.data;

  try {
    const row = await asUser(account.id, async (client) => {
      /*
       * Cosmetics are decided by the server, from real metrics.
       *
       * A schema can check that "luminary" is a plausible border id; only this
       * can check whether this account is among the ten most-read creators. A
       * request naming a border or an achievement it has not earned is not an
       * error — the client may simply be stale — so the unearned choice is
       * dropped and the rest of the save proceeds.
       */
      const standing = await creatorStandingFor(client, account.id);
      const allowedBorders = unlockedBorders(standing.metrics, standing.standing.rankTotal);
      const border = isProfileBorderId(value.profileBorder) && allowedBorders.includes(value.profileBorder)
        ? value.profileBorder
        : "default";
      const unlocked = new Set(standing.achievements.filter((state) => state.unlocked).map((state) => state.id));
      const featured = value.featuredAchievements.filter((id) => unlocked.has(id)).slice(0, 3);

      // The id predicate is redundant with the policy and kept deliberately:
      // the two layers fail independently.
      const result = await client.query(
        `UPDATE profiles SET username=$1,display_name=$2,bio=$3,avatar_path=$4,
           cover_path=$6,profile_border=$7,featured_achievements=$8::text[],updated_at=now()
         WHERE id=$5 RETURNING *`,
        [value.username || null, value.displayName, value.bio, value.avatarPath, account.id, value.coverPath, border, featured],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return Response.json({ error: "Profile not found" }, { status: 404 });
    return Response.json({ profile: publicProfile(row) });
  } catch (error) {
    if (error instanceof Error && error.message.includes("profiles_username_key")) {
      return Response.json({ error: "That username is already taken" }, { status: 409 });
    }
    throw error;
  }
}
