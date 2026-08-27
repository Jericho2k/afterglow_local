import type { PoolClient } from "pg";

/**
 * Notifications.
 *
 * One event type in this release: a creator you follow published something
 * public. That narrowness is deliberate. A notification system whose first
 * release already has six kinds has no way of learning which one people
 * actually open, and every kind that nobody opens costs the ones that matter.
 *
 * Everything below is built so the second type is a row rather than a redesign:
 * the table, the payload and the list query all key off `type`, and none of the
 * reading code assumes a creation is involved.
 *
 * WHAT A NOTIFICATION IS FOR is the other constraint. It is not decoration and
 * it is not a summary — it is a way back into the product, so the only
 * interaction it has is opening the exact thing it is about.
 */

export type NotificationType = "creation_published";

export type NotificationItem = {
  id: string;
  type: NotificationType;
  createdAt: string;
  read: boolean;
  actor: { username: string; displayName: string; avatarPath: string } | null;
  creation: {
    id: string;
    /** What the card is titled — a creation's title, not necessarily a name. */
    title: string;
    name: string;
    creationType: "character" | "cast" | "scenario";
    avatarPath: string;
    avatarUrl: string;
    accent: string;
  } | null;
};

/** One screen of notifications. */
export const notificationsPageSize = 20;

/**
 * How high the unread counter is allowed to go before it stops counting.
 *
 * The bell needs to know "any" and roughly "how many"; it does not need to know
 * that there are four thousand, and counting to four thousand on every shell
 * render to draw a dot would be the wrong trade. The list itself is the place
 * to find out what they are.
 */
export const unreadCap = 99;

/** How a count reads once it has hit the cap. */
export function unreadLabel(count: number) {
  return count > unreadCap ? `${unreadCap}+` : String(count);
}

/**
 * The columns a notification list reads.
 *
 * The join onto `characters` is not decoration: it is what makes a creation
 * that has since been made PRIVATE disappear from the feed instead of
 * remaining as a row naming something nobody can open. A creation that was
 * DELETED is gone already — the foreign key cascades — so between the two, a
 * notification can never outlive the thing it points at.
 *
 * Nothing hidden is selected. A title, a cover, a type and an accent; no
 * greeting, no personality, no definition.
 */
const columns = `n.id,n.type,n.created_at,n.read_at,
  p.username actor_username,p.display_name actor_display_name,p.avatar_path actor_avatar_path,
  c.id creation_id,c.title creation_title,c.name creation_name,c.creation_type,c.profile_type,
  c.avatar_path creation_avatar_path,c.avatar_url creation_avatar_url,c.accent creation_accent`;

const from = `FROM notifications n
  LEFT JOIN profiles p ON p.id=n.actor_user_id
  JOIN characters c ON c.id=n.character_id AND c.visibility='public'`;

function itemFromRow(row: Record<string, unknown>): NotificationItem {
  const storedType = String(row.creation_type || "");
  const creationType = storedType === "cast" || storedType === "scenario" || storedType === "character"
    ? storedType
    : row.profile_type === "ensemble" ? "cast" : "character";
  return {
    id: String(row.id),
    type: "creation_published",
    createdAt: new Date(String(row.created_at)).toISOString(),
    read: row.read_at != null,
    actor: row.actor_username || row.actor_display_name
      ? {
        username: String(row.actor_username || ""),
        displayName: String(row.actor_display_name || ""),
        avatarPath: String(row.actor_avatar_path || ""),
      }
      : null,
    creation: row.creation_id
      ? {
        id: String(row.creation_id),
        title: String(row.creation_title || ""),
        name: String(row.creation_name || ""),
        creationType: creationType as "character" | "cast" | "scenario",
        avatarPath: String(row.creation_avatar_path || ""),
        avatarUrl: String(row.creation_avatar_url || ""),
        accent: String(row.creation_accent || "#e879a9"),
      }
      : null,
  };
}

/**
 * A page of this account's notifications, newest first.
 *
 * `notifications_user_idx` matches this ordering exactly, so a page is a range
 * scan rather than a sort of everything the account has ever been sent. One row
 * beyond the page answers "is there more" without a COUNT.
 */
export async function listNotifications(
  client: PoolClient,
  userId: string,
  options: { limit?: number; before?: string | null } = {},
) {
  const limit = Math.min(Math.max(1, options.limit ?? notificationsPageSize), 50);
  const values: unknown[] = [userId];
  let cursor = "";
  if (options.before) {
    values.push(options.before);
    cursor = ` AND n.created_at < $${values.length}`;
  }
  values.push(limit + 1);
  const result = await client.query(
    `SELECT ${columns} ${from}
     WHERE n.user_id=$1${cursor}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $${values.length}`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const items = rows.map(itemFromRow);
  return {
    notifications: items,
    hasMore,
    /** Pass back as `before` for the next page. Null when the list is done. */
    nextCursor: hasMore && items.length ? items[items.length - 1].createdAt : null,
  };
}

/**
 * How many unread notifications this account has, capped.
 *
 * This is the query the application shell runs to decide whether to draw a dot,
 * so it is the one that must stay cheap forever. `notifications_unread_idx` is
 * partial — it holds one entry per UNREAD notification per account rather than
 * one per notification ever sent — and the subquery's LIMIT means the count
 * stops at the cap instead of walking a backlog somebody never opened.
 *
 * The join is still here, so a dot is never drawn for a release that has since
 * been unpublished.
 */
export async function unreadNotificationCount(client: PoolClient, userId: string) {
  const result = await client.query(
    `SELECT count(*)::int count FROM (
       SELECT 1 ${from}
       WHERE n.user_id=$1 AND n.read_at IS NULL
       LIMIT ${unreadCap + 1}
     ) capped`,
    [userId],
  );
  return Number(result.rows[0]?.count || 0);
}

/**
 * Marks notifications read.
 *
 * `ids` empty means "all of them". Both forms are one statement, and both are
 * idempotent: `read_at IS NULL` in the predicate means opening the same
 * notification twice does not move the timestamp, so "when did you first see
 * this" stays true.
 *
 * Row level security restricts the update to this account's own rows, and the
 * `user_id` predicate says the same thing again — the two layers fail
 * independently.
 */
export async function markNotificationsRead(client: PoolClient, userId: string, ids: string[]) {
  if (ids.length) {
    const result = await client.query(
      "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND id = ANY($2::uuid[])",
      [userId, ids],
    );
    return result.rowCount ?? 0;
  }
  const result = await client.query(
    "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",
    [userId],
  );
  return result.rowCount ?? 0;
}
