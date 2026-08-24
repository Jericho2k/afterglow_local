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
