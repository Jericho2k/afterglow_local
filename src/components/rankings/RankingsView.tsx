"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, MessageCircle, Bookmark, Medal, Sparkles, TrendingUp, UserPlus, Users } from "lucide-react";
import { api } from "@/lib/api-client";
import { creationTitle, creationTypeLabels } from "@/lib/creation";
import { accentVariables, normalizeAccent } from "@/lib/accent";
import { compactCount, exactCount } from "@/lib/format";
import { creatorProfileHref, toggleCreatorFollow } from "@/lib/follows";
import { profileBorder, type ProfileBorder } from "@/lib/cosmetics";
import { overallBoardLabel, rankingCategoryLabel } from "@/lib/rankings";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import type { CreationSummary } from "@/lib/types";
import { CreatorAvatar } from "@/components/creator";
import { PageHeader, shellStyles } from "@/components/shell";
import { SelectField } from "@/components/ui";
import styles from "./rankings.module.css";

/**
 * Rankings.
 *
 * The sprint's requirement for this page is a product one rather than a visual
 * one: it must be a way IN. So every element on it is a destination —
 *
 *   the artwork and title open the creation,
 *   the byline opens the creator,
 *   a creator row opens their profile,
 *   their best creation opens that creation,
 *   and Follow works here exactly as it does everywhere else.
 *
 * There is deliberately no chart, no sparkline and no delta. Those would make
 * it a dashboard, and nobody discovers anything on a dashboard.
 *
 * The restraint on the medals is the other half. The top three get a warm mark
 * and everybody else gets a number in the same quiet type, because a page where
 * every row is gold is a page where nothing is.
 */

/**
 * `creator` is the byline's identity, read live on every request. It is
 * separate from `creation.creator` so a row always shows who the creator is
 * NOW — same handle, same picture, same ring as their own profile — rather
 * than whatever was true when the board was last rebuilt.
 */
type RankedCreation = {
  rank: number; rankTotal: number; userMessages: number; creation: CreationSummary;
  creator: { id: string; username: string; displayName: string; avatarPath: string; border: ProfileBorder } | null;
};

type RankedCreator = {
  rank: number; rankTotal: number;
  id: string; username: string; displayName: string; avatarPath: string; border: ProfileBorder;
  followers: number; messages: number; creations: number;
  viewerFollows: boolean; owner: boolean;
  topCreation: { id: string; title: string; avatarPath: string; avatarUrl: string; accent: string; messages: number } | null;
};

type CreationsPage = {
  board: "creations"; category: string; categories: string[];
  creations: RankedCreation[]; hasMore: boolean; nextOffset: number; total: number;
};
type CreatorsPage = { board: "creators"; creators: RankedCreator[]; hasMore: boolean; nextOffset: number; total: number };

type Board = "creations" | "creators";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map((word) => word[0]).join("").slice(0, 2).toUpperCase() || "?";
}

/** The mark beside a position. Only the top three get one. */
function medalTier(rank: number) {
  return rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "";
}

export function RankingsView({ onOpenMenu }: { onOpenMenu?: () => void }) {
  const [board, setBoard] = useState<Board>("creations");
  const [category, setCategory] = useState("");
  const [creations, setCreations] = useState<RankedCreation[] | null>(null);
  const [creators, setCreators] = useState<RankedCreator[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [page, setPage] = useState({ hasMore: false, nextOffset: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (target: { board: Board; category: string; offset: number }) => {
    const params = new URLSearchParams({ board: target.board });
    if (target.board === "creations" && target.category) params.set("category", target.category);
    if (target.offset) params.set("offset", String(target.offset));
    if (target.offset) setLoadingMore(true); else setLoading(true);
    setError("");
    try {
      if (target.board === "creators") {
        const data = await api<CreatorsPage>(`/api/rankings?${params}`);
        setCreators((current) => target.offset && current ? [...current, ...data.creators] : data.creators);
        setPage({ hasMore: data.hasMore, nextOffset: data.nextOffset, total: data.total });
      } else {
        const data = await api<CreationsPage>(`/api/rankings?${params}`);
        setCreations((current) => target.offset && current ? [...current, ...data.creations] : data.creations);
        setCategories(data.categories);
        setPage({ hasMore: data.hasMore, nextOffset: data.nextOffset, total: data.total });
      }
    } catch (reason) {
      if (!target.offset) { setCreations([]); setCreators([]); }
      setError(reason instanceof Error ? reason.message : "Rankings are unavailable right now");
    } finally { setLoading(false); setLoadingMore(false); }
  }, []);

  useEffect(() => { void load({ board, category, offset: 0 }); }, [board, category, load]);

  const rows = board === "creations" ? creations : creators;
  const boardLabel = board === "creations" ? rankingCategoryLabel(category) : "Creators";

  const lede = useMemo(() => board === "creators"
    ? "The creators whose published work readers are actually writing to, ordered by the messages they have received."
    : category
      ? `The most-read ${category} creations on Afterglow, ordered by the messages readers have sent them.`
      : "The most-read creations on Afterglow, ordered by the messages readers have sent them.",
  [board, category]);

  return <section className={shellStyles.page}>
    <div className={shellStyles.inner}>
      <PageHeader
        eyebrow="What people are actually using"
        title="Rankings"
        lede={lede}
        onOpenMenu={onOpenMenu}
      />

      <div className={styles.controls}>
        {/* Two boards, as a tablist, because there genuinely are two panels. */}
        <div className={styles.boards} role="tablist" aria-label="Rankings">
          {(["creations", "creators"] as Board[]).map((value) => <button
            key={value}
            role="tab"
            id={`board-${value}`}
            aria-selected={board === value}
            aria-controls={`panel-${value}`}
            tabIndex={board === value ? 0 : -1}
            className={board === value ? styles.boardActive : styles.board}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              const next: Board = board === "creations" ? "creators" : "creations";
              setBoard(next);
              document.getElementById(`board-${next}`)?.focus();
            }}
            onClick={() => setBoard(value)}
          >
            {value === "creations" ? <Sparkles size={14} aria-hidden /> : <Users size={14} aria-hidden />}
            {value === "creations" ? "Creations" : "Creators"}
          </button>)}
        </div>

        {/*
          * Categories are a picker, not a row of tabs.
          *
          * The controlled taxonomy has fifteen genres in it, and fifteen tabs
          * is a horizontal scroller nobody reaches the end of. The shared
          * picker keeps that taxonomy in one keyboard-operable control and
          * portals the menu clear of narrow-page clipping.
          */}
        {board === "creations" && <SelectField
          className={styles.categoryField}
          label="Ranking category"
          hideLabel
          compact
          value={category}
          onChange={setCategory}
          options={[
            { value: "", label: overallBoardLabel },
            ...categories.map((value) => ({ value, label: value })),
          ]}
        />}
      </div>

      {page.total > 0 && !loading && <p className={styles.fieldNote}>
        <TrendingUp size={12} aria-hidden />
        {board === "creators"
          ? `${exactCount(page.total)} ranked creators. Ordered by messages received, then followers, then saves.`
          : `${exactCount(page.total)} ranked creations in ${boardLabel}. Ordered by messages sent, then saves.`}
      </p>}

      <div id={`panel-${board}`} role="tabpanel" aria-labelledby={`board-${board}`}>
        {error && <p className={shellStyles.error}>{error}</p>}

        {loading && <ul className={styles.list}>
          {Array.from({ length: 6 }, (_, index) => <li key={index} className={styles.skeleton} aria-hidden />)}
        </ul>}

        {!loading && rows?.length === 0 && !error && <div className={shellStyles.emptyPanel}>
          <Medal size={26} aria-hidden />
          <h2>No board yet</h2>
          <p>
            {board === "creators"
              ? "Nobody has published anything public yet, so there is nothing to rank. Publish a creation and you will be on this page."
              : `Nothing published carries the ${boardLabel} tag yet. Try another category, or publish something that does.`}
          </p>
        </div>}

        {!loading && board === "creations" && creations && creations.length > 0 && <ol className={styles.list}>
          {creations.map((entry) => <RankedCreationRow key={entry.creation.id} entry={entry} category={category} />)}
        </ol>}

        {!loading && board === "creators" && creators && creators.length > 0 && <ol className={styles.list}>
          {creators.map((entry) => <RankedCreatorRow key={entry.id} entry={entry} onError={setNotice} />)}
        </ol>}

        {page.hasMore && !loading && <button
          className={styles.loadMore}
          disabled={loadingMore}
          onClick={() => void load({ board, category, offset: page.nextOffset })}
        >{loadingMore ? "Loading…" : "Show more"}</button>}
      </div>
    </div>

    {notice && <p className={styles.notice} role="status">{notice}</p>}
  </section>;
}

/**
 * One ranked creation.
 *
 * Two destinations in one row: the body opens the creation, the byline opens
 * its creator. The byline is a sibling of the body's link rather than a child
 * of it, because an anchor cannot contain an anchor and the creator is the
 * whole reason this page connects to anything.
 */
function RankedCreationRow({ entry, category }: { entry: RankedCreation; category: string }) {
  const creation = entry.creation;
  const title = creationTitle(creation);
  const artwork = avatarSource(characterAvatarBucket, creation.avatarPath, creation.avatarUrl);
  const tier = medalTier(entry.rank);
  /*
   * The creator's CURRENT identity, read live by the route rather than taken
   * from whatever the board was built with. Display name first because that is
   * the name a creator chose to be known by; the handle is the fallback and the
   * link target.
   */
  const identity = entry.creator ?? creation.creator ?? null;
  const creatorName = identity?.displayName || (identity?.username ? `@${identity.username}` : "");
  const creatorHref = creatorProfileHref(identity?.username);
  // The category this row is being ranked within, when it is not Overall.
  const shown = category || creation.tags.find((tag) => tag === category) || "";

  return <li
    className={`${styles.row} ${tier ? styles[tier] : ""}`}
    style={{ ...accentVariables(creation.accent), "--accent-card": normalizeAccent(creation.accent) } as React.CSSProperties}
  >
    <Link className={styles.rowMain} href={`/characters/${creation.id}`}>
      <span className={styles.position}>
        {tier && <Medal size={15} aria-hidden />}
        <strong>{entry.rank}</strong>
        <span className={shellStyles.srOnly}>
          {`Number ${entry.rank} of ${exactCount(entry.rankTotal)}${shown ? ` in ${shown}` : " overall"}`}
        </span>
      </span>

      <span className={styles.art}>
        {artwork ? <img src={artwork} alt="" loading="lazy" decoding="async" /> : <span aria-hidden>{initials(title)}</span>}
      </span>

      <span className={styles.rowCopy}>
        <strong>{title}</strong>
        <span className={styles.rowMeta}>
          <em>{creationTypeLabels[creation.creationType]}</em>
          {shown && <em className={styles.rowCategory}>{shown}</em>}
        </span>
        <span className={styles.rowMetrics}>
          <span title={`${exactCount(entry.userMessages)} messages sent`}>
            <MessageCircle size={12} aria-hidden />{compactCount(entry.userMessages)}
            <span className={shellStyles.srOnly}> messages sent</span>
          </span>
          <span title={`${exactCount(creation.saveCount)} saves`}>
            <Bookmark size={12} aria-hidden />{compactCount(creation.saveCount)}
            <span className={shellStyles.srOnly}> saves</span>
          </span>
        </span>
      </span>
      <ArrowUpRight className={styles.rowArrow} size={16} aria-hidden />
    </Link>

    {creatorName && (creatorHref
      ? <Link className={styles.rowCreator} href={creatorHref} aria-label={`Open ${creatorName}'s creator profile`}>
        <CreatorAvatar avatarPath={identity?.avatarPath ?? ""} name={creatorName} border={entry.creator?.border ?? profileBorder("default")} size={20} />
        <span>{creatorName}</span>
        {identity?.username && identity.displayName && <em>@{identity.username}</em>}
      </Link>
      : <span className={styles.rowCreator}>
        <CreatorAvatar avatarPath={identity?.avatarPath ?? ""} name={creatorName} border={entry.creator?.border ?? profileBorder("default")} size={20} />
        <span>{creatorName}</span>
      </span>)}
  </li>;
}

/** One ranked creator. The row opens the profile; Follow is the shared primitive. */
function RankedCreatorRow({ entry, onError }: { entry: RankedCreator; onError: (message: string) => void }) {
  const [following, setFollowing] = useState(entry.viewerFollows);
  const [followers, setFollowers] = useState(entry.followers);
  const [pending, setPending] = useState(false);
  const name = entry.displayName || `@${entry.username}`;
  const tier = medalTier(entry.rank);
  const href = creatorProfileHref(entry.username);
  const top = entry.topCreation;
  const topArt = top ? avatarSource(characterAvatarBucket, top.avatarPath, top.avatarUrl) : "";

  const follow = useCallback(async () => {
    if (pending) return;
    setPending(true);
    const failure = await toggleCreatorFollow({ username: entry.username, following, followers }, (state) => {
      setFollowing(state.following);
      setFollowers(state.followers);
    });
    if (failure) onError(failure);
    setPending(false);
  }, [entry.username, following, followers, pending, onError]);

  return <li className={`${styles.row} ${styles.creatorRow} ${tier ? styles[tier] : ""}`}>
    <Link className={styles.rowMain} href={href || "#"} aria-label={`Open ${name}'s creator profile`}>
      <span className={styles.position}>
        {tier && <Medal size={15} aria-hidden />}
        <strong>{entry.rank}</strong>
        <span className={shellStyles.srOnly}>{`Number ${entry.rank} of ${exactCount(entry.rankTotal)} creators`}</span>
      </span>

      <CreatorAvatar
        avatarPath={entry.avatarPath}
        name={name}
        border={entry.border ?? profileBorder("default")}
        size={44}
        verified
      />

      <span className={styles.rowCopy}>
        <strong>{name}</strong>
        <span className={styles.rowMeta}><em>@{entry.username}</em></span>
        <span className={styles.rowMetrics}>
          <span title={`${exactCount(followers)} followers`}>
            <Users size={12} aria-hidden />{compactCount(followers)}
            <span className={shellStyles.srOnly}> followers</span>
          </span>
          <span title={`${exactCount(entry.messages)} messages received`}>
            <MessageCircle size={12} aria-hidden />{compactCount(entry.messages)}
            <span className={shellStyles.srOnly}> messages received</span>
          </span>
          <span title={`${exactCount(entry.creations)} published creations`}>
            <Sparkles size={12} aria-hidden />{compactCount(entry.creations)}
            <span className={shellStyles.srOnly}> published creations</span>
          </span>
        </span>
      </span>
    </Link>

    <div className={styles.creatorAside}>
      {/* Their best work, as a second destination. A creator row that only
          opened a profile would make the page one tap longer than it needs to
          be for the thing somebody is actually looking for. */}
      {top && <Link className={styles.topCreation} href={`/characters/${top.id}`} title={`${top.title} — ${exactCount(top.messages)} messages`}>
        <span className={styles.topArt}>
          {topArt ? <img src={topArt} alt="" loading="lazy" /> : <span aria-hidden>{initials(top.title)}</span>}
        </span>
        <span className={styles.topCopy}>
          <small>Most read</small>
          <strong>{top.title}</strong>
        </span>
      </Link>}

      {!entry.owner && entry.username && <button
        type="button"
        className={`${styles.followButton} ${following ? styles.followingButton : ""}`}
        onClick={() => void follow()}
        disabled={pending}
        aria-pressed={following}
        aria-label={following ? `Stop following ${name}` : `Follow ${name}`}
      >
        {following ? <><Check size={13} aria-hidden />Following</> : <><UserPlus size={13} aria-hidden />Follow</>}
      </button>}
    </div>
  </li>;
}
