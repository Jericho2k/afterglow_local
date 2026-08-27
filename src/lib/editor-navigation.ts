/**
 * Where the editor sends a creator when they save.
 *
 * The reported bug: open a creation, open the ••• menu, Edit, Save, and then
 * press Back — and land back in the editor. Press Back again, return to the
 * creation, and from then on Back behaves.
 *
 * That is not a guess about history, it is arithmetic on it. Saving did
 * `router.push("/characters/{id}")`, so the stack after a save read:
 *
 *   Origin → Creation → Edit → Creation
 *
 * Back from the last entry is the editor, exactly as the browser was told. The
 * second Back then reaches the first Creation entry, which is why it "starts
 * behaving" — the duplicate has been walked past.
 *
 * There are two right answers depending on what is underneath the editor, and
 * telling them apart is the whole of this module:
 *
 *   THE CREATION IS ALREADY UNDERNEATH. Edit was pressed on the creation's own
 *   page, so the entry below the editor IS the destination. Going BACK to it
 *   leaves the stack as `Origin → Creation`, which is what the creator would
 *   have had if they had never opened the editor. One Back returns them to
 *   Discovery, or to the chat, or to wherever they actually came from.
 *
 *   IT IS NOT. Edit was reached from the sidebar, from a `?editCharacter=` link
 *   or by typing the URL, so there is nothing below to go back to. The editor's
 *   entry is REPLACED by the creation, which is the rule the sprint asks for:
 *   the completed form is not somewhere Back should return to.
 *
 * The marker is written at the moment Edit is pressed on a creation page and
 * read once when that same creation is saved. It is deliberately narrow — it
 * names the creation and is spent on use — so a marker left behind by an
 * abandoned edit cannot make some later save do the wrong thing.
 */

export const editorOriginKey = "afterglow:nav:editorOrigin";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

/** Records that this editor was opened from the creation's own page. */
export function markEditorOpenedFromCreation(storage: StorageLike, creationId: string) {
  try { storage?.setItem(editorOriginKey, creationId); }
  catch { /* Without the marker a save merely replaces instead of going back. */ }
}

/** Reads the marker and spends it, so it can never apply to a second save. */
export function takeEditorOrigin(storage: StorageLike): string | null {
  try {
    const value = storage?.getItem(editorOriginKey) ?? null;
    storage?.removeItem(editorOriginKey);
    return value || null;
  } catch { return null; }
}

/** Clears a marker an abandoned edit would otherwise leave behind. */
export function forgetEditorOrigin(storage: StorageLike) {
  try { storage?.removeItem(editorOriginKey); }
  catch { /* Nothing to do; a stale marker is spent by the next save anyway. */ }
}

export type SavedEditDestination =
  | { type: "back" }
  | { type: "replace"; href: string };

/**
 * Where a successful save goes.
 *
 * `back` only when the marker names THIS creation, because that is the only
 * case in which the entry underneath is known to be its page. Everything else
 * replaces, which is always safe: it can never leave a duplicate behind and it
 * can never return the creator into the form they just completed.
 */
export function savedEditDestination(creationId: string, origin: string | null): SavedEditDestination {
  if (origin && origin === creationId) return { type: "back" };
  return { type: "replace", href: `/characters/${creationId}` };
}
