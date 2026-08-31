/**
 * Proving that a positional recovery found the message the reader meant.
 *
 * Mutations name their target by id. That is normally enough — the chat route
 * adopts the browser's own message ids, so the id a reader is looking at is the
 * id in the database. The exception is a message whose write never landed under
 * the id the client still holds, and for those a position within the
 * conversation was accepted as a second way in.
 *
 * A position is only a safe key if it is absolute AND checked. It became unsafe
 * the moment the transcript stopped being the whole story: a windowed list hands
 * out indices counted from the top of the WINDOW, and an index counted from the
 * top of a window resolves, against the whole conversation, to a message four
 * hundred replies earlier. "Delete from here" would then take the wrong suffix,
 * and the reader would have no way to know until the story was gone.
 *
 * So the client now sends the absolute position AND a digest of the message it
 * is actually looking at, and the server refuses to act unless the row it
 * recovered is that message. A destructive operation is not allowed to guess.
 */

/** The bytes a message is identified by: its role and the text on screen. */
function fingerprintInput(role: string, content: string) {
  return `${role}\n${content}`;
}

/**
 * A stable digest of one message body.
 *
 * Content travels between the database and the screen untransformed, so the
 * same message digests identically on both sides. Anything else — a row at the
 * requested position that is not the message the reader is looking at — fails
 * to match, which is the whole point.
 */
export async function messageFingerprint(role: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprintInput(role, content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** True when a stored row is provably the message the client described. */
export async function fingerprintMatches(row: { role?: unknown; content?: unknown }, expected: string | undefined | null) {
  if (!expected || typeof expected !== "string") return false;
  const actual = await messageFingerprint(String(row.role ?? ""), String(row.content ?? ""));
  return actual === expected;
}
