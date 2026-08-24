"use client";

import Link from "next/link";
import { Bookmark, Globe2, Lock, Sparkles } from "lucide-react";
import { avatarSource, worldCoverBucket } from "@/lib/storage";
import styles from "./world.module.css";

/**
 * A world, wherever a world is shown.
 *
 * Worlds appear in two places — attached to a creation, and on the Worlds page
 * — and they are the same thing in both, so they are the same card in both.
 * The variants change the size and what sits beside the title, never the
 * visual language: cover art, serif title, tagline, and a fade that carries the
 * text without hiding the artwork.
 *
 * Everything is a link to the world's own page. A world belongs to itself
 * rather than to whichever creation happens to reference it, so opening one
 * always lands in the same place.
 */

export type WorldCardWorld = {
  id: string;
  name: string;
  /** Absent for a locked world, which carries no description to show. */
  description?: string;
  coverPath: string;
  coverUrl: string;
  content?: string;
  /**
   * A world this viewer may not open.
   *
   * A public creation may be built on a private world, and hiding that would
   * misrepresent the creation — so the card is shown with its identity and
   * without its content, and it is not a link. The data behind it is already
   * reduced to a name and a cover by the time it reaches here; this only
   * decides how that reads.
   */
  locked?: boolean;
};

export function WorldCard({ world, variant = "attached", meta, action, className = "" }: {
  world: WorldCardWorld;
  /**
   * `attached` is the card inside a creation, sized to sit in a column of
   * sections. `feature` is the Worlds page, where the card is the content.
   */
  variant?: "attached" | "feature";
  /** Existing metadata for this surface — canon length, how many creations use it. */
  meta?: React.ReactNode;
  /** An owner-only control, rendered above the link rather than inside it. */
  action?: React.ReactNode;
  className?: string;
}) {
  const cover = avatarSource(worldCoverBucket, world.coverPath, world.coverUrl);
  const locked = Boolean(world.locked);

  const body = <>
    <span className={styles.media}>
      {cover
        ? <img src={cover} alt="" loading="lazy" />
        : <span className={styles.fallback}><Globe2 size={variant === "feature" ? 46 : 34} aria-hidden /></span>}
      {/* A locked world keeps its artwork and loses its way in. The lock is
          the app's own icon rather than an emoji, and it sits on the art so
          the card reads as deliberate rather than as a failed link. */}
      {locked && <span className={styles.lockBadge} aria-hidden><Lock size={13} /></span>}
    </span>
    <span className={styles.copy}>
      {/* The fade lives inside the copy so it is exactly as tall as the text
          it exists to carry, and it is a layer over the artwork rather than a
          filter on it: the uploaded image is never altered, only overlaid. */}
      <span className={styles.scrim} aria-hidden />
      <strong className={styles.name}>
        {world.name}
        {locked ? <Lock size={variant === "feature" ? 14 : 13} aria-hidden /> : <Sparkles size={variant === "feature" ? 15 : 14} aria-hidden />}
      </strong>
      {locked
        ? <span className={styles.lockedNote}>Private world<span className={styles.srOnly}>, not available to open</span></span>
        : world.description && <span className={styles.description}>{world.description}</span>}
      {meta && !locked && <span className={styles.meta}>{meta}</span>}
    </span>
  </>;

  return <article className={`${styles.card} ${variant === "feature" ? styles.feature : styles.attached} ${locked ? styles.locked : ""} ${className}`}>
    {locked
      // Not a link, not focusable, and carrying nothing to navigate to. The
      // absence of an href is the enforcement, not a click handler that
      // declines.
      ? <span className={styles.link}>{body}</span>
      : <Link href={`/worlds/${world.id}`} className={styles.link}>{body}</Link>}
    {action && <div className={styles.action}>{action}</div>}
  </article>;
}

/** The save control a world card carries where saving is offered. */
export function WorldSaveButton({ saved, count, onToggle, name }: {
  saved: boolean;
  count: number;
  onToggle: () => void;
  name: string;
}) {
  return <button
    type="button"
    className={`${styles.saveButton} ${saved ? styles.saveButtonSaved : ""}`}
    aria-pressed={saved}
    aria-label={saved ? `Remove ${name} from your saved worlds` : `Save ${name}`}
    onClick={onToggle}
  >
    <Bookmark size={15} fill={saved ? "currentColor" : "none"} aria-hidden />
    <span>{count > 0 ? count.toLocaleString() : "Save"}</span>
  </button>;
}
