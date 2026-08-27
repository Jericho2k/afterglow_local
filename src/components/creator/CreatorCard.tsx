"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Pencil, Sparkles, UserPlus } from "lucide-react";
import type { ProfileBorder } from "@/lib/cosmetics";
import { compactCount, exactCount } from "@/lib/format";
import { creatorProfileHref, toggleCreatorFollow } from "@/lib/follows";
import { CreatorAvatar, RankMedal, rankSummary } from "./CreatorIdentity";
import styles from "./creator.module.css";

/**
 * Who made this, on every page that shows somebody's work.
 *
 * This exists because the creation page used to draw its own version of it,
 * inline, and only when a `creator` object happened to have resolved. It was
 * therefore missing for exactly the readers it was for: a creator without a
 * public handle had no readable profile row, so the join returned nothing to
 * visitors and the whole section disappeared — the creation looked anonymous to
 * everyone except the one person who already knew who made it.
 *
 * So it is a component, and it takes a card rather than a profile. The shape
 * below is the complete public summary: identity, standing, three real totals,
 * and one control. Nothing here is private, nothing is optional-until-it-is-not,
 * and a field the server could not answer renders as absent rather than as
 * zero.
 *
 * Deliberately NOT a profile. No achievements, no activity, no worlds, no
 * creations grid. All of that is one tap away on the page this links to, and
 * duplicating it here would make every creation page carry a second page.
 */

export type CreatorCardData = {
  id: string;
  /** Empty only for an account with no public profile yet. */
  username: string;
  displayName: string;
  avatarPath: string;
  border: ProfileBorder;
  followers: number;
  /** User messages sent to this creator's published creations. */
  messages: number;
  creations: number;
  rank: number | null;
  rankTotal: number;
  viewerFollows: boolean;
  owner: boolean;
};

export function CreatorCard({ creator, onError, onFollowChange }: {
  creator: CreatorCardData;
  /** Shown by the host page, which owns the toast. */
  onError?: (message: string) => void;
  onFollowChange?: (state: { following: boolean; followers: number }) => void;
}) {
  const [following, setFollowing] = useState(creator.viewerFollows);
  const [followers, setFollowers] = useState(creator.followers);
  const [pending, setPending] = useState(false);

  /**
   * One follow primitive, shared with the profile page and the rankings board.
   * See src/lib/follows.ts: flip immediately, settle on the server's count,
   * and put the original back exactly if the write failed.
   */
  const follow = useCallback(async () => {
    if (pending) return;
    setPending(true);
    const failure = await toggleCreatorFollow({ username: creator.username, following, followers }, (state) => {
      setFollowing(state.following);
      setFollowers(state.followers);
      onFollowChange?.(state);
    });
    if (failure) onError?.(failure);
    setPending(false);
  }, [creator.username, following, followers, pending, onError, onFollowChange]);

  const name = creator.displayName || (creator.username ? `@${creator.username}` : "Afterglow creator");
  const href = creatorProfileHref(creator.username);
  const standing = rankSummary(creator.rank, creator.rankTotal);

  const identity = <>
    <CreatorAvatar avatarPath={creator.avatarPath} name={name} border={creator.border} size={54} verified={Boolean(creator.username)} />
    <span className={styles.cardCopy}>
      <strong>{name}</strong>
      {creator.username && <small>@{creator.username}</small>}
      {/* Only the top hundred get the medal here. A badge every creator
          carries is a label; one the hundred most-read creators carry is
          worth noticing — so it is spelled out, "#42 Creator", rather than
          reduced to a number somebody has to interpret. */}
      <RankMedal rank={creator.rank} total={creator.rankTotal} showFrom={100} />
    </span>
  </>;

  return <div className={styles.card}>
    <div className={styles.cardHead}>
      {/* The identity itself is the link to the profile, which is where a
          reader expects to be able to tap. */}
      {href
        ? <Link className={styles.cardIdentity} href={href} aria-label={`Open ${name}'s creator profile`}>{identity}</Link>
        : <span className={styles.cardIdentity}>{identity}</span>}

      {/*
        * The owner gets a control too.
        *
        * Hiding the whole section from its creator on the grounds that they
        * already know who they are is what made this page inconsistent: the
        * layout has to be the same object for everybody, so the only thing
        * that changes is which action sits in it.
        */}
      {creator.owner
        ? <Link className={styles.cardAction} href="/?view=profile">
            <Pencil size={14} aria-hidden />Edit profile
          </Link>
        : creator.username
          ? <button
              type="button"
              className={`${styles.cardAction} ${following ? styles.cardActionOn : ""}`}
              onClick={() => void follow()}
              disabled={pending}
              aria-pressed={following}
              aria-label={following ? `Stop following ${name}` : `Follow ${name}`}
            >
              {following ? <><Check size={14} aria-hidden />Following</> : <><UserPlus size={14} aria-hidden />Follow</>}
            </button>
          : null}
    </div>

    <dl className={styles.cardStats}>
      <div><dt>Followers</dt><dd title={exactCount(followers)}>{compactCount(followers)}</dd></div>
      <div><dt>Messages</dt><dd title={exactCount(creator.messages)}>{compactCount(creator.messages)}</dd></div>
      <div><dt>Creations</dt><dd title={exactCount(creator.creations)}>{compactCount(creator.creations)}</dd></div>
    </dl>

    {href
      ? <Link className={styles.cardLink} href={href}>
          <Sparkles size={14} aria-hidden />
          <span>{creator.owner ? "View your public profile" : `See everything by ${name}`}</span>
          {standing && <em>{standing}</em>}
          <ArrowUpRight size={15} aria-hidden />
        </Link>
      : <p className={styles.cardQuiet}>This creator has not opened a public profile yet.</p>}
  </div>;
}
