"use client";

import { useEffect, useState } from "react";
import { api } from "./api-client";

/**
 * The unread count, shared by every bell on screen.
 *
 * The bell appears in the header of every shell surface, and each of those
 * surfaces mounts independently. Left to themselves they would each fetch the
 * count, so switching between Discovery, Chats and Worlds would issue three
 * requests to draw the same dot — and the three could briefly disagree.
 *
 * So the count is module state with subscribers rather than component state:
 * ONE value, ONE in-flight request no matter how many bells ask for it, and an
 * update after marking read reaches all of them at once.
 *
 * Deliberately not a polling loop. The count is read when the shell starts and
 * whenever the notification list is opened or changed; a notification that
 * arrives while somebody is mid-conversation can wait until they navigate,
 * which is cheaper than a request every thirty seconds for the rest of the
 * session and is not a worse product.
 */

type Snapshot = { unread: number; loaded: boolean };

let snapshot: Snapshot = { unread: 0, loaded: false };
let inFlight: Promise<void> | null = null;
const listeners = new Set<(value: Snapshot) => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener(snapshot);
}

/** Applies a count the server has just confirmed. */
export function setUnreadNotifications(unread: number) {
  publish({ unread: Math.max(0, unread), loaded: true });
}

/**
 * Reads the count, at most once at a time.
 *
 * `?scope=unread` is the cheap half of the notifications route: one capped
 * count over a partial index, and never the feed. A failure is silent — a
 * missing dot is a far better outcome than an error banner over somebody's
 * chat — and simply leaves the last known value in place.
 */
export function refreshUnreadNotifications() {
  if (inFlight) return inFlight;
  inFlight = api<{ unread: number }>("/api/notifications?scope=unread")
    .then((data) => { setUnreadNotifications(Number(data.unread) || 0); })
    .catch(() => undefined)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Forgets the count, for a sign-out. */
export function clearUnreadNotifications() {
  publish({ unread: 0, loaded: false });
}

export function useUnreadNotifications() {
  const [value, setValue] = useState(snapshot);
  useEffect(() => {
    listeners.add(setValue);
    setValue(snapshot);
    if (!snapshot.loaded) void refreshUnreadNotifications();
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

export function resetNotificationStateForTesting() {
  snapshot = { unread: 0, loaded: false };
  inFlight = null;
  listeners.clear();
}
