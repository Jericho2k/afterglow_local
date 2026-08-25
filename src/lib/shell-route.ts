/**
 * The address of what the shell is showing.
 *
 * Afterglow's shell renders several surfaces from one route, so "which surface"
 * has to live somewhere. It used to live only in React state, and that is the
 * whole of the Back complaint: a chat had no address, so the entry underneath a
 * creation page opened from a chat named whatever the reader had last
 * navigated to — Chats, or Discovery — and Back honestly returned there.
 * Worse, the one path that DID carry a chat in the URL
 * (`/?character=…&conversation=…`, pushed by a creation page's Chat button)
 * immediately rewrote itself to "/", deleting the only record that the chat had
 * ever been open.
 *
 * So a chat is a route now. `chatHref` is what a history entry says, and
 * `routeFromSearch` is what reads it back — on first load, and on every
 * popstate. Nothing guesses an origin, because the origin is written down.
 *
 * Older links keep working. `?view=likes` predates saving replacing liking, and
 * `?character=…` without a view is the form the creation page used to push;
 * both resolve here rather than in the component, so there is one place that
 * knows what an Afterglow URL can look like.
 */

export const shellViews = ["home", "chats", "worlds", "personas", "profile", "saved", "creations"] as const;
export type ShellView = (typeof shellViews)[number];
export type AppView = ShellView | "chat";

export type ShellRoute =
  | { view: ShellView }
  | { view: "chat"; characterId: string; conversationId: string | null };

/** Things a URL can ask the shell to DO, as opposed to show. */
export type ShellCommand =
  | { kind: "createCreation" }
  | { kind: "editCreation"; characterId: string }
  | { kind: "editWorld"; worldId: string }
  | { kind: "verified" };

export function isShellView(value: string | null | undefined): value is ShellView {
  return Boolean(value) && (shellViews as readonly string[]).includes(value as string);
}

function params(search: string | URLSearchParams) {
  return typeof search === "string" ? new URLSearchParams(search) : search;
}

/**
 * The route a URL names, or null when it names none.
 *
 * Null is not an error: `/?create=1` is a command with no surface of its own,
 * and a bare `/` is Home. Returning null lets the caller keep whatever it is
 * already showing rather than being bounced to Discovery, which is what used to
 * happen to a reader returning from a creation page.
 */
export function routeFromSearch(search: string | URLSearchParams): ShellRoute | null {
  const query = params(search);
  const raw = query.get("view");
  // "likes" was this view's name before saving replaced liking.
  const view = raw === "likes" ? "saved" : raw;
  const characterId = query.get("character");
  if (view === "chat" || (!view && characterId)) {
    return characterId ? { view: "chat", characterId, conversationId: query.get("conversation") } : null;
  }
  if (isShellView(view)) return { view };
  // A bare "/" is Home; anything else unrecognised is left to the caller.
  if (!view && !characterId && !query.get("create") && !query.get("editCharacter") && !query.get("editWorld")) return { view: "home" };
  return null;
}

export function commandFromSearch(search: string | URLSearchParams): ShellCommand | null {
  const query = params(search);
  if (query.get("create") === "1") return { kind: "createCreation" };
  const editCharacter = query.get("editCharacter");
  if (editCharacter) return { kind: "editCreation", characterId: editCharacter };
  const editWorld = query.get("editWorld");
  if (editWorld) return { kind: "editWorld", worldId: editWorld };
  if (query.get("verification") === "success") return { kind: "verified" };
  return null;
}

export function viewHref(view: ShellView) {
  return view === "home" ? "/" : `/?view=${view}`;
}

/**
 * A chat's own address.
 *
 * The conversation is included whenever it is known, so returning to this entry
 * reopens the exact story rather than the newest one — which is the difference
 * between "Back works" and "Back nearly works".
 */
export function chatHref(characterId: string, conversationId?: string | null) {
  const query = new URLSearchParams({ view: "chat", character: characterId });
  if (conversationId) query.set("conversation", conversationId);
  return `/?${query}`;
}

export function hrefForRoute(route: ShellRoute) {
  return route.view === "chat" ? chatHref(route.characterId, route.conversationId) : viewHref(route.view);
}

/** True when the address bar already says this, so pushing would only stack. */
export function isCurrentHref(location: { pathname: string; search: string }, href: string) {
  return `${location.pathname}${location.search}` === href;
}
