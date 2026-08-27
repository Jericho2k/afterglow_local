import { api } from "./api-client";

/**
 * Following a creator.
 *
 * Every surface that offers Follow — the creator card on a creation page, the
 * creator's own profile, a ranked creator row — goes through here and therefore
 * through `/api/follows`, which writes the single `profile_follows` relation.
 * There is no second follow store to keep in step, and no second optimistic
 * dance to drift out of agreement with this one.
 *
 * Deliberately the same shape as `saves.ts`. Follow and Save are the same kind
 * of control — a toggle whose truth lives on the server and whose count is
 * public — so a reader who has learned how one behaves has learned both.
 */

/**
 * The response carries the authoritative follower count, so an optimistic
 * button settles on the real number rather than trusting its own arithmetic.
 * Null when the creator is no longer readable, which callers treat as "keep the
 * number you already worked out".
 */
export type FollowResult = { following: boolean; followers: number | null };

export type FollowState = { following: boolean; followers: number };

export function setCreatorFollowed(username: string, following: boolean) {
  return following
    ? api<FollowResult>("/api/follows", { method: "POST", body: JSON.stringify({ username }) })
    : api<FollowResult>(`/api/follows?username=${encodeURIComponent(username)}`, { method: "DELETE" });
}

/**
 * The whole optimistic dance, in one place:
 *
 *   1. flip immediately, so a tap feels instant;
 *   2. settle on the server's own count once it answers;
 *   3. put the original state back if the write failed, because a follower who
 *      was never gained must never stay on screen.
 *
 * `apply` is how the caller writes state; the returned message is non-empty
 * only when the write failed, and is meant to be shown.
 */
export async function toggleCreatorFollow(
  creator: { username: string } & FollowState,
  apply: (state: FollowState) => void,
): Promise<string> {
  if (!creator.username) return "This creator does not have a public profile yet.";
  const next = !creator.following;
  const optimistic = Math.max(0, creator.followers + (next ? 1 : -1));
  apply({ following: next, followers: optimistic });
  try {
    const result = await setCreatorFollowed(creator.username, next);
    apply({ following: result.following, followers: Math.max(0, result.followers ?? optimistic) });
    return "";
  } catch (reason) {
    apply({ following: creator.following, followers: creator.followers });
    return reason instanceof Error ? reason.message : "Could not update who you follow";
  }
}

/** Where a creator's public page lives, or "" when they have no handle yet. */
export function creatorProfileHref(username: string | null | undefined) {
  return username ? `/creators/${encodeURIComponent(username)}` : "";
}
