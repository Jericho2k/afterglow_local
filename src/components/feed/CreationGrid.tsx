"use client";

import type { ReactNode } from "react";
import type { CreationSummary } from "@/lib/types";
import { CreationCard } from "./CreationCard";
import styles from "./feed.module.css";

/**
 * The grid every discovery surface shares.
 *
 * Two columns on a phone, container-driven density above it. Cards stretch to
 * the tallest in their row and pin their metrics to the bottom, so a one-line
 * title and a two-line title sit in an aligned row without either card growing
 * a blank region to pad itself out.
 */
export function CreationGrid({ creations, onToggleSave, priorityCount = 4, children }: {
  creations: CreationSummary[];
  /** Called with the creation whose save state should flip. */
  onToggleSave: (creation: CreationSummary) => void;
  /** How many covers load eagerly. Roughly the first visible rows. */
  priorityCount?: number;
  children?: ReactNode;
}) {
  return <div className={styles.grid}>
    {creations.map((creation, index) => <CreationCard
      key={creation.id}
      creation={creation}
      priority={index < priorityCount}
      // Saving your own creation is not a thing the backend allows, so the
      // owner's card simply has no save control rather than a failing one.
      onToggleSave={creation.ownedByViewer ? undefined : onToggleSave}
    />)}
    {children}
  </div>;
}

/**
 * Placeholders with the card's real proportions, laid out in the real grid, so
 * the first paint and the loaded feed occupy the same space and nothing jumps.
 */
export function CreationGridSkeleton({ count = 6 }: { count?: number }) {
  return <div className={styles.grid} aria-hidden>
    {Array.from({ length: count }, (_, index) => <div key={index} className={`${styles.skeleton} ${styles.shimmer}`}>
      <div className={styles.skeletonCover} />
      <div className={styles.skeletonCopy}>
        <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
        <div className={`${styles.skeletonLine} ${styles.skeletonLineTall}`} />
        <div className={styles.skeletonLine} />
      </div>
    </div>)}
  </div>;
}

/** A polished empty, error or end-of-list panel that spans the grid. */
export function FeedState({ icon, title, description, action }: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return <div className={styles.state} role="status">
    <span className={styles.stateIcon}>{icon}</span>
    <h2>{title}</h2>
    <p>{description}</p>
    {action && <button type="button" className={styles.stateAction} onClick={action.onClick}>{action.label}</button>}
  </div>;
}
