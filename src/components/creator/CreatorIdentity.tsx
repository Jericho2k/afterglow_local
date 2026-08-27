"use client";

import type { ReactNode } from "react";
import { Crown, Flame, Globe2, Heart, Medal, MessageCircle, Sparkles, Star } from "lucide-react";
import type { AchievementState } from "@/lib/achievements";
import { borderVariables, type ProfileBorder } from "@/lib/cosmetics";
import { avatarSource, profileAvatarBucket } from "@/lib/storage";
import { compactCount, exactCount } from "@/lib/format";
import styles from "./creator.module.css";

/**
 * The pieces of a creator's identity that appear in more than one place.
 *
 * A creator shows up on their own profile, on every creation page, and beside
 * anything they publish. Those surfaces are different sizes and different
 * densities, but the IDENTITY has to be the same object each time — the same
 * ring, the same medal, the same rule about when a rank is worth showing — or
 * it stops reading as a person and starts reading as decoration that varies.
 */

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

/**
 * A creator's avatar, wearing whatever ring they have earned.
 *
 * The border is drawn as a ring OUTSIDE the portrait rather than as a frame on
 * top of it. That is the whole restraint: a creator picked that picture, and a
 * cosmetic that covers part of it is a worse product than no cosmetic. The
 * default border is Afterglow's own gradient, so every avatar has one and none
 * of them is louder than the face inside it.
 */
export function CreatorAvatar({ avatarPath, name, border, size = 96, verified = false }: {
  avatarPath: string;
  name: string;
  border: ProfileBorder;
  size?: number;
  /** Whether to draw the badge a public username earns. */
  verified?: boolean;
}) {
  const source = avatarSource(profileAvatarBucket, avatarPath, "");
  return <span
    className={styles.avatarRing}
    style={{ ...borderVariables(border), "--avatar-size": `${size}px` } as React.CSSProperties}
    data-border={border.id}
  >
    <span className={styles.avatarInner}>
      {source
        ? <img src={source} alt={`${name}'s profile picture`} loading="lazy" decoding="async" />
        : <span aria-hidden className={styles.avatarFallback}>{initials(name)}</span>}
    </span>
    {verified && <span className={styles.verifiedDot} aria-hidden />}
  </span>;
}

/**
 * The rank medal.
 *
 * Shown on a creation page ONLY for the top 100, which is what makes it worth
 * seeing: a badge everybody has is a label, and a badge the top hundred
 * creators have is a distinction. `showFrom` is the threshold rather than a
 * hard-coded 100 so a creator's own profile can show its rank at any standing
 * without a second component that draws the same thing differently.
 *
 * The rank is spelled out in the accessible name as well as drawn, and the
 * medal carries a number rather than only a colour, so nothing here is
 * communicated by colour alone.
 */
export function RankMedal({ rank, total, showFrom = Infinity, compact = false }: {
  rank: number | null;
  total: number;
  /** Draw nothing unless the rank is at or better than this. */
  showFrom?: number;
  compact?: boolean;
}) {
  if (rank === null || rank > showFrom) return null;
  const tier = rank <= 10 ? "gold" : rank <= 100 ? "silver" : "quiet";
  const percentile = total > 0 ? Math.max(0.1, Math.round((rank / total) * 1000) / 10) : null;
  const label = percentile === null
    ? `Ranked number ${exactCount(rank)} among Afterglow creators`
    : `Ranked number ${exactCount(rank)} of ${exactCount(total)} Afterglow creators, top ${percentile}%`;
  return <span className={`${styles.medal} ${styles[tier]} ${compact ? styles.medalCompact : ""}`} title={label}>
    <Medal size={compact ? 12 : 14} aria-hidden />
    <strong>#{exactCount(rank)}</strong>
    {!compact && <span>Creator</span>}
    <span className={styles.srOnly}>{label}</span>
  </span>;
}

/** How a rank reads in words: "Top 0.8%", or nothing when it cannot be said. */
export function rankSummary(rank: number | null, total: number) {
  if (rank === null || total <= 0) return "";
  const percentile = (rank / total) * 100;
  if (percentile < 0.1) return "Top 0.1%";
  return `Top ${percentile < 1 ? percentile.toFixed(1) : Math.round(percentile)}%`;
}

const achievementIcons = {
  heart: Heart, message: MessageCircle, flame: Flame, star: Star,
  crown: Crown, globe: Globe2, medal: Medal, sparkle: Sparkles,
} as const;

/**
 * One achievement.
 *
 * A locked one is drawn in the same shape and dimmed rather than hidden, so a
 * creator can see what is ahead of them — and it says "Locked" in its
 * accessible name rather than relying on the opacity, which a reader who
 * cannot see it would otherwise have no way to know.
 */
export function AchievementBadge({ achievement, showLocked = false }: {
  achievement: AchievementState;
  showLocked?: boolean;
}) {
  if (!achievement.unlocked && !showLocked) return null;
  const Icon = achievementIcons[achievement.icon] ?? Sparkles;
  return <li className={`${styles.badge} ${achievement.unlocked ? "" : styles.badgeLocked}`}>
    <span className={styles.badgeMark} aria-hidden>
      <Icon size={22} />
      {achievement.unlocked && <em className={styles.badgeCheck}>✓</em>}
    </span>
    <strong>{achievement.title}</strong>
    <small>{achievement.description}</small>
    <span className={styles.srOnly}>{achievement.unlocked ? "Unlocked" : "Locked"}</span>
  </li>;
}

/** A number with its label, as the profile's header row draws it. */
export function CreatorStat({ icon, label, value, hint }: {
  icon: ReactNode;
  label: string;
  value: number;
  hint?: string;
}) {
  return <div className={styles.stat}>
    <span className={styles.statIcon} aria-hidden>{icon}</span>
    <span className={styles.statBody}>
      <strong title={exactCount(value)}>{compactCount(value)}</strong>
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </span>
  </div>;
}

export { styles as creatorStyles };
