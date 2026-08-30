"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BadgeCheck, CalendarDays, Globe2, MessageCircle, Pencil, Share2, Sparkles, TrendingUp, Users, X } from "lucide-react";
import type { AchievementState } from "@/lib/achievements";
import { profileBorder, type ProfileBorder } from "@/lib/cosmetics";
import type { CreationSummary, WorldSummary } from "@/lib/types";
import { creationTitle } from "@/lib/creation";
import { compactCount, exactCount } from "@/lib/format";
import { toggleCreationSave } from "@/lib/saves";
import { toggleCreatorFollow } from "@/lib/follows";
import { shareLink, shareMessage } from "@/lib/share";
import { avatarSource, characterAvatarBucket, profileAvatarBucket } from "@/lib/storage";
import { backFallbacks } from "@/lib/back-navigation";
import { BackButton } from "@/components/nav";
import { iconButtonClass, SelectField } from "@/components/ui";
import { CreationGrid, CreationGridSkeleton } from "@/components/feed";
import { WorldCard } from "@/components/world";
import { AchievementBadge, CreatorAvatar, CreatorStat, RankMedal, rankSummary } from "@/components/creator";
import styles from "./profile.module.css";

/**
 * A creator's public page.
 *
 * The information architecture is the reference design's, and the numbers on it
 * are the product's own: followers, messages received and published creations,
 * a real rank with a real percentile, achievements earned from those same
 * figures, and a history derived from timestamps that actually exist. Nothing
 * here is a placeholder, and a figure the backend cannot answer is absent
 * rather than shown as zero.
 *
 * The layout is one column that becomes two. Everything a visitor came for —
 * who this is, what they made — stays in the primary column at every width;
 * the standing, the history and the top characters are context, so on a phone
 * they sit below the work rather than above it, and on a desktop they move into
 * a side column instead of being cut.
 */

type TopCharacter = {
  id: string; name: string; title: string;
  creationType: CreationSummary["creationType"]; profileType: CreationSummary["profileType"];
  avatarUrl: string; avatarPath: string; accent: string; messages: number;
};

type ActivityEvent = {
  id: string;
  kind: string;
  title: string;
  subject: string;
  avatarPath: string;
  avatarUrl: string;
  href: string;
  occurredAt: string;
};

type Payload = {
  profile: {
    id: string; username: string; displayName: string; avatarPath: string; bio: string;
    coverPath: string; profileBorder: string; createdAt: string;
  };
  owner: boolean;
  viewerFollows: boolean;
  stats: { followers: number; following: number; messages: number; creations: number; worlds: number; saves: number };
  rank: { position: number | null; total: number; percentile: number | null };
  border: ProfileBorder;
  achievements: AchievementState[];
  featured: AchievementState[];
  creations: CreationSummary[];
  worlds: WorldSummary[];
  topCharacters: TopCharacter[];
  activity: ActivityEvent[];
};

type Tab = "creations" | "worlds" | "about";
type Sort = "popular" | "newest";
type Filter = "all" | "character" | "cast" | "scenario";

const tabs: { id: Tab; label: string }[] = [
  { id: "creations", label: "Creations" },
  { id: "worlds", label: "Worlds" },
  { id: "about", label: "About" },
];

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "character", label: "Characters" },
  { id: "cast", label: "Casts" },
  { id: "scenario", label: "Scenarios" },
];

function relative(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function joined(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(new Date(value));
}

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export default function CreatorProfile({ username }: { username: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("creations");
  const [sort, setSort] = useState<Sort>("popular");
  const [filter, setFilter] = useState<Filter>("all");
  const [gridLoading, setGridLoading] = useState(false);
  const [following, setFollowing] = useState<boolean | null>(null);
  const [followers, setFollowers] = useState<number | null>(null);
  const [followPending, setFollowPending] = useState(false);
  const [notice, setNotice] = useState("");

  /**
   * One request for the whole page.
   *
   * Sort and filter are part of the request rather than a client-side re-sort,
   * because the grid is a page of results and re-ordering only what has already
   * arrived would silently show the wrong twenty-four creations.
   */
  useEffect(() => {
    let live = true;
    const first = payload === null;
    if (!first) setGridLoading(true);
    fetch(`/api/creators/${encodeURIComponent(username)}?sort=${sort}&filter=${filter}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not open this profile");
        if (!live) return;
        setPayload(body);
        setError("");
      })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "Could not open this profile"); })
      .finally(() => { if (live) setGridLoading(false); });
    return () => { live = false; };
    // `payload` is deliberately not a dependency: it is read only to tell a
    // first load from a re-sort, and depending on it would re-fetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, sort, filter]);

  const profile = payload?.profile;
  const border = useMemo(() => payload?.border ?? profileBorder("default"), [payload]);
  const isFollowing = following ?? payload?.viewerFollows ?? false;
  const followerCount = followers ?? payload?.stats.followers ?? 0;

  /**
   * Follow, through the one primitive.
   *
   * This used to be a hand-written optimistic dance, and there was a second
   * copy of it on the creation page. Two implementations of one control drift:
   * they disagree about what to do when the write fails, about whether to trust
   * their own arithmetic, and eventually about what Follow means. There is one
   * now, in src/lib/follows.ts, and every surface that offers Follow calls it.
   */
  const toggleFollow = useCallback(async () => {
    if (!profile || followPending) return;
    setFollowPending(true);
    const failure = await toggleCreatorFollow(
      { username: profile.username, following: isFollowing, followers: followerCount },
      (state) => { setFollowing(state.following); setFollowers(state.followers); },
    );
    if (failure) setNotice(failure);
    setFollowPending(false);
  }, [profile, isFollowing, followerCount, followPending]);

  const saveCreation = useCallback(async (creation: CreationSummary) => {
    const failure = await toggleCreationSave(
      { id: creation.id, savedByViewer: creation.savedByViewer, saveCount: creation.saveCount },
      (state) => setPayload((current) => current ? {
        ...current,
        creations: current.creations.map((item) => item.id === creation.id
          ? { ...item, savedByViewer: state.savedByViewer, saveCount: state.saveCount }
          : item),
      } : current),
    );
    if (failure) setNotice(failure);
  }, []);

  // The same primitive a creation uses: native share sheet where there is one,
  // clipboard otherwise, one message either way. See src/lib/share.ts.
  const share = useCallback(() => {
    void shareLink({ url: window.location.href, title: profile?.displayName || profile?.username || "Afterglow" })
      .then((outcome) => setNotice(shareMessage(outcome, "Profile")));
  }, [profile]);

  if (error && !payload) {
    return <main className={styles.state}>
      <Sparkles size={26} /><h1>Profile unavailable</h1><p>{error}</p>
      <Link href="/">Return to Afterglow</Link>
    </main>;
  }
  if (!payload || !profile) {
    return <main className={styles.state} aria-busy="true"><Sparkles size={26} className={styles.spin} /><h1>Opening profile</h1></main>;
  }

  const cover = avatarSource(profileAvatarBucket, profile.coverPath, "");
  const standing = rankSummary(payload.rank.position, payload.rank.total);
  const displayName = profile.displayName || `@${profile.username}`;

  return <main className={styles.page}>
    {/* The banner. A creator who has not chosen one gets Afterglow's own
        gradient rather than a grey rectangle: an empty profile should still
        look like somewhere, and a missing image is not a broken one. */}
    <header className={styles.hero}>
      <div className={styles.cover}>
        {cover
          ? <img src={cover} alt="" fetchPriority="high" decoding="async" />
          : <div className={styles.coverFallback} aria-hidden />}
        <div className={styles.coverScrim} />
      </div>

      <div className={styles.heroBar}>
        <BackButton className={iconButtonClass("media")} fallback={backFallbacks.creation} />
        <button className={iconButtonClass("media")} aria-label="Share this profile" title="Share profile" onClick={share}>
          <Share2 size={18} />
        </button>
      </div>

      <div className={styles.identity}>
        <CreatorAvatar avatarPath={profile.avatarPath} name={displayName} border={border} size={112} verified />
        <div className={styles.identityCopy}>
          <h1 className={styles.name}>
            {displayName}
            <BadgeCheck size={22} className={styles.verified} aria-label="Creator with a public profile" />
          </h1>
          <p className={styles.handle}>@{profile.username}</p>
          <div className={styles.identityBadges}>
            {standing && <span className={styles.standing}><TrendingUp size={12} aria-hidden />{standing} Creator</span>}
            <RankMedal rank={payload.rank.position} total={payload.rank.total} showFrom={100} compact />
          </div>
        </div>

        <div className={styles.identityActions}>
          {payload.owner
            ? <Link className={styles.primaryAction} href="/?view=profile"><Pencil size={16} />Edit profile</Link>
            : <button
                className={`${styles.primaryAction} ${isFollowing ? styles.followingAction : ""}`}
                onClick={() => void toggleFollow()}
                disabled={followPending}
                aria-pressed={isFollowing}
                aria-label={isFollowing ? `Stop following ${displayName}` : `Follow ${displayName}`}
              >
                {isFollowing ? <><BadgeCheck size={16} />Following</> : <><Users size={16} />Follow</>}
              </button>}
          <div className={styles.identityMeta}>
            <span><strong>{compactCount(payload.stats.following)}</strong> Following</span>
            <span><CalendarDays size={12} aria-hidden /> Joined {joined(profile.createdAt)}</span>
          </div>
        </div>
      </div>

      {profile.bio && <p className={styles.bio}>{profile.bio}</p>}
    </header>

    {/* The three numbers this product actually cares about. */}
    <section className={styles.stats} aria-label="Creator statistics">
      <CreatorStat icon={<Users size={17} />} label="Followers" value={followerCount} />
      <CreatorStat icon={<MessageCircle size={17} />} label="Messages" value={payload.stats.messages} />
      <CreatorStat icon={<Sparkles size={17} />} label="Creations" value={payload.stats.creations} />
    </section>

    {payload.featured.length > 0 && <section className={styles.achievements} aria-label="Achievements">
      <header className={styles.sectionHead}>
        <h2>Achievements</h2>
        <button className={styles.sectionLink} onClick={() => setTab("about")}>View all</button>
      </header>
      <ul className={styles.badgeRow}>
        {payload.featured.map((achievement) => <AchievementBadge key={achievement.id} achievement={achievement} />)}
      </ul>
    </section>}

    <div className={styles.body}>
      <div className={styles.primary}>
        <nav className={styles.tabs} role="tablist" aria-label="Profile sections">
          {tabs.map((item) => {
            const count = item.id === "creations" ? payload.stats.creations : item.id === "worlds" ? payload.stats.worlds : null;
            return <button
              key={item.id}
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={tab === item.id ? styles.tabActive : ""}
              onKeyDown={(event) => {
                // Arrow keys move between tabs, which is what a tablist is for.
                const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const next = tabs[(tabs.findIndex((entry) => entry.id === tab) + step + tabs.length) % tabs.length];
                setTab(next.id);
                document.getElementById(`tab-${next.id}`)?.focus();
              }}
              onClick={() => setTab(item.id)}
            >
              {item.label}{count ? <em>{count}</em> : null}
            </button>;
          })}
        </nav>

        {tab === "creations" && <section id="panel-creations" role="tabpanel" aria-labelledby="tab-creations">
          <div className={styles.controls}>
            <div className={styles.filterRow} role="group" aria-label="Filter creations">
              {filters.map((item) => <button
                key={item.id}
                className={filter === item.id ? styles.chipActive : styles.chip}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >{item.label}</button>)}
            </div>
            <SelectField
              className={styles.sortField}
              label="Sort creations"
              hideLabel
              compact
              value={sort}
              onChange={(value) => setSort(value as Sort)}
              options={[
                { value: "popular", label: "Most popular" },
                { value: "newest", label: "Newest" },
              ]}
            />
          </div>
          {gridLoading
            ? <CreationGridSkeleton count={6} />
            : payload.creations.length
              ? <CreationGrid creations={payload.creations} onToggleSave={(creation) => void saveCreation(creation)} />
              : <p className={styles.empty}>{filter === "all" ? "No published creations yet." : "Nothing published of this kind yet."}</p>}
        </section>}

        {tab === "worlds" && <section id="panel-worlds" role="tabpanel" aria-labelledby="tab-worlds">
          {payload.worlds.length
            ? <div className={styles.worldList}>
                {payload.worlds.map((world) => <WorldCard key={world.id} world={world} />)}
              </div>
            : <p className={styles.empty}>No published worlds yet.</p>}
        </section>}

        {tab === "about" && <section id="panel-about" role="tabpanel" aria-labelledby="tab-about" className={styles.about}>
          <div className={styles.card}>
            <h2>About {displayName}</h2>
            {profile.bio ? <p className={styles.prose}>{profile.bio}</p> : <p className={styles.empty}>This creator has not written a bio yet.</p>}
            <dl className={styles.facts}>
              <div><dt>Joined</dt><dd>{joined(profile.createdAt)}</dd></div>
              <div><dt>Published creations</dt><dd>{exactCount(payload.stats.creations)}</dd></div>
              <div><dt>Published worlds</dt><dd>{exactCount(payload.stats.worlds)}</dd></div>
              <div><dt>Saves received</dt><dd>{exactCount(payload.stats.saves)}</dd></div>
            </dl>
          </div>
          <div className={styles.card}>
            <h2>All achievements</h2>
            <p className={styles.quiet}>
              {payload.achievements.filter((achievement) => achievement.unlocked).length} of {payload.achievements.length} unlocked.
              Every one is earned from real followers, messages, published work or standing.
            </p>
            <ul className={styles.badgeGrid}>
              {payload.achievements.map((achievement) => <AchievementBadge key={achievement.id} achievement={achievement} showLocked />)}
            </ul>
          </div>
        </section>}

      </div>

      <aside className={styles.side} aria-label="Creator standing">
        {payload.rank.position !== null && <section className={styles.card}>
          <span className={styles.eyebrow}>Creator rank</span>
          <div className={styles.rankRow}>
            <span className={styles.rankMark} aria-hidden><TrendingUp size={26} /></span>
            <div>
              <strong className={styles.rankNumber}>#{exactCount(payload.rank.position)}</strong>
              {standing && <p className={styles.rankTier}>{standing}</p>}
              <p className={styles.quiet}>Among {exactCount(payload.rank.total)} published creators</p>
            </div>
          </div>
          <p className={styles.quiet}>
            Ranked by the messages readers have sent to published creations. Ties are broken by followers, then saves,
            then published creations.
          </p>
        </section>}

        {payload.activity.length > 0 && <section className={styles.card}>
          <header className={styles.sectionHead}>
            <h2>Recent activity</h2>
          </header>
          <ActivityList events={payload.activity} limit={5} />
        </section>}

        {payload.topCharacters.length > 0 && <section className={styles.card}>
          <header className={styles.sectionHead}>
            <h2>Top characters</h2>
            <button className={styles.sectionLink} onClick={() => { setTab("creations"); setSort("popular"); setFilter("all"); }}>View all</button>
          </header>
          <ol className={styles.topList}>
            {payload.topCharacters.map((character, index) => {
              const portrait = avatarSource(characterAvatarBucket, character.avatarPath, character.avatarUrl);
              const title = creationTitle(character);
              return <li key={character.id}>
                <Link href={`/characters/${character.id}`}>
                  <span className={styles.topRank} aria-hidden>{index + 1}</span>
                  <span className={styles.topAvatar}>
                    {portrait ? <img src={portrait} alt="" loading="lazy" /> : <span>{initials(title)}</span>}
                  </span>
                  <span className={styles.topCopy}>
                    <strong>{title}</strong>
                    <small title={`${exactCount(character.messages)} messages`}>{compactCount(character.messages)} messages</small>
                  </span>
                </Link>
              </li>;
            })}
          </ol>
        </section>}
      </aside>
    </div>

    {notice && <div className={styles.toast} role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} aria-hidden /></button></div>}
  </main>;
}

/**
 * The activity feed.
 *
 * Deliberately compact: a thumbnail where there is one, one line of what
 * happened, and a relative time. An event about a creation or a world links to
 * it; a milestone has nowhere to go and is not made into a dead link.
 */
function ActivityList({ events, limit }: { events: ActivityEvent[]; limit: number }) {
  const icons: Record<string, typeof Sparkles> = {
    creation_published: Sparkles, creation_updated: Pencil,
    world_published: Globe2, world_updated: Globe2,
    achievement: BadgeCheck, milestone: TrendingUp, rank: TrendingUp,
  };
  if (!events.length) return <p className={styles.empty}>Nothing public yet.</p>;
  return <ul className={styles.activity}>
    {events.slice(0, limit).map((event) => {
      const Icon = icons[event.kind] ?? Sparkles;
      const thumbnail = event.avatarPath || event.avatarUrl
        ? avatarSource(event.kind.startsWith("world") ? "world-covers" : characterAvatarBucket, event.avatarPath, event.avatarUrl)
        : "";
      const body = <>
        <span className={styles.activityMark}>
          {thumbnail ? <img src={thumbnail} alt="" loading="lazy" /> : <Icon size={15} aria-hidden />}
        </span>
        <span className={styles.activityCopy}>
          <strong>{event.subject ? `${event.title}: ${event.subject}` : event.title}</strong>
          <time dateTime={event.occurredAt}>{relative(event.occurredAt)}</time>
        </span>
      </>;
      return <li key={event.id}>
        {event.href ? <Link href={event.href}>{body}</Link> : <span className={styles.activityStatic}>{body}</span>}
      </li>;
    })}
  </ul>;
}
