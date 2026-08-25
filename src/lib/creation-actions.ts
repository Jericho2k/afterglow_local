/**
 * Which actions a creation offers, and to whom.
 *
 * A pure decision rather than JSX, so the ownership rule is one testable thing
 * instead of a condition repeated on every surface that shows a menu. Two
 * rules, and both matter:
 *
 *   * Edit and Delete require ownership. They are absent for everybody else
 *     rather than present and failing, because the server refuses them anyway
 *     and a disabled button that cannot work is worse than no button.
 *   * Nothing appears here that the product cannot do. There is no Report, no
 *     Duplicate and no Export in this deployment, so a menu that is short is
 *     short rather than padded out with actions that go nowhere.
 */

export type CreationActionId = "edit" | "copy_link" | "delete";

export type CreationAction = {
  id: CreationActionId;
  label: string;
  danger?: boolean;
  /** True when the action needs confirming before it runs. */
  confirms?: boolean;
};

export function creationActions({ owner }: { owner: boolean }): CreationAction[] {
  return [
    ...(owner ? [{ id: "edit" as const, label: "Edit creation" }] : []),
    // The one action that needs nothing of anybody: a public page has a URL.
    { id: "copy_link" as const, label: "Copy link" },
    ...(owner ? [{ id: "delete" as const, label: "Delete creation", danger: true, confirms: true }] : []),
  ];
}

/** Where Edit goes. A real page, not a redirect through the home shell. */
export function creationEditHref(creationId: string) {
  return `/characters/${creationId}/edit`;
}

/**
 * Where a successful save lands.
 *
 * One decision, one destination, taken from the saved record itself — which is
 * the whole point. The shell used to close the studio, await three library
 * refreshes, and only then navigate: the reader saw the feed, and five to ten
 * seconds later the creation page opened by itself. Two destinations, the
 * second one arriving as a surprise.
 *
 * A creation exists the moment the save returns, so its id is available the
 * moment the save returns, and nothing about a background refresh may decide
 * where the reader is. `replace` rather than push because the completed form
 * is not somewhere Back should return to.
 */
export type SavedCreationDestination =
  | { kind: "creation"; href: string; replace: true }
  | { kind: "chat" };

export function savedCreationDestination(
  creationId: string,
  { created, justCreatedParam }: { created: boolean; justCreatedParam: string },
): SavedCreationDestination {
  // Editing an existing creation returns to its story, which is where the
  // creator was. Only a brand-new creation gets its own page opened for it.
  if (!created) return { kind: "chat" };
  return { kind: "creation", href: `/characters/${creationId}?${justCreatedParam}=1`, replace: true };
}
