"use client";

import type { ReactNode } from "react";
import { AppMenuButton } from "@/components/ui";
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
    {actions && <div className={styles.headerActions}>{actions}</div>}
  </header>;
}
