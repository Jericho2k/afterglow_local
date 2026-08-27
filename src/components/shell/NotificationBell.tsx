"use client";

import { Bell } from "lucide-react";
import { unreadCap, unreadLabel } from "@/lib/notifications";
import { useUnreadNotifications } from "@/lib/notification-state";
import { iconButtonClass } from "@/components/ui";
import { useShellNav } from "./ShellNav";
import styles from "./shell.module.css";

/**
 * The bell.
 *
 * One control, in the header of every shell surface, so "did anything happen"
 * is answerable from wherever somebody is rather than only from a menu they
 * have to open first.
 *
 * The dot is small on purpose. A count in a red circle is a demand; a dot is a
 * fact, and this product notifies people about a creator publishing a
 * character, which is good news rather than an obligation.
 *
 * Nothing here is communicated by colour alone: the accessible name says how
 * many are unread, and the count is spelled out for a screen reader even though
 * only the dot is drawn. A reader who cannot see the pink mark still hears
 * "Notifications, 3 unread".
 *
 * It costs no request of its own — see src/lib/notification-state.ts, where one
 * shared count serves every bell that mounts.
 */
export function NotificationBell({ className }: { className?: string }) {
  const { openView } = useShellNav();
  const { unread } = useUnreadNotifications();
  const label = unread > 0
    ? `Notifications, ${unread > unreadCap ? `more than ${unreadCap}` : unread} unread`
    : "Notifications";

  return <button
    type="button"
    className={iconButtonClass("default", [styles.bell, className].filter(Boolean).join(" "))}
    aria-label={label}
    title={label}
    onClick={() => openView("notifications")}
  >
    <Bell size={18} aria-hidden />
    {unread > 0 && <>
      <span className={styles.bellDot} aria-hidden />
      <span className={styles.srOnly}>{unreadLabel(unread)} unread</span>
    </>}
  </button>;
}
