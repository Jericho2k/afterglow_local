import type { Character } from "./types";

/**
 * The shell's creation list, assembled from two answers that can fail apart.
 *
 * Chats renders its rows from this list, so whatever this returns IS the Chats
 * page. It used to be built with `Promise.all`, which made the two requests one
 * indivisible answer: either both arrived or the list stayed empty. With no
 * retry, and with the only error surface living inside the chat panel, a single
 * failed `/api/characters` left Chats showing its footer and nothing else until
 * the tab was reloaded. That is the reported bug, and this is where it is fixed.
 *
 * Two rules:
 *
 *   A HALF ANSWER IS BETTER THAN NONE. Whichever request succeeded is used.
 *   A HALF ANSWER MAY NOT DELETE. When one side failed, creations already on
 *   screen are kept rather than dropped, because their absence from a partial
 *   answer is not evidence that they are gone.
 */

export type ListOutcome<T> = { ok: true; value: T } | { ok: false; reason: unknown };

export type CreationListResult = {
  characters: Character[];
  /** True when both requests failed and the caller should retry or report. */
  failed: boolean;
  /** True when one side is missing, so the result must not be treated as complete. */
  partial: boolean;
};

/**
 * @param owned   The caller's own creations, complete definitions.
 * @param chats   The creations the caller has stories with, possibly frozen
 *                snapshots of somebody else's published creation.
 * @param current What the shell is already showing.
 */
export function mergeCreationLists(
  owned: ListOutcome<Character[]>,
  chats: ListOutcome<Character[]>,
  current: Character[] = [],
): CreationListResult {
  if (!owned.ok && !chats.ok) return { characters: current, failed: true, partial: true };

  const ownedList = owned.ok ? owned.value : [];
  const chatList = chats.ok ? chats.value : [];
  // A chat snapshot deliberately has no reusable world links. Prefer the live
  // owned card when both exist, otherwise editing a creation reached from Chats
  // appears to have zero worlds and saving it detaches them.
  const ownedById = new Map(ownedList.map((character) => [character.id, character]));
  const merged = [
    ...chatList.map((character) => ownedById.get(character.id) ?? character),
    ...ownedList.filter((character) => !chatList.some((chat) => chat.id === character.id)),
  ];

  const partial = !owned.ok || !chats.ok;
  if (!partial) return { characters: merged, failed: false, partial: false };

  const known = new Set(merged.map((character) => character.id));
  return {
    characters: [...merged, ...current.filter((character) => !known.has(character.id))],
    failed: false,
    partial: true,
  };
}
