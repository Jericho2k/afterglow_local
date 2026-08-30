import type { Conversation, Message } from "./types";

/**
 * Which story the chat view is showing, and which request put it there.
 *
 * Two reported bugs live in this one decision, and they are the same decision
 * seen twice.
 *
 *   THE PREVIOUS STORY STAYED ON SCREEN. Selecting a chat set the selection and
 *   then awaited a fetch, leaving the last conversation's replies mounted under
 *   the new one's name for as long as the round trip took. An empty, loading
 *   chat is a slower-looking screen and a truthful one; the alternative was
 *   neither. `openChatView` clears in the same step as it selects, so there is
 *   no state in which one story's messages sit under another story's header.
 *
 *   A SLOW ANSWER COULD LAND ON THE WRONG CHAT. Nothing ordered the responses,
 *   so A→B→C with A answering last painted A over C. Every request carries a
 *   nonce and only the newest one may write, which is what makes rapid
 *   switching land on what was actually clicked.
 *
 * The nonce also solves a subtler thing a "which conversation did I ask for"
 * flag could not: reopening the SAME creation on a DIFFERENT story is a new
 * request, and comparing identifiers alone could not see that.
 */

export type ChatRequest = { characterId: string; conversationId: string | null; nonce: number };

export type ChatView = {
  /** What was asked for, or null when nothing is being shown or loaded. */
  request: ChatRequest | null;
  conversation: Conversation | null;
  messages: Message[];
  loading: boolean;
  /**
   * Whether the story continues above what is on screen.
   *
   * Opening a chat reads a bounded window of the newest messages rather than
   * the whole transcript, because the whole transcript is the dominant cost of
   * opening a long story and it grows with exactly the thing the product wants
   * people to do. Nothing is lost: this is what the "Load earlier" control is
   * rendered from, and `prependedMessages` puts the next page in front.
   */
  hasMoreBefore: boolean;
  loadingEarlier: boolean;
};

export const emptyChatView: ChatView = { request: null, conversation: null, messages: [], loading: false, hasMoreBefore: false, loadingEarlier: false };

/**
 * Point the view at a story.
 *
 * Everything belonging to the previous story goes in the same step, because a
 * partially-updated chat is the bug rather than a stage on the way out of it.
 */
export function openChatView(view: ChatView, characterId: string, conversationId: string | null): ChatView {
  return {
    request: { characterId, conversationId, nonce: (view.request?.nonce ?? 0) + 1 },
    conversation: null,
    messages: [],
    loading: true,
    hasMoreBefore: false,
    loadingEarlier: false,
  };
}

/** True only for the newest request. Anything older has been superseded. */
export function acceptsResponse(view: ChatView, nonce: number) {
  return view.request?.nonce === nonce;
}

/** A story that arrived for the request that is still current. */
export function chatLoaded(view: ChatView, nonce: number, conversation: Conversation, messages: Message[], hasMoreBefore = false): ChatView {
  if (!acceptsResponse(view, nonce)) return view;
  return { ...view, conversation, messages, loading: false, hasMoreBefore, loadingEarlier: false };
}

/**
 * An older page, in front of what is already shown.
 *
 * Guarded on the conversation rather than on a nonce: this is not a switch, and
 * a page that arrives after the reader has moved to another story must not be
 * spliced into it. Ids already present are skipped so a double tap cannot
 * duplicate a message.
 */
export function prependedMessages(view: ChatView, conversationId: string, older: Message[], hasMoreBefore: boolean): ChatView {
  if (view.conversation?.id !== conversationId) return view;
  const known = new Set(view.messages.map((message) => message.id));
  const added = older.filter((message) => !known.has(message.id));
  return { ...view, messages: [...added, ...view.messages], hasMoreBefore, loadingEarlier: false };
}

/** A request that failed. Only the newest one may stop the spinner. */
export function chatFailed(view: ChatView, nonce: number): ChatView {
  return acceptsResponse(view, nonce) ? { ...view, loading: false } : view;
}

/**
 * A story the server handed back complete — a new conversation, or a branch.
 *
 * It claims a request of its own so that a load still in flight for the
 * previous story cannot arrive afterwards and replace it.
 */
export function adoptChatView(view: ChatView, characterId: string, conversation: Conversation, messages: Message[]): ChatView {
  return {
    request: { characterId, conversationId: conversation.id, nonce: (view.request?.nonce ?? 0) + 1 },
    conversation,
    messages,
    loading: false,
    hasMoreBefore: false,
    loadingEarlier: false,
  };
}

/** Signing out, or losing the account. Nothing may still be in flight for it. */
export function clearChatView(): ChatView {
  return emptyChatView;
}
