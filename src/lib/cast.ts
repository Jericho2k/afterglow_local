import type { CharacterCastMember } from "./types";

/**
 * Cast member identity.
 *
 * A cast member needs a stable address once it has a page of its own, and the
 * obvious candidate — its position in the array — is the wrong one: reordering
 * the cast in the studio would silently repoint every link that had been
 * shared, bookmarked or indexed.
 *
 * Members created from now on carry an `id`. Every member written before that
 * has none, and migrating them would mean rewriting a jsonb column on every
 * creation in the product for a field nothing yet uses. So a member's key is
 * its id when it has one and a slug of its name when it does not. Both are
 * stable across reordering, both are addressable immediately, and a member
 * gains a real id the next time its creation is saved.
 */

/** A URL-safe key from a display name. Latin-alphanumeric, dash-separated. */
export function slugifyName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * The key a member is addressed by.
 *
 * Empty when the member has neither an id nor a name that survives slugging —
 * a member with a name written entirely in a script the slug cannot represent.
 * Callers treat an empty key as "not addressable" and simply do not link it,
 * which is better than a page nobody can reach reporting a 404.
 */
export function castMemberKey(member: Pick<CharacterCastMember, "id" | "name">) {
  const id = member.id?.trim();
  if (id) return id;
  return slugifyName(member.name ?? "");
}

/**
 * Resolve a member from a URL segment.
 *
 * Matches an id first, so a member that has one is found by it even if another
 * member's name happens to slug to the same string. Name matching then keeps
 * links to pre-id members working. Ambiguity resolves to the first match,
 * which is the same member the page linked to.
 */
export function findCastMember(cast: CharacterCastMember[], key: string) {
  const needle = key.trim().toLowerCase();
  if (!needle) return null;
  const byId = cast.find((member) => member.id?.trim().toLowerCase() === needle);
  if (byId) return byId;
  return cast.find((member) => slugifyName(member.name ?? "") === needle) ?? null;
}

/** A fresh member identifier. Short, URL-safe and collision-free in practice. */
export function newCastMemberId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/**
 * Give every named member an id, without disturbing the ones that have one.
 *
 * Run when a creation is saved, so ids arrive with ordinary editing rather
 * than through a migration that rewrites every row in the product at once.
 * Members are matched by identity, so this never renames or reorders anything.
 */
export function withCastMemberIds(cast: CharacterCastMember[]): CharacterCastMember[] {
  return cast.map((member) => (member.id?.trim() || !member.name?.trim())
    ? member
    : { ...member, id: newCastMemberId() });
}

/**
 * What a cast member's own page may show.
 *
 * `description` is the member's AI definition — the same class of material as
 * a response directive — and it is not public. This is the exhaustive list of
 * what leaves the server for a member page, which is what makes that
 * reviewable rather than a matter of remembering.
 */
export type PublicCastMember = {
  key: string;
  name: string;
  role: string;
  tagline: string;
  avatarPath: string;
  avatarUrl: string;
};

export function publicCastMember(member: CharacterCastMember): PublicCastMember {
  return {
    key: castMemberKey(member),
    name: member.name,
    role: member.role,
    tagline: member.tagline,
    avatarPath: member.avatarPath,
    avatarUrl: member.avatarUrl,
  };
}
