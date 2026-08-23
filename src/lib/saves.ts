import { api } from "./api-client";

/**
 * Saving a creation.
 *
 * Every surface that offers Save — the feed card, the saved library, the
 * creation page — goes through here and therefore through `/api/saves`, which
 * writes the single `character_likes` relation. There is no second bookmark
 * store to keep in step.
 */

/**
 * The response carries the authoritative global total, so an optimistic card
 * settles on the real number rather than trusting its own arithmetic. It is
 * null when the creation is no longer readable, which callers treat as "keep
 * the number you already worked out".
 */
export type SaveResult = { saved: boolean; saveCount: number | null };

export type SaveState = { savedByViewer: boolean; saveCount: number };

export function setCreationSaved(creationId: string, saved: boolean) {
  return saved
    ? api<SaveResult>("/api/saves", { method: "POST", body: JSON.stringify({ characterId: creationId }) })
    : api<SaveResult>(`/api/saves?characterId=${encodeURIComponent(creationId)}`, { method: "DELETE" });
}

/**
 * The whole optimistic dance, in one place so the feed, the library and the
 * creation page cannot drift apart on it:
 *
 *   1. flip immediately, so a tap feels instant;
 *   2. settle on the server's own total once it answers;
 *   3. put the original state back if the write failed, because a count that
 *      never happened must never stay on screen.
 *
 * `apply` is how the caller writes state; the returned message is non-empty
 * only when the write failed, and is meant to be shown.
 */
export async function toggleCreationSave(
  creation: { id: string } & SaveState,
  apply: (state: SaveState) => void,
): Promise<string> {
  const next = !creation.savedByViewer;
  const optimistic = Math.max(0, creation.saveCount + (next ? 1 : -1));
  apply({ savedByViewer: next, saveCount: optimistic });
  try {
    const result = await setCreationSaved(creation.id, next);
    apply({ savedByViewer: result.saved, saveCount: Math.max(0, result.saveCount ?? optimistic) });
    return "";
  } catch (reason) {
    apply({ savedByViewer: creation.savedByViewer, saveCount: creation.saveCount });
    return reason instanceof Error ? reason.message : "Could not update your saved creations";
  }
}
