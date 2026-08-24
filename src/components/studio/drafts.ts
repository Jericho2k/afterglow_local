import { creationTitle, creationTypeLabels } from "@/lib/creation";
import type { CreationType } from "@/lib/types";
import { draftFromCharacter, isMeaningfulDraft, type CreationDraft } from "./draft";

/**
 * Stored studio drafts.
 *
 * The studio has always mirrored an interrupted session into local storage;
 * what it never had was a way to see that anything was there. One key per
 * creation — plus one shared "new" slot for a creation that has not been saved
 * yet — means several drafts already exist in practice, so this reads them all
 * rather than inventing a draft backend to make a list possible.
 *
 * A draft here is unsaved work, which is a different thing from a private
 * creation: a private creation is a saved row and lives in Your Creations.
 * Keeping the two apart is what stops the same creation appearing twice under
 * two different names for the same state.
 *
 * Every read is defensive. Local storage can be full, blocked, shared with an
 * older build, or holding a value somebody edited by hand, and none of those
 * may stop the Create screen from rendering.
 */

export const draftKeyPrefix = "afterglow:studio:v1:";

/** The slot a creation that has never been saved autosaves into. */
export const newDraftKey = `${draftKeyPrefix}new`;

export function draftStorageKey(id: string | null) {
  return `${draftKeyPrefix}${id ?? "new"}`;
}

export type StoredDraft = { savedAt: string; draft: CreationDraft };

export type DraftSummary = {
  key: string;
  /** The creation this draft belongs to, or null for unsaved new work. */
  creationId: string | null;
  savedAt: string;
  draft: CreationDraft;
  /** What to show on the card: the creation's title, or a typed placeholder. */
  label: string;
  creationType: CreationType;
  typeLabel: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key"> & { length: number };

function storage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}

function parse(raw: string | null): StoredDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!parsed?.draft || typeof parsed.draft !== "object") return null;
    return { savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "", draft: parsed.draft };
  } catch { return null; }
}

export function readStoredDraft(id: string | null, store: StorageLike | null = storage()): StoredDraft | null {
  return parse(store?.getItem(draftStorageKey(id)) ?? null);
}

export function writeStoredDraft(key: string, draft: CreationDraft, store: StorageLike | null = storage()) {
  try { store?.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), draft })); }
  catch { /* Storage can be full or blocked; the draft simply is not mirrored. */ }
}

export function forgetStoredDraft(key: string, store: StorageLike | null = storage()) {
  try { store?.removeItem(key); } catch { /* Nothing to forget. */ }
}

/** A title for a draft that may not have one yet. Never "Untitled creation" twice over. */
export function draftLabel(draft: CreationDraft) {
  const titled = creationTitle({ title: draft.title, name: draft.name, creationType: draft.creationType, profileType: draft.profileType });
  if (titled !== "Untitled creation") return titled;
  return draft.creationType === "scenario" ? "Untitled scenario" : draft.creationType === "cast" ? "Untitled cast" : "Untitled character";
}

/**
 * Every draft this browser is holding, newest first.
 *
 * The meaningfulness rule is unchanged and is applied again on read: the
 * studio only writes a draft that differs from where its session started, and
 * anything that nevertheless reads as empty — written by an older build, or
 * left behind by a session that was opened and abandoned — is removed here
 * rather than offered as work to resume. Opening Create and leaving therefore
 * still produces no card.
 */
export function listStoredDrafts(store: StorageLike | null = storage()): DraftSummary[] {
  if (!store) return [];
  const keys: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key && key.startsWith(draftKeyPrefix)) keys.push(key);
    }
  } catch { return []; }

  const drafts: DraftSummary[] = [];
  for (const key of keys) {
    const stored = parse(store.getItem(key));
    if (!stored) { forgetStoredDraft(key, store); continue; }
    // Normalised through the same reader the studio restores with, so a draft
    // written before a field existed is filled in rather than rejected.
    const draft = draftFromCharacter(stored.draft as unknown as Parameters<typeof draftFromCharacter>[0]);
    // Checked against emptiness rather than against a baseline, which is what
    // the studio's own autosave does for a new creation: a stored draft that
    // holds nothing is deleted here instead of being offered as work. A draft
    // belonging to a saved creation was only written because it differed from
    // that record, so it is already past the stricter test.
    if (!isMeaningfulDraft(draft)) { forgetStoredDraft(key, store); continue; }
    const suffix = key.slice(draftKeyPrefix.length);
    drafts.push({
      key,
      creationId: suffix === "new" ? null : suffix,
      savedAt: stored.savedAt,
      draft,
      label: draftLabel(draft),
      creationType: draft.creationType,
      typeLabel: creationTypeLabels[draft.creationType],
    });
  }
  return drafts.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
}

/** Whether the Create screen should offer anything to continue at all. */
export function hasResumableDrafts(store: StorageLike | null = storage()) {
  return listStoredDrafts(store).length > 0;
}

/**
 * Forget every draft in this browser.
 *
 * Drafts are unsaved local work with no server side, so they are scoped to the
 * device rather than to the account. That was survivable while nothing listed
 * them; now that the Create screen offers them back by name, a shared computer
 * would hand one person's unfinished work to whoever signs in next. Signing
 * out clears them, which is the point at which the previous account stops
 * being the one using this browser.
 */
export function forgetAllStoredDrafts(store: StorageLike | null = storage()) {
  if (!store) return;
  const keys: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key && key.startsWith(draftKeyPrefix)) keys.push(key);
    }
  } catch { return; }
  for (const key of keys) forgetStoredDraft(key, store);
}
