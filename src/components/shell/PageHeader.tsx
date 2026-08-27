"use client";

import type { ReactNode } from "react";
import { AppMenuButton } from "@/components/ui";
import { NotificationBell } from "./NotificationBell";
import styles from "./shell.module.css";

/**
 * The heading every shell page wears.
 *
 * The menu control belongs here rather than floating over the content. The
 * floating one it replaces was declared only inside two media queries, so
 * above 760px it had no `display` at all and rendered inline in normal flow;
 * and on the Worlds page it appeared beside the page's own menu button, giving
 * two hamburgers a few pixels apart. One control, in the header, in the flow.
 */
export function PageHeader({ eyebrow, title, lede, onOpenMenu, actions }: {
  eyebrow?: string;
  title: string;
  lede?: string;
  /** Rendered only where the sidebar is not already on screen. */
  onOpenMenu?: () => void;
  actions?: ReactNode;
}) {
  return <header className={styles.header}>
    {onOpenMenu && <AppMenuButton className={styles.menuButton} onOpen={onOpenMenu} />}
    <div className={styles.headerCopy}>
      {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
      <h1 className={styles.title}>{title}</h1>
      {lede && <p className={styles.lede}>{lede}</p>}
    </div>
    {/* The bell rides in every page header rather than in a chrome layer of
        its own, for the same reason the menu control does: this shell has one
        header per surface and adding a second bar above it would be a second
        thing to keep in step. It costs no request — one shared count serves
        every bell that mounts. */}
    <div className={styles.headerActions}>
      {actions}
      <NotificationBell />
    </div>
  </header>;
}
