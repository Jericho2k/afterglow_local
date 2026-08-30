"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BellOff, CheckCheck, Compass, Sparkles, Users } from "lucide-react";
import { api } from "@/lib/api-client";
import { creationTypeLabels } from "@/lib/creation";
import { creatorProfileHref } from "@/lib/follows";
import { notificationsPageSize, type NotificationItem } from "@/lib/notifications";
import { refreshUnreadNotifications, setUnreadNotifications } from "@/lib/notification-state";
import { avatarSource, characterAvatarBucket, profileAvatarBucket } from "@/lib/storage";
import { uiStyles } from "@/components/ui";
import { PageHeader } from "./PageHeader";
import { useShellNav } from "./ShellNav";
import styles from "./shell.module.css";

/**
 * Notifications.
 *
 * A destination rather than a popover, because that is what this shell is: the
 * views are addressable, they get a history entry, and they work identically on
 * a phone and a desktop without a second positioning system that only one of
 * them needs.
 *
 * The rule the whole surface is built around: TAPPING A NOTIFICATION OPENS THE
 * EXACT CREATION IT IS ABOUT. Not a feed filtered to it, not the creator's
 * profile, not a modal describing it. It is a way back into the product, so
 * anything between the tap and the thing is the feature failing.
 *
 * A notification whose creation has since been made private or deleted is not
 * shown at all — the list query joins the creation and requires it to still be
 * public — so there is no such thing here as a row that leads nowhere, and no
 * metadata about something the reader can no longer open.
 */

type Page = { notifications: NotificationItem[]; hasMore: boolean; nextCursor: string | null; unread: number };

function relative(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export function NotificationsView({ onOpenMenu }: { onOpenMenu?: () => void }) {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [unread, setUnread] = useState(0);
  const { openView } = useShellNav();

  const load = useCallback(async (before: string | null) => {
    const params = new URLSearchParams({ limit: String(notificationsPageSize) });
    if (before) params.set("before", before);
    const data = await api<Page>(`/api/notifications?${params}`);
    setItems((current) => (before && current ? [...current, ...data.notifications] : data.notifications));
    setHasMore(data.hasMore);
    setCursor(data.nextCursor);
    setUnread(data.unread);
    setUnreadNotifications(data.unread);
  }, []);

  useEffect(() => {
    let live = true;
    load(null).catch((reason) => {
      if (live) setError(reason instanceof Error ? reason.message : "Could not load your notifications");
    });
    return () => { live = false; };
  }, [load]);

  /**
   * Marking one read, on the way out.
   *
   * Optimistic and not awaited: the reader is already navigating to the
   * creation, and holding that navigation open for a write whose only purpose
   * is to stop a dot being drawn would be the wrong trade. A failure leaves the
   * notification unread, which is recoverable and honest.
   */
  const markOne = useCallback((id: string) => {
    setItems((current) => current?.map((item) => item.id === id ? { ...item, read: true } : item) ?? current);
    setUnread((current) => {
      const next = Math.max(0, current - 1);
      setUnreadNotifications(next);
      return next;
    });
    void api<{ unread: number }>("/api/notifications", { method: "PATCH", body: JSON.stringify({ ids: [id] }) })
      .then((data) => setUnreadNotifications(data.unread))
      .catch(() => void refreshUnreadNotifications());
  }, []);

  const markAll = useCallback(async () => {
    setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? current);
    setUnread(0);
    setUnreadNotifications(0);
    try {
      const data = await api<{ unread: number }>("/api/notifications", { method: "PATCH", body: JSON.stringify({ all: true }) });
      setUnreadNotifications(data.unread);
      setUnread(data.unread);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not mark your notifications as read");
      void refreshUnreadNotifications();
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !cursor) return;
    setLoadingMore(true);
    try { await load(cursor); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load more notifications"); }
    finally { setLoadingMore(false); }
  }, [cursor, hasMore, load, loadingMore]);

  return <section className={styles.page}>
    <div className={styles.inner}>
      <PageHeader
        eyebrow="From the creators you follow"
        title="Notifications"
        lede="New work from creators you follow. Open one and it takes you straight there."
        onOpenMenu={onOpenMenu}
        actions={unread > 0
          ? <button className={`${uiStyles.button} ${uiStyles.secondary}`} onClick={() => void markAll()}>
              <CheckCheck size={15} aria-hidden />Mark all as read
            </button>
          : undefined}
      />

      <div className={styles.stack} style={{ maxWidth: 720 }}>
        {error && <p className={styles.error}>{error}</p>}

        {items === null && !error && <p className={styles.quiet} aria-busy="true">Loading notifications…</p>}

        {items?.length === 0 && <div className={styles.emptyPanel}>
          <BellOff size={26} aria-hidden />
          <h2>Nothing yet</h2>
          <p>
            Follow a creator and you will hear from them here the next time they publish something.
            Notifications start from the moment you follow — there is no backlog to catch up on.
          </p>
        </div>}

        {items && items.length > 0 && <ul className={styles.notificationList}>
          {items.map((item) => {
            const creation = item.creation;
            if (!creation) return null;
            const actorName = item.actor?.displayName || (item.actor?.username ? `@${item.actor.username}` : "A creator");
            const title = creation.title || creation.name || "Untitled";
            const artwork = avatarSource(characterAvatarBucket, creation.avatarPath, creation.avatarUrl);
            const portrait = item.actor?.avatarPath ? avatarSource(profileAvatarBucket, item.actor.avatarPath, "") : "";
            const profile = creatorProfileHref(item.actor?.username);
            return <li key={item.id} className={item.read ? styles.notification : `${styles.notification} ${styles.notificationUnread}`}>
              {/* The whole row opens the creation. */}
              <Link
                className={styles.notificationMain}
                href={`/characters/${creation.id}`}
                onClick={() => { if (!item.read) markOne(item.id); }}
              >
                {/* The artwork gets its own clipping box INSIDE the frame.
                    The frame has to stay `overflow: visible` so the creator's
                    badge can overhang its corner, and that is exactly what let
                    a portrait sit proud of the rounded rectangle. Two elements,
                    two jobs: one clips, one overhangs. */}
                <span className={styles.notificationArt}>
                  <span className={styles.notificationArtFrame}>
                    {artwork
                      ? <img src={artwork} alt="" loading="lazy" decoding="async" />
                      : <span aria-hidden>{initials(title)}</span>}
                  </span>
                  <span className={styles.notificationActor}>
                    {portrait ? <img src={portrait} alt="" loading="lazy" /> : <span aria-hidden>{initials(actorName)}</span>}
                  </span>
                </span>
                <span className={styles.notificationCopy}>
                  <strong>
                    {actorName} published {title}
                  </strong>
                  <small>
                    New {creationTypeLabels[creation.creationType]}
                    <span aria-hidden> · </span>
                    <time dateTime={item.createdAt}>{relative(item.createdAt)}</time>
                  </small>
                </span>
                {/* State in words as well as in the mark, so unread is never
                    carried by a coloured pixel alone. */}
                {!item.read && <>
                  <span className={styles.notificationDot} aria-hidden />
                  <span className={styles.srOnly}>Unread</span>
                </>}
              </Link>
              {/* A sibling of the row's link rather than a child: an anchor
                  cannot contain an anchor, and the creator is a second
                  destination worth having. */}
              {profile && <Link className={styles.notificationCreator} href={profile} aria-label={`Open ${actorName}'s creator profile`}>
                <Users size={13} aria-hidden />
              </Link>}
            </li>;
          })}
        </ul>}

        {hasMore && <button
          className={`${uiStyles.button} ${uiStyles.secondary}`}
          style={{ justifySelf: "start" }}
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >{loadingMore ? "Loading…" : "Load older"}</button>}

        {items && items.length > 0 && !hasMore && <p className={styles.quiet}>
          <Sparkles size={12} aria-hidden style={{ verticalAlign: "-1px", marginRight: 5 }} />
          That is everything.
        </p>}

        {/*
          * Discovery through the SHELL, not through the address bar.
          *
          * This was a `<Link href="/">`. The shell renders several surfaces
          * from one route and reads its view once, on the first render, so a
          * client-side navigation to `/` from `/?view=notifications` changed
          * the URL and nothing else: the reader stayed on an empty
          * notifications list looking at a button that appeared to do nothing.
          * `useShellNav` is the same `goToView` every sidebar item uses, so
          * this gets the same history entry and the same result.
          */}
        {items?.length === 0 && <button type="button" className={styles.profileLink} onClick={() => openView("home")}>
          <Compass size={14} aria-hidden />Find creators to follow
        </button>}
      </div>
    </div>
  </section>;
}
