"use client";

import Link from "next/link";
import { Globe2, Sparkles } from "lucide-react";
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
  description: string;
  coverPath: string;
  coverUrl: string;
  content?: string;
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

  return <article className={`${styles.card} ${variant === "feature" ? styles.feature : styles.attached} ${className}`}>
    <Link href={`/worlds/${world.id}`} className={styles.link}>
      <span className={styles.media}>
        {cover
          ? <img src={cover} alt="" loading="lazy" />
          : <span className={styles.fallback}><Globe2 size={variant === "feature" ? 46 : 34} aria-hidden /></span>}
      </span>
      <span className={styles.copy}>
        {/* The fade lives inside the copy so it is exactly as tall as the text
            it exists to carry, and it is a layer over the artwork rather than a
            filter on it: the uploaded image is never altered, only overlaid. */}
        <span className={styles.scrim} aria-hidden />
        <strong className={styles.name}>{world.name}<Sparkles size={variant === "feature" ? 15 : 14} aria-hidden /></strong>
        {world.description && <span className={styles.description}>{world.description}</span>}
        {meta && <span className={styles.meta}>{meta}</span>}
      </span>
    </Link>
    {action && <div className={styles.action}>{action}</div>}
  </article>;
}
