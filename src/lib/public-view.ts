import { asVisitor } from "./db";
import { contentMode, isContentMode, shareMedia, shareMediaStatus, worldReadableWithoutAccount, type ShareMedia } from "./content-mode";
import { normalizeBlocks } from "./rich-content";
import type { RichBlock } from "./rich-content";
import type { ContentMode, CreationType } from "./types";

/**
 * What a person who has not signed in may be told.
 *
 * Every type in this file is a VIEW MODEL, not a trimmed entity. None of them
 * extends `Character`, `World` or `Profile`, and that is deliberate: a shared
 * base type is exactly how a hidden field eventually arrives on a public page,
 * because widening the base is easy and remembering every consumer of it is
 * not. These shapes have only what a public page renders, so adding a private
 * field to a creation cannot reach an anonymous reader by inheritance.
 *
 * The database half is the same argument made structurally — see
 * supabase/migrations/0036_public_content_modes.sql, where the functions these
 * fetchers call do not have prompt columns in their result types at all.
 */

/**
 * The narrowest public shape, and the only one an adult-focused creation has.
 *
 * A gate is read by people who do not yet know what they clicked, so it gets
 * the creation's identity, its creator, and the line its creator wrote FOR the
 * outside — never the tagline, which is written for somebody who has already
 * chosen the creation and is often the most explicit sentence on the page.
 */
export type PublicSafeLanding = {
  id: string;
  name: string;
  title: string;
  /** The creator's outward-facing line. Empty means the gate says something generic. */
  shareTagline: string;
  accent: string;
  contentMode: ContentMode;
  share: ShareMedia;
  creator: { username: string; displayName: string };
};

export type PublicCreationCard = {
  id: string;
  name: string;
  title: string;
  tagline: string;
  shareTagline: string;
  creationType: CreationType;
  profileType: "single" | "ensemble";
  accent: string;
  contentMode: ContentMode;
  /** Resolved by `shareMedia`; a fallback means "use the branded card". */
  share: ShareMedia;
  tags: string[];
  hashtags: string[];
  stats: { messages: number; chats: number; saves: number };
  creator: { username: string; displayName: string };
  publishedAt: string | null;
  updatedAt: string;
};

export type PublicCreationPage = PublicCreationCard & {
  userRole: string;
  overview: string;
  overviewRich: RichBlock[];
  quickFacts: { label: string; value: string }[];
  avatar: { path: string; url: string };
  cast: { key: string; name: string; role: string; blurb: string; avatarPath: string; avatarUrl: string }[];
  gallery: { id: string; storagePath: string; externalUrl: string; caption: string }[];
  creatorProfile: { username: string; displayName: string; avatarPath: string; border: string; followers: number };
  createdAt: string;
};

export type PublicWorldCard = {
  id: string;
  name: string;
  description: string;
  contentMode: ContentMode;
  share: ShareMedia;
  saveCount: number;
  creator: { username: string; displayName: string };
  updatedAt: string;
};

export type PublicCreatorProfile = {
  username: string;
  displayName: string;
  bio: string;
  avatarPath: string;
  coverPath: string;
  border: string;
  followers: number;
  following: number;
  publishedCreations: number;
  publishedWorlds: number;
  rank: number | null;
  creations: PublicCreationCard[];
};

function creationTypeOf(row: Record<string, unknown>): CreationType {
  const stored = String(row.creation_type || "");
  if (stored === "character" || stored === "cast" || stored === "scenario") return stored;
  return row.profile_type === "ensemble" ? "cast" : "character";
}

function isoOrNull(value: unknown) {
  return value ? new Date(String(value)).toISOString() : null;
}

function cardFromRow(row: Record<string, unknown>): PublicCreationCard {
  return {
    id: String(row.id),
    name: String(row.name || ""),
    title: String(row.title || ""),
    tagline: String(row.tagline || ""),
    shareTagline: String(row.share_tagline || ""),
    creationType: creationTypeOf(row),
    profileType: row.profile_type === "ensemble" ? "ensemble" : "single",
    accent: String(row.accent || "#e879a9"),
    contentMode: contentMode(row.content_mode),
    share: shareMedia({
      shareImagePath: String(row.share_image_path || ""),
      shareImageUrl: String(row.share_image_url || ""),
      status: shareMediaStatus(row.share_media_status),
      avatarPath: String(row.avatar_path || ""),
      avatarUrl: String(row.avatar_url || ""),
    }),
    tags: Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)) : [],
    hashtags: Array.isArray(row.hashtags) ? row.hashtags.map((tag) => String(tag)) : [],
    stats: {
      messages: Number(row.message_count || 0),
      chats: Number(row.chat_count || 0),
      saves: Number(row.like_count || 0),
    },
    creator: { username: String(row.creator_username || ""), displayName: String(row.creator_display_name || "") },
    publishedAt: isoOrNull(row.published_at),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/**
 * The safe landing for any public creation, whatever its mode.
 *
 * What a gate page and an external link preview are built from, and the only
 * thing either of them may read for an adult-focused creation. Null means the
 * creation is private, unlisted, removed, or does not exist; the caller cannot
 * tell which, and should not.
 */
export async function publicSafeLanding(id: string): Promise<PublicSafeLanding | null> {
  const rows = await asVisitor((client) => client.query("SELECT * FROM public_creation_safe_landing($1)", [id]));
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name || ""),
    title: String(row.title || ""),
    shareTagline: String(row.share_tagline || ""),
    accent: String(row.accent || "#e879a9"),
    contentMode: contentMode(row.content_mode),
    share: shareMedia({
      shareImagePath: String(row.share_image_path || ""),
      shareImageUrl: String(row.share_image_url || ""),
      status: shareMediaStatus(row.share_media_status),
      avatarPath: String(row.avatar_path || ""),
      avatarUrl: String(row.avatar_url || ""),
    }),
    creator: { username: String(row.creator_username || ""), displayName: String(row.creator_display_name || "") },
  };
}

/**
 * The listing card, which an adult-focused creation does not have.
 *
 * Returns null for one by construction — the SQL function carries the
 * predicate — so a caller that forgets the distinction gets nothing rather
 * than a tagline it should not have shown.
 */
export async function publicCreationCard(id: string): Promise<PublicCreationCard | null> {
  const rows = await asVisitor((client) => client.query("SELECT * FROM public_creation_card($1)", [id]));
  const row = rows.rows[0];
  return row ? cardFromRow(row) : null;
}

/**
 * The whole page, for the modes that may have one without an account.
 *
 * Returns null for an adult-focused creation by construction: the SQL function
 * behind it has that predicate, so this cannot be talked into returning a page
 * by a caller that forgot to check the mode. A caller wanting to render the
 * gate asks `publicCreationCard` instead.
 */
export async function publicCreationPage(id: string): Promise<PublicCreationPage | null> {
  return asVisitor(async (client) => {
    const detail = await client.query("SELECT * FROM public_creation_page($1)", [id]);
    const row = detail.rows[0];
    if (!row) return null;
    const [cast, gallery] = await Promise.all([
      client.query("SELECT * FROM public_creation_cast($1)", [id]),
      client.query("SELECT * FROM public_creation_gallery($1)", [id]),
    ]);
    return {
      ...cardFromRow(row),
      userRole: String(row.user_role || ""),
      overview: String(row.overview || ""),
      overviewRich: normalizeBlocks(row.description_rich),
      quickFacts: Array.isArray(row.quick_facts)
        ? (row.quick_facts as unknown[])
          .filter((fact): fact is Record<string, unknown> => Boolean(fact) && typeof fact === "object")
          .map((fact) => ({ label: String(fact.label ?? "").trim(), value: String(fact.value ?? "").trim() }))
          .filter((fact) => fact.label && fact.value)
          .slice(0, 6)
        : [],
      avatar: { path: String(row.avatar_path || ""), url: String(row.avatar_url || "") },
      cast: cast.rows.map(({ member }) => ({
        key: String(member?.key || member?.name || ""),
        name: String(member?.name || ""),
        role: String(member?.role || ""),
        blurb: String(member?.blurb || ""),
        avatarPath: String(member?.avatarPath || ""),
        avatarUrl: String(member?.avatarUrl || ""),
      })),
      gallery: gallery.rows.map((image) => ({
        id: String(image.id),
        storagePath: String(image.storage_path || ""),
        externalUrl: String(image.external_url || ""),
        caption: String(image.caption || ""),
      })),
      creatorProfile: {
        username: String(row.creator_username || ""),
        displayName: String(row.creator_display_name || ""),
        avatarPath: String(row.creator_avatar_path || ""),
        border: String(row.creator_border || "default"),
        followers: Number(row.creator_follower_count || 0),
      },
      createdAt: new Date(String(row.created_at)).toISOString(),
    };
  });
}

/**
 * A public world, as much of it as a stranger gets.
 *
 * Deliberately a card even for a clean world: the lore is the world, and
 * reading it is a signed-in act. What an anonymous visitor gets is enough to
 * know what they are being offered and to decide whether to sign in for it.
 */
export async function publicWorldCard(id: string): Promise<PublicWorldCard | null> {
  const rows = await asVisitor((client) => client.query("SELECT * FROM public_world_card($1)", [id]));
  const row = rows.rows[0];
  if (!row) return null;
  // The function already refuses an unclassified or adult-focused world; this
  // is the same rule stated on the reading side, so a change to either is a
  // disagreement that shows up rather than an exposure that does not.
  const mode = isContentMode(row.content_mode) ? row.content_mode : null;
  if (!worldReadableWithoutAccount(mode)) return null;
  return {
    id: String(row.id),
    name: String(row.name || ""),
    description: String(row.description || ""),
    contentMode: mode,
    share: shareMedia({
      status: shareMediaStatus(row.share_media_status),
      avatarPath: String(row.cover_path || ""),
      avatarUrl: String(row.cover_url || ""),
    }),
    saveCount: Number(row.save_count || 0),
    creator: { username: String(row.creator_username || ""), displayName: String(row.creator_display_name || "") },
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/**
 * A creator and their published shelf.
 *
 * Adult-focused creations appear here as cards — a creator's body of work is
 * not misrepresented by hiding part of it — and each card links to its own
 * gate rather than to a page an anonymous visitor may not read.
 */
export async function publicCreatorProfile(username: string, limit = 24): Promise<PublicCreatorProfile | null> {
  return asVisitor(async (client) => {
    const profile = await client.query("SELECT * FROM public_creator_profile($1)", [username]);
    const row = profile.rows[0];
    if (!row) return null;
    const creations = await client.query("SELECT * FROM public_creator_creations($1,$2,$3)", [username, limit, 0]);
    return {
      username: String(row.username),
      displayName: String(row.display_name || ""),
      bio: String(row.bio || ""),
      avatarPath: String(row.avatar_path || ""),
      coverPath: String(row.cover_path || ""),
      border: String(row.profile_border || "default"),
      followers: Number(row.follower_count || 0),
      following: Number(row.following_count || 0),
      publishedCreations: Number(row.published_creations || 0),
      publishedWorlds: Number(row.published_worlds || 0),
      rank: row.rank == null ? null : Number(row.rank),
      // These rows carry no `updated_at`; a card only ever shows publication.
      creations: creations.rows.map((creation) => cardFromRow({ ...creation, updated_at: creation.published_at ?? new Date(0).toISOString() })),
    };
  });
}

export type SitemapEntry = { kind: "creation" | "world" | "creator"; slug: string; updatedAt: string };

/** Everything a sitemap may list. Adult-focused pages are excluded in SQL. */
export async function publicSitemapEntries(limit = 5000): Promise<SitemapEntry[]> {
  const rows = await asVisitor((client) => client.query("SELECT * FROM public_sitemap_entries($1)", [limit]));
  return rows.rows
    .filter((row) => row.kind === "creation" || row.kind === "world" || row.kind === "creator")
    .map((row) => ({
      kind: row.kind as SitemapEntry["kind"],
      slug: String(row.slug),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    }));
}
