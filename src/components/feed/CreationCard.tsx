"use client";

import { useState } from "react";
import Link from "next/link";
import { Bookmark, Compass, MessageCircle, Users } from "lucide-react";
import { accentVariables, normalizeAccent } from "@/lib/accent";
import { creationTitle, creationType } from "@/lib/creation";
import { compactCount, exactCount } from "@/lib/format";
import { avatarSource, characterAvatarBucket, profileAvatarBucket } from "@/lib/storage";
import { creatorProfileHref } from "@/lib/follows";
import type { CreationSummary } from "@/lib/types";
import styles from "./feed.module.css";

/**
 * A creation in the feed.
 *
 * The card represents a Creation, not a character. "Seraphine", "The Final
 * War" and "Medieval Fantasy World RP" all render through this one component,
 * and nothing here reads a primary character: the title comes from
 * `creationTitle`, the artwork from the creation's own cover, and a scenario
 * with no defined characters leaves no empty avatar slot behind because there
 * is no avatar slot to leave empty.
 *
 * The two public metrics are messages exchanged and saves. Both are global
 * totals the database already maintains; neither is the viewer's own activity,
 * and there is deliberately no like.
 */

/** Initials for a creation with no artwork. Taken from its title, which may be a phrase. */
function initials(title: string) {
  return title.split(/\s+/).filter(Boolean).map((word) => word[0]).join("").slice(0, 2).toUpperCase() || "?";
}

/** How many platform tags fit on one line without the card growing. */
const visibleTags = 2;

export function CreationCard({ creation, priority = false, onToggleSave }: {
  creation: CreationSummary;
  /** Above-the-fold cards load eagerly; everything else waits for the scroll. */
  priority?: boolean;
  /** Absent for a creation the viewer owns, which has nothing to save. */
  onToggleSave?: (creation: CreationSummary) => void;
}) {
  const [artworkFailed, setArtworkFailed] = useState(false);
  const title = creationTitle(creation);
  const type = creationType(creation);
  const cover = avatarSource(characterAvatarBucket, creation.avatarPath, creation.avatarUrl);
  const showCover = Boolean(cover) && !artworkFailed;
  const tags = creation.tags.slice(0, visibleTags);
  const overflow = creation.tags.length - tags.length;
  const creatorName = creation.creator?.username ? `@${creation.creator.username}` : creation.creator?.displayName || "";
  const creatorHref = creatorProfileHref(creation.creator?.username);
  const creatorAvatar = creation.creator?.avatarPath ? avatarSource(profileAvatarBucket, creation.creator.avatarPath, "") : "";
  const saved = creation.savedByViewer;

  // The creation's own accent, validated and derived. It tints the card's
  // edge and the gradient behind its artwork and nothing else — two cards
  // side by side must still read as one grid rather than as two themes.
  return <article className={styles.card} style={{ ...accentVariables(creation.accent), "--accent-card": normalizeAccent(creation.accent) } as React.CSSProperties}>
    {/*
      * The card body is not a link.
      *
      * It used to be, which meant the byline inside it could not be one either
      * — an anchor cannot contain an anchor — so the one place a reader meets a
      * creator most often was the one place their name did nothing. The title's
      * link now stretches over the whole card through a pseudo-element, and the
      * byline sits above it in the stacking order as a link of its own. One
      * link to the creation, one to its creator, and a tap anywhere else still
      * opens the creation.
      */}
    <div className={styles.cardBody}>
      <div className={styles.cover}>
        {showCover
          ? <img
              src={cover}
              alt=""
              loading={priority ? "eager" : "lazy"}
              decoding="async"
              fetchPriority={priority ? "high" : "low"}
              onError={() => setArtworkFailed(true)}
            />
          : <span className={styles.coverFallback} aria-hidden>{initials(title)}</span>}
        <div className={styles.coverScrim} />
        <div className={styles.coverBadges}>
          {creation.nsfwEnabled && <em className={`${styles.badge} ${styles.badgeAdult}`}>18+</em>}
          {/* The authoring structure, only where it tells a reader something:
              nobody needs a card to announce that a character is a character. */}
          {type === "cast" && <em className={styles.badge}><Users size={11} aria-hidden />Cast</em>}
          {type === "scenario" && <em className={styles.badge}><Compass size={11} aria-hidden />Scenario</em>}
        </div>
      </div>

      <div className={styles.copy}>
        {creatorName && (creatorHref
          ? <Link href={creatorHref} className={`${styles.byline} ${styles.bylineLink}`} aria-label={`Open ${creatorName}'s creator profile`}>
              {creatorAvatar && <img className={styles.bylineAvatar} src={creatorAvatar} alt="" loading="lazy" />}
              <span className={styles.bylineName}>by {creatorName}</span>
            </Link>
          : <span className={styles.byline}>
              {creatorAvatar && <img className={styles.bylineAvatar} src={creatorAvatar} alt="" loading="lazy" />}
              <span className={styles.bylineName}>by {creatorName}</span>
            </span>)}
        <h3 className={styles.cardTitle}>
          <Link href={`/characters/${creation.id}`} className={styles.cardLink}>{title}</Link>
        </h3>
        {creation.tagline && <p className={styles.tagline}>{creation.tagline}</p>}
        {tags.length > 0 && <ul className={styles.tags}>
          {tags.map((tag) => <li key={tag}>{tag}</li>)}
          {overflow > 0 && <li className={styles.tagMore}>+{overflow}</li>}
        </ul>}
        <div className={styles.metrics}>
          <span className={styles.metric} title={`${exactCount(creation.messageCount)} messages`}>
            <MessageCircle size={12} aria-hidden />
            <span>{compactCount(creation.messageCount)}</span>
            <span className={styles.srOnly}> messages</span>
          </span>
          <span className={`${styles.metric} ${saved ? styles.metricSaved : ""}`} title={`${exactCount(creation.saveCount)} saves`}>
            <Bookmark size={12} aria-hidden fill={saved ? "currentColor" : "none"} />
            <span>{compactCount(creation.saveCount)}</span>
            <span className={styles.srOnly}> saves</span>
          </span>
        </div>
      </div>
    </div>

    {/* A sibling of the link rather than a child of it: a button inside an
        anchor is invalid, and a tap on it must not also open the page. */}
    {onToggleSave && <button
      type="button"
      className={`${styles.saveButton} ${saved ? styles.saveButtonSaved : ""}`}
      aria-pressed={saved}
      aria-label={saved ? `Remove ${title} from your saved creations` : `Save ${title}`}
      onClick={() => onToggleSave(creation)}
    >
      <Bookmark size={17} fill={saved ? "currentColor" : "none"} aria-hidden />
    </button>}
  </article>;
}
