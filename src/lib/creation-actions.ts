import { creationCtaDescription, creationCtaLabel, creationTitle, creationType } from "./creation";

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

export type CreationActionId = "edit" | "copy_link" | "report" | "delete";

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
    ...(!owner ? [{ id:"report" as const,label:"Report creation" }] : []),
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

/**
 * What the creation page's main button does.
 *
 * It used to do one thing regardless: POST a new conversation. A reader with
 * eleven stories about the same character therefore collected a twelfth every
 * time they pressed a button labelled "Start chat", and their actual story —
 * the one with the memories, the scene state and the relationship in it — got
 * harder to find with every tap.
 *
 * Two actions were hiding inside one control, so there are two now:
 *
 *   RESUME opens the story the reader was last in. Nothing is created and
 *   nothing is written: the conversation already exists, so the button is a
 *   link to its address and the shell opens it.
 *
 *   START creates the first one, which is the only case in which pressing the
 *   main button should bring a conversation into existence.
 *
 * "New story" stays available and stays SEPARATE, because deliberately
 * beginning again is a real thing to want and is not what "Chat" means.
 *
 * The wording for a creation with no story yet still comes from
 * `creationCtaLabel`, so a scenario keeps saying "Enter story" rather than
 * "Start chat"; a creation that HAS one says so in the same voice.
 */
export type ChatCta = {
  kind: "start" | "resume";
  label: string;
  /** The story to open. Null means one has to be created first. */
  conversationId: string | null;
};

type CtaCreation = Parameters<typeof creationCtaLabel>[0];

export function chatCta(creation: CtaCreation, conversationId: string | null): ChatCta {
  if (!conversationId) return { kind: "start", label: creationCtaLabel(creation), conversationId: null };
  return {
    kind: "resume",
    label: creationType(creation) === "character" ? "Continue chat" : "Continue story",
    conversationId,
  };
}

/** The accessible name for that button, which may spell the creation out. */
export function chatCtaDescription(creation: CtaCreation, cta: ChatCta) {
  if (cta.kind === "start") return creationCtaDescription(creation);
  const title = creationTitle(creation);
  return creationType(creation) === "character"
    ? `Continue your most recent chat with ${title}`
    : `Continue your most recent story in ${title}`;
}

/*
 * "New story" used to be a `+` beside the creation page's main call to action,
 * and its label lived here. The control is gone: two primary-looking buttons
 * competing for one thumb is worse than one, and beginning again is still a
 * real action inside the chat's story drawer, where it is spelled out as
 * "Start separate story" rather than being a glyph. What is NOT gone is the
 * rule this file exists for — the main button resumes when there is something
 * to resume, and never quietly creates a second conversation.
 */
