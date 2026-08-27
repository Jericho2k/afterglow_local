import type { PoolClient } from "pg";
import { creationSummaryFromRow, profileFromRow, worldSummaryFromRow } from "./db";
import { creatorStandingFor } from "./creator-stats";
import { effectiveBorder } from "./cosmetics";
import { featuredAchievements, type AchievementState } from "./achievements";
import type { CreationSummary, WorldSummary } from "./types";

/**
 * Everything a creator profile shows, read once.
 *
 * The performance rule the sprint set is the shape of this file: no query per
 * creation, no query per achievement, no count of the messages table per card,
 * and nothing hidden fetched at all. Concretely, a profile page is
 *
 *   one row for the profile, one for the standing, one page of creation cards,
 *   one page of world cards, one list of top characters, one activity read
 *
 * and the independent ones are issued together. The creation and world lists
 * are the same lean projections discovery and the Worlds hub already use, so a
 * profile can never become the surface that ships greetings, response
 * directives, cast definitions or a hundred thousand characters of world lore
 * to a browser that draws none of it.
 */

/** The lean columns a creation card needs. Nothing hidden is selectable here. */
const creationColumns = `c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.tagline,c.avatar_url,c.avatar_path,c.accent,
  c.tags,c.hashtags,c.nsfw_enabled,c.user_message_count,c.message_count,c.chat_count,c.like_count,c.published_at,c.created_at,
  p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,
  (mine.character_id IS NOT NULL) saved_by_viewer`;

export type CreatorCreationSort = "popular" | "newest";
export type CreatorCreationFilter = "all" | "character" | "cast" | "scenario";

const creationsPerPage = 24;

/**
 * A creator's published creations.
 *
 * "Popular" orders by the metric the profile's own headline number uses — user
 * messages received — so the grid, the Top Characters panel and the stat row
 * cannot disagree about which creation is doing best. Ties fall back to the
 * publication date and then the id, so a page boundary is stable rather than
 * arbitrary.
 */
export async function creatorCreations(
  client: PoolClient,
  input: { creatorId: string; viewerId: string; sort: CreatorCreationSort; filter: CreatorCreationFilter; offset?: number },
): Promise<CreationSummary[]> {
  const order = input.sort === "newest"
    ? "c.published_at DESC NULLS LAST, c.created_at DESC, c.id DESC"
    : "c.user_message_count DESC, c.like_count DESC, c.published_at DESC NULLS LAST, c.id DESC";
  const filtered = input.filter === "all" ? "" : " AND c.creation_type=$4";
  const values: unknown[] = [input.viewerId, input.creatorId, Math.max(0, input.offset ?? 0)];
  if (input.filter !== "all") values.push(input.filter);

  const result = await client.query(
    `SELECT ${creationColumns}
     FROM characters c
     JOIN profiles p ON p.id=c.user_id
     LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$1
     WHERE c.user_id=$2 AND c.visibility='public'${filtered}
     ORDER BY ${order}
     LIMIT ${creationsPerPage} OFFSET $3`,
    values,
  );
  return result.rows.map((row) => creationSummaryFromRow(row, input.viewerId));
}

/**
 * The creator's most-read characters.
 *
 * One query, ordered by the same real metric, capped at three. Public only:
 * an unlisted or private creation is not part of what a creator has published
 * and must never appear on a page anybody can open.
 */
export async function creatorTopCharacters(client: PoolClient, creatorId: string, viewerId: string, limit = 3) {
  const result = await client.query(
    `SELECT c.id,c.name,c.title,c.creation_type,c.profile_type,c.avatar_url,c.avatar_path,c.accent,c.user_message_count
     FROM characters c
     WHERE c.user_id=$1 AND c.visibility='public'
     ORDER BY c.user_message_count DESC, c.like_count DESC, c.id DESC
     LIMIT $2`,
    [creatorId, Math.max(1, Math.min(10, limit))],
  );
  void viewerId;
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name || ""),
    title: String(row.title || ""),
    creationType: String(row.creation_type || "character") as CreationSummary["creationType"],
    profileType: (row.profile_type === "ensemble" ? "ensemble" : "single") as CreationSummary["profileType"],
    avatarUrl: String(row.avatar_url || ""),
    avatarPath: String(row.avatar_path || ""),
    accent: String(row.accent || "#e879a9"),
    messages: Number(row.user_message_count || 0),
  }));
}

/** A creator's published worlds, as cards. Lore is never selected. */
export async function creatorWorlds(client: PoolClient, creatorId: string, viewerId: string): Promise<WorldSummary[]> {
  const result = await client.query(
    `SELECT w.id,w.user_id,w.name,w.description,w.cover_path,w.cover_url,w.visibility,w.save_count,w.created_at,w.updated_at,
       (mine.world_id IS NOT NULL) saved_by_viewer,
       p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,
       COALESCE(uses.count,0) creation_count
     FROM worlds w
     LEFT JOIN world_saves mine ON mine.world_id=w.id AND mine.user_id=$1
     LEFT JOIN profiles p ON p.id=w.user_id
     LEFT JOIN (
       SELECT cw.world_id, count(*) count FROM character_worlds cw
       JOIN characters c ON c.id=cw.character_id AND c.visibility='public'
       GROUP BY cw.world_id
     ) uses ON uses.world_id=w.id
     WHERE w.user_id=$2 AND w.visibility='public'
     ORDER BY w.save_count DESC, w.updated_at DESC, w.id DESC
     LIMIT 40`,
    [viewerId, creatorId],
  );
  return result.rows.map((row) => worldSummaryFromRow(row, viewerId));
}

export type CreatorActivityEvent = {
  id: string;
  kind: "creation_published" | "creation_updated" | "world_published" | "world_updated" | "achievement" | "milestone" | "rank";
  title: string;
  /** The creation, world or achievement this is about. May be empty. */
  subject: string;
  /** Artwork for the thing, where there is any. */
  avatarPath: string;
  avatarUrl: string;
  /** Where the subject lives, for the ones that have a page. */
  href: string;
  occurredAt: string;
};

/**
 * A creator's public history.
 *
 * Two sources, deliberately:
 *
 *   DERIVED. Publishing and updating already have exact timestamps on the rows
 *   themselves, so those events are read from `published_at` and `updated_at`
 *   rather than logged. That is what gives every existing profile a real
 *   history on the day this ships instead of an empty feed — and it is the only
 *   way to have one without inventing dates.
 *
 *   LOGGED. Achievements and milestones have no timestamp of their own, so
 *   they are recorded when first observed. Anything recorded with the epoch is
 *   a threshold that was already true before the system looked, and it is
 *   excluded here: "we do not know when this happened" is not a feed entry.
 *
 * Nothing private is reachable. Only public creations and public worlds are
 * selected, no chat, reader, memory or moderation data is touched, and the
 * whole thing is one union rather than a query per event.
 */
export async function creatorActivity(client: PoolClient, creatorId: string, limit = 8): Promise<CreatorActivityEvent[]> {
  const bounded = Math.max(1, Math.min(50, limit));
  // `updated_at` alone rather than the greatest of it and the publish date:
  // a row is touched whenever it changes, so `updated_at` is already the later
  // of the two, and the simpler expression is one an index can serve.
  const [creations, worlds, logged] = await Promise.all([
    client.query(
      `SELECT id,name,title,avatar_path,avatar_url,published_at,updated_at
       FROM characters WHERE user_id=$1 AND visibility='public'
       ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [creatorId, bounded],
    ),
    client.query(
      `SELECT id,name,cover_path,cover_url,created_at,updated_at
       FROM worlds WHERE user_id=$1 AND visibility='public'
       ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [creatorId, bounded],
    ),
    client.query(
      `SELECT id,kind,title,subject,occurred_at FROM profile_activity
       WHERE user_id=$1 AND occurred_at > '1970-01-02T00:00:00Z'
       ORDER BY occurred_at DESC LIMIT $2`,
      [creatorId, bounded],
    ),
  ]);

  const events: CreatorActivityEvent[] = [];
  for (const row of creations.rows) {
    const name = String(row.title || row.name || "Untitled");
    const published = row.published_at ? new Date(String(row.published_at)) : null;
    const updated = new Date(String(row.updated_at));
    // An update within a minute of publishing is the publish, not a revision.
    const revised = published && updated.getTime() - published.getTime() > 60_000;
    events.push({
      id: `creation:${row.id}:${revised ? "updated" : "published"}`,
      kind: revised ? "creation_updated" : "creation_published",
      title: revised ? "Updated creation" : "New creation",
      subject: name,
      avatarPath: String(row.avatar_path || ""),
      avatarUrl: String(row.avatar_url || ""),
      href: `/characters/${row.id}`,
      occurredAt: (revised ? updated : published ?? updated).toISOString(),
    });
  }
  for (const row of worlds.rows) {
    const created = new Date(String(row.created_at));
    const updated = new Date(String(row.updated_at));
    const revised = updated.getTime() - created.getTime() > 60_000;
    events.push({
      id: `world:${row.id}:${revised ? "updated" : "published"}`,
      kind: revised ? "world_updated" : "world_published",
      title: revised ? "Updated world" : "New world",
      subject: String(row.name || "Untitled world"),
      avatarPath: String(row.cover_path || ""),
      avatarUrl: String(row.cover_url || ""),
      href: `/worlds/${row.id}`,
      occurredAt: (revised ? updated : created).toISOString(),
    });
  }
  for (const row of logged.rows) {
    const kind = String(row.kind);
    events.push({
      id: `activity:${row.id}`,
      kind: (kind === "achievement" ? "achievement" : kind === "rank" ? "rank" : "milestone"),
      title: String(row.title || ""),
      subject: String(row.subject || ""),
      avatarPath: "", avatarUrl: "", href: "",
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
    });
  }

  return events
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, bounded);
}

export type CreatorProfilePayload = {
  profile: ReturnType<typeof profileFromRow> & { coverPath: string; profileBorder: string };
  owner: boolean;
  viewerFollows: boolean;
  stats: { followers: number; following: number; messages: number; creations: number; worlds: number; saves: number };
  rank: { position: number | null; total: number; percentile: number | null };
  border: ReturnType<typeof effectiveBorder>;
  unlockedBorders: string[];
  achievements: AchievementState[];
  featured: AchievementState[];
  creations: CreationSummary[];
  worlds: WorldSummary[];
  topCharacters: Awaited<ReturnType<typeof creatorTopCharacters>>;
  activity: CreatorActivityEvent[];
};

/**
 * The whole profile.
 *
 * Sequenced only where one read genuinely depends on another: the standing has
 * to be known before achievements and borders can be evaluated against it.
 * Everything after that is independent and goes out together.
 */
export async function creatorProfilePayload(
  client: PoolClient,
  input: { row: Record<string, unknown>; viewerId: string; sort: CreatorCreationSort; filter: CreatorCreationFilter },
): Promise<CreatorProfilePayload> {
  const creatorId = String(input.row.id);
  const owner = creatorId === input.viewerId;
  const standing = await creatorStandingFor(client, creatorId, input.viewerId);

  const [creations, worlds, topCharacters, activity, follows] = await Promise.all([
    creatorCreations(client, { creatorId, viewerId: input.viewerId, sort: input.sort, filter: input.filter }),
    creatorWorlds(client, creatorId, input.viewerId),
    creatorTopCharacters(client, creatorId, input.viewerId),
    creatorActivity(client, creatorId),
    owner
      ? Promise.resolve({ rowCount: 0 })
      : client.query("SELECT 1 FROM profile_follows WHERE follower_user_id=$1 AND creator_user_id=$2", [input.viewerId, creatorId]),
  ]);

  const chosen = Array.isArray(input.row.featured_achievements)
    ? (input.row.featured_achievements as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  return {
    profile: {
      ...profileFromRow(input.row),
      coverPath: String(input.row.cover_path || ""),
      profileBorder: String(input.row.profile_border || "default"),
    },
    owner,
    viewerFollows: Boolean(follows.rowCount),
    stats: {
      followers: standing.standing.followers,
      following: Number(input.row.following_count || 0),
      messages: standing.standing.userMessages,
      creations: standing.standing.publishedCreations,
      worlds: standing.standing.publishedWorlds,
      saves: standing.standing.saves,
    },
    rank: { position: standing.standing.rank, total: standing.standing.rankTotal, percentile: standing.percentile },
    border: effectiveBorder(String(input.row.profile_border || "default"), standing.metrics, standing.standing.rankTotal),
    unlockedBorders: standing.unlockedBorders,
    achievements: standing.achievements,
    featured: featuredAchievements(standing.achievements, chosen),
    creations,
    worlds,
    topCharacters,
    activity,
  };
}
