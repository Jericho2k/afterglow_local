import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asUser } from "./db";
import { achievementStates, achievements, rankPercentile, type CreatorMetrics } from "./achievements";
import { unlockedBorders } from "./cosmetics";

/**
 * A creator's standing, and how it stays true without being expensive.
 *
 * Rank is a global ordering, so the honest answer to "what is this creator's
 * rank" involves every creator on the platform. Computing that on each profile
 * view is exactly the kind of thing the previous sprint spent its time
 * removing, so `creator_stats` holds one precomputed row per creator and this
 * module decides when it is stale enough to rebuild.
 *
 * The refresh is guarded by a single atomic UPDATE against a one-row table.
 * Whichever request wins that UPDATE does the work; every other concurrent
 * reader gets `fresh` and serves the numbers that are already there. That is
 * what keeps a burst of traffic from running the same aggregate twenty times,
 * and it needs no lock, no queue and no background worker.
 */

/**
 * How stale the standings may be.
 *
 * Ten minutes, because rank moves slowly and a profile is not a scoreboard: a
 * creator's position among thousands does not meaningfully change between one
 * page view and the next, and pretending otherwise would mean recomputing the
 * whole platform's ordering to show the same number again.
 */
const maxAgeMs = Number(process.env.CREATOR_STATS_MAX_AGE_MS || 10 * 60_000);

export type CreatorStandingRow = {
  publishedCreations: number;
  publishedWorlds: number;
  userMessages: number;
  saves: number;
  followers: number;
  rank: number | null;
  rankTotal: number;
  computedAt: string;
};

/** The zero standing: a real creator who has published nothing yet. */
export const unrankedStanding: CreatorStandingRow = {
  publishedCreations: 0, publishedWorlds: 0, userMessages: 0, saves: 0, followers: 0,
  rank: null, rankTotal: 0, computedAt: new Date(0).toISOString(),
};

/**
 * Rebuilds the standings when they have gone stale, at most once per window.
 *
 * Runs in a TRANSACTION OF ITS OWN, and that isolation is the point rather than
 * a detail. PostgreSQL aborts a transaction after any failed statement, so a
 * deployment that has not applied 0021 yet — where `refresh_creator_stats` does
 * not exist — would have this failure take the rest of the request down with
 * it, and a `try`/`catch` around the statement would not save the page it was
 * written to save. The same reasoning as the locked-world probe in the creation
 * route: a call that might not resolve does not belong inside somebody else's
 * transaction.
 *
 * Never throws either way. A profile that cannot refresh a ranking shows a
 * slightly stale rank, which is a far better product than one that fails.
 *
 * Returns a status so Rankings can distinguish a legitimate empty board from
 * a board that could not be built. Profile callers still serve stale values.
 */
export type RefreshStatus = "refreshed" | "fresh" | "failed";

export async function refreshCreatorStatsIfStale(userId: string, now = Date.now()): Promise<RefreshStatus> {
  try {
    return await asUser(userId, async (client) => {
      // Whoever wins this single atomic UPDATE does the work; every other
      // concurrent reader gets false and serves what is already there. No lock,
      // no queue, no background worker.
      const claimed = await client.query(
        "UPDATE creator_stats_refresh SET refreshed_at=now() WHERE id=true AND refreshed_at < $1 RETURNING refreshed_at",
        [new Date(now - maxAgeMs).toISOString()],
      );
      if (!claimed.rowCount) return "fresh";
      await client.query("SELECT public.refresh_creator_stats()");
      return "refreshed";
    });
  } catch {
    return "failed";
  }
}

/** One creator's precomputed standing, or the zero standing when unranked. */
export async function creatorStanding(client: PoolClient, userId: string): Promise<CreatorStandingRow> {
  // Deliberately just the row. `rank_total` is already on it, so the size of
  // the field needs no second read here — only the unranked branch below has
  // to go looking for it.
  const result = await client.query("SELECT * FROM creator_stats WHERE user_id=$1", [userId]);
  const row = result.rows[0];
  if (!row) {
    // Not ranked is not an error. A creator with nothing published still has
    // followers and a profile, so the live figures are read directly.
    const [profile, creations, worlds, field] = await Promise.all([
      client.query("SELECT follower_count FROM profiles WHERE id=$1", [userId]),
      client.query("SELECT count(*)::int count FROM characters WHERE user_id=$1 AND visibility='public'", [userId]),
      client.query("SELECT count(*)::int count FROM worlds WHERE user_id=$1 AND visibility='public'", [userId]),
      client.query("SELECT COALESCE(max(rank_total),0)::int total FROM creator_stats"),
    ]);
    return {
      ...unrankedStanding,
      followers: Number(profile.rows[0]?.follower_count || 0),
      publishedCreations: Number(creations.rows[0]?.count || 0),
      publishedWorlds: Number(worlds.rows[0]?.count || 0),
      // The size of the field, so an unranked creator's page can still say how
      // many creators there are without claiming a position among them.
      rankTotal: Number(field.rows[0]?.total || 0),
    };
  }
  return {
    publishedCreations: Number(row.published_creations || 0),
    publishedWorlds: Number(row.published_worlds || 0),
    userMessages: Number(row.user_messages || 0),
    saves: Number(row.saves || 0),
    followers: Number(row.followers || 0),
    rank: row.rank == null ? null : Number(row.rank),
    rankTotal: Number(row.rank_total || 0),
    computedAt: new Date(String(row.computed_at)).toISOString(),
  };
}

export function metricsFromStanding(standing: CreatorStandingRow): CreatorMetrics {
  return {
    followers: standing.followers,
    messages: standing.userMessages,
    publishedCreations: standing.publishedCreations,
    publishedWorlds: standing.publishedWorlds,
    rank: standing.rank,
  };
}

/**
 * Records achievements this creator has newly been observed to hold.
 *
 * Called only for the creator's OWN session, which is what makes it safe: the
 * row level security policy permits an account to write only its own
 * achievements, so there is no path by which one account grants another one
 * anything. The cost of that decision is that a threshold crossed while the
 * creator is away is stamped the next time they look, which is honest — it is
 * the first moment the system could observe it — and it is why the timestamp is
 * called "first observed" rather than "earned".
 *
 * A newly recorded achievement also becomes an activity event, because that IS
 * the moment it happened as far as anything can tell. Achievements the creator
 * already held when this shipped are recorded silently, without an event, so
 * nobody's feed claims they reached a million messages this afternoon.
 */
export async function syncCreatorAchievements(
  client: PoolClient,
  userId: string,
  standing: CreatorStandingRow,
  options: { announce: boolean },
) {
  const metrics = metricsFromStanding(standing);
  const existing = await client.query("SELECT achievement_id,unlocked_at FROM profile_achievements WHERE user_id=$1", [userId]);
  const known = new Set(existing.rows.map((row) => String(row.achievement_id)));
  const states = achievementStates(metrics, standing.rankTotal);
  const newlyUnlocked = states.filter((state) => state.unlocked && !known.has(state.id));
  if (!newlyUnlocked.length) return [];

  for (const state of newlyUnlocked) {
    await client.query(
      "INSERT INTO profile_achievements (user_id,achievement_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [userId, state.id],
    );
    if (!options.announce) continue;
    await client.query(
      `INSERT INTO profile_activity (id,user_id,kind,key,title,subject)
       VALUES ($1,$2,'achievement',$3,$4,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(), userId, `achievement:${state.id}`, "Achievement unlocked", state.title],
    );
  }
  return newlyUnlocked.map((state) => state.id);
}

/**
 * Milestone thresholds worth putting in a feed.
 *
 * Deliberately fewer than the achievements. An achievement is a permanent badge
 * and can afford to mark every step; a milestone interrupts a reader's view of
 * what a creator has been making, so it earns its place only at the numbers a
 * person would actually mention.
 */
const followerMilestones = [100, 1_000, 10_000, 100_000, 1_000_000];
const messageMilestones = [10_000, 100_000, 1_000_000, 10_000_000];
const creationMilestones = [10, 25, 50, 100];

function crossed(thresholds: number[], value: number) {
  return thresholds.filter((threshold) => value >= threshold);
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/**
 * Logs milestones this creator has reached and not yet been credited with.
 *
 * `key` carries the threshold, and the unique index on it is what makes the
 * same milestone impossible to fire twice: a creator who crosses a thousand
 * followers, loses one and crosses it again has reached a thousand followers
 * once. Same self-only rule as achievements, for the same reason.
 *
 * `announce` is false on the first sync for an account, which is what stops a
 * profile that has existed for a year from suddenly reporting that it reached
 * every one of its milestones this afternoon.
 */
export async function syncCreatorMilestones(
  client: PoolClient,
  userId: string,
  standing: CreatorStandingRow,
  options: { announce: boolean },
) {
  const events: { key: string; title: string; subject: string }[] = [];
  for (const threshold of crossed(followerMilestones, standing.followers)) {
    events.push({ key: `followers:${threshold}`, title: "Milestone reached", subject: `${compact.format(threshold)} followers` });
  }
  for (const threshold of crossed(messageMilestones, standing.userMessages)) {
    events.push({ key: `messages:${threshold}`, title: "Milestone reached", subject: `${compact.format(threshold)} messages received` });
  }
  for (const threshold of crossed(creationMilestones, standing.publishedCreations)) {
    events.push({ key: `creations:${threshold}`, title: "Milestone reached", subject: `${threshold} creations published` });
  }
  if (standing.rank !== null && standing.rank <= 100) {
    events.push({ key: "rank:100", title: "Entered the Top 100", subject: "Top 100 creator" });
  }
  if (standing.rank !== null && standing.rank <= 10) {
    events.push({ key: "rank:10", title: "Entered the Top 10", subject: "Top 10 creator" });
  }
  if (!events.length) return [];

  const existing = await client.query("SELECT key FROM profile_activity WHERE user_id=$1 AND key<>''", [userId]);
  const known = new Set(existing.rows.map((row) => String(row.key)));
  const fresh = events.filter((event) => !known.has(event.key));
  for (const event of fresh) {
    /*
     * A milestone reached before anybody was watching is recorded so it cannot
     * fire later, and stamped with the epoch rather than with today. The feed
     * skips those, which is the difference between "we do not know when this
     * happened" and the outright lie of "this happened this afternoon". Every
     * milestone crossed from here on carries the real time it was observed.
     */
    await client.query(
      `INSERT INTO profile_activity (id,user_id,kind,key,title,subject,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        randomUUID(), userId, event.key.startsWith("rank:") ? "rank" : "milestone",
        event.key, event.title, event.subject,
        options.announce ? new Date().toISOString() : new Date(0).toISOString(),
      ],
    );
  }
  return fresh.map((event) => event.key);
}

/**
 * Whether this account has ever had its standing recorded.
 *
 * The question behind it is "is this the first time we have looked", and the
 * answer decides whether what we find is news or merely true. One statement
 * rather than two, because it is asked on every visit a creator makes to their
 * own profile.
 */
export async function creatorHasSyncedBefore(client: PoolClient, userId: string) {
  const seen = await client.query(
    `SELECT EXISTS (SELECT 1 FROM profile_achievements WHERE user_id=$1)
         OR EXISTS (SELECT 1 FROM profile_activity WHERE user_id=$1) AS seen`,
    [userId],
  );
  return Boolean(seen.rows[0]?.seen);
}

/**
 * Recording what a creator has newly been observed to hold.
 *
 * Its own transaction, for the same reason the refresh has one: this WRITES,
 * and a write that fails must cost the creator a delayed badge rather than
 * costing them their profile page. Called only for the creator's own session —
 * a visitor triggers nothing at all.
 *
 * The first sync for an account records what is already true WITHOUT
 * announcing it, which is what stops a profile that has existed for a year from
 * reporting that it reached every one of its milestones this afternoon.
 */
export async function syncOwnCreatorStanding(userId: string, standing: CreatorStandingRow) {
  try {
    await asUser(userId, async (client) => {
      const announce = await creatorHasSyncedBefore(client, userId);
      await syncCreatorAchievements(client, userId, standing, { announce });
      await syncCreatorMilestones(client, userId, standing, { announce });
    });
  } catch (error) {
    console.error("Creator achievements could not be recorded", error);
  }
}

/**
 * Everything a profile needs about standing, in one pass.
 *
 * Pure reads. The refresh and the sync both live outside this call and outside
 * the caller's transaction; see `refreshCreatorStatsIfStale` for why that
 * separation is load-bearing rather than tidy.
 */
export async function creatorStandingFor(client: PoolClient, creatorId: string) {
  const standing = await creatorStanding(client, creatorId);
  const unlockedAt = new Map<string, string>();
  const recorded = await client.query("SELECT achievement_id,unlocked_at FROM profile_achievements WHERE user_id=$1", [creatorId]);
  for (const row of recorded.rows) unlockedAt.set(String(row.achievement_id), new Date(String(row.unlocked_at)).toISOString());

  const metrics = metricsFromStanding(standing);
  return {
    standing,
    metrics,
    percentile: rankPercentile(standing.rank, standing.rankTotal),
    achievements: achievementStates(metrics, standing.rankTotal, unlockedAt),
    unlockedBorders: unlockedBorders(metrics, standing.rankTotal),
    /** Every definition, so a client never has to know the catalogue. */
    catalogueSize: achievements.length,
  };
}
