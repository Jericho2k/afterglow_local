import { asUser } from "@/lib/db";
import {
  listNotifications, markNotificationsRead, notificationsPageSize, unreadNotificationCount,
} from "@/lib/notifications";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Notifications, and the dot.
 *
 * Two different questions with two very different costs, so they are two
 * different requests:
 *
 *   `?scope=unread` is what the application shell asks on the way in, and it
 *   must stay cheap forever: one capped count over a partial index. It does NOT
 *   fetch the feed. Downloading twenty notifications with their covers to
 *   decide whether to paint a four-pixel dot is the mistake this split exists
 *   to make impossible.
 *
 *   The default is the list, and it is only read when somebody has actually
 *   gone to look at it — paginated by timestamp cursor rather than by offset,
 *   so a notification arriving mid-scroll cannot shift a page boundary and hide
 *   a row.
 *
 * A notification for a creation that has since been made private or deleted is
 * absent from BOTH answers; see `src/lib/notifications.ts` for the join that
 * decides it. Nothing here can report on a creation the caller could not open.
 */

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const params = new URL(request.url).searchParams;

  if (params.get("scope") === "unread") {
    const unread = await asUser(account.id, (client) => unreadNotificationCount(client, account.id));
    return Response.json({ unread, hasUnread: unread > 0 });
  }

  const limit = Math.min(Math.max(1, Number.parseInt(params.get("limit") ?? "", 10) || notificationsPageSize), 50);
  // A cursor is a timestamp the client got from us. An unparseable one is
  // ignored rather than refused: the worst case is the first page again.
  const raw = params.get("before") ?? "";
  const before = raw && !Number.isNaN(Date.parse(raw)) ? raw : null;

  const payload = await asUser(account.id, async (client) => {
    const [page, unread] = await Promise.all([
      listNotifications(client, account.id, { limit, before }),
      unreadNotificationCount(client, account.id),
    ]);
    return { ...page, unread };
  });
  return Response.json(payload);
}

/**
 * Marking read.
 *
 * `{ ids: [...] }` marks those; `{ all: true }` marks everything. Both are one
 * statement and both are idempotent, so a client that fires on open, on scroll
 * and on close does no harm and moves no timestamp twice.
 *
 * The response carries the authoritative unread count, for exactly the reason
 * saving and following do: an optimistic dot settles on the real number instead
 * of trusting its own arithmetic.
 */
export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`notifications:${account.id}`, 240, 60_000); if (limited) return limited;
  const body = await request.json().catch(() => ({})) as { ids?: unknown; all?: unknown };

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)).slice(0, 100)
    : [];
  // Marking nothing is not the same as marking everything, so "all" has to be
  // asked for rather than inferred from an empty list.
  if (!ids.length && body.all !== true) {
    return Response.json({ error: "Nothing to mark as read" }, { status: 400 });
  }

  const unread = await asUser(account.id, async (client) => {
    await markNotificationsRead(client, account.id, ids);
    return unreadNotificationCount(client, account.id);
  });
  return Response.json({ unread, hasUnread: unread > 0 });
}
