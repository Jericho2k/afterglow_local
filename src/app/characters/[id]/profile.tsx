"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, BadgeCheck, Bookmark, ChevronDown, Globe2, Heart, Images,
  MessageCircle, MoreHorizontal, Share2, Sparkles, Tag, UserRound,
} from "lucide-react";
import type { Character, CharacterComment, World } from "@/lib/types";
import { avatarSource, characterAvatarBucket, profileAvatarBucket, worldCoverBucket } from "@/lib/storage";
import styles from "./profile.module.css";

type Detail = { character: Character; worlds: World[]; owner: boolean };

/**
 * Public character page.
 *
 * Sections are derived from what the creator actually supplied: a character
 * with no gallery, facts or world simply has a shorter page, and the section
 * navigation is built from the same list that renders, so the two can never
 * disagree about order or contents.
 */
function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}
function relative(value: string) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

export default function CharacterProfile({ characterId }: { characterId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [comments, setComments] = useState<CharacterComment[] | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState("");
  const [illuminated, setIlluminated] = useState("");
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const overviewRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    fetch(`/api/characters/${characterId}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not open this character");
        setDetail(body);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open this character"));
    fetch(`/api/comments?characterId=${characterId}`)
      .then(async (response) => (response.ok ? (await response.json()).comments : []))
      .then(setComments)
      .catch(() => setComments([]));
  }, [characterId]);

  const character = detail?.character;
  const worlds = useMemo(() => detail?.worlds ?? [], [detail]);

  const overview = useMemo(() => {
    if (!character) return "";
    // The public description only. Internal prompt engineering — response
    // directives, boundaries, example dialogue — never appears here.
    return [character.backstory, character.personality].map((part) => part.trim()).filter(Boolean).join("\n\n");
  }, [character]);

  useEffect(() => {
    const node = overviewRef.current;
    if (!node) return;
    setOverflowing(node.scrollHeight - node.clientHeight > 8);
  }, [overview, detail]);

  /**
   * The single source of truth for both the navigation and the body. A section
   * that has no content is absent from this list, so it cannot appear in the
   * navigation either.
   */
  const sections = useMemo(() => {
    if (!character) return [] as { id: string; label: string; icon: typeof Images }[];
    const available: { id: string; label: string; icon: typeof Images }[] = [];
    if (character.gallery.length) available.push({ id: "gallery", label: "Gallery", icon: Images });
    if (overview) available.push({ id: "overview", label: "Overview", icon: Sparkles });
    if (character.tags.length) available.push({ id: "tags", label: "Tags", icon: Tag });
    if (character.quickFacts.length) available.push({ id: "facts", label: "Quick facts", icon: BadgeCheck });
    if (character.creator) available.push({ id: "creator", label: "Creator", icon: UserRound });
    if (worlds.length) available.push({ id: "world", label: "World", icon: Globe2 });
    available.push({ id: "comments", label: "Comments", icon: MessageCircle });
    return available;
  }, [character, overview, worlds]);

  useEffect(() => {
    if (!sections.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: "-20% 0px -60%", threshold: [0, 0.25, 0.6] });
    sections.forEach(({ id }) => { const node = document.getElementById(id); if (node) observer.observe(node); });
    return () => observer.disconnect();
  }, [sections]);

  const navigate = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
    // A brief edge illumination on the target, then a smooth fade.
    setIlluminated(id);
    window.setTimeout(() => setIlluminated((current) => (current === id ? "" : current)), 1200);
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const response = await fetch("/api/conversations", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not start chat");
      router.push(`/?character=${characterId}&conversation=${body.conversation.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start chat");
      setStarting(false);
    }
  }, [characterId, router]);

  const toggleLike = useCallback(async () => {
    if (!character) return;
    const liked = Boolean(character.likedByViewer);
    const response = await fetch(liked ? `/api/likes?characterId=${character.id}` : "/api/likes", {
      method: liked ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(liked ? {} : { body: JSON.stringify({ characterId: character.id }) }),
    });
    if (!response.ok) return;
    setDetail((current) => current ? {
      ...current,
      character: {
        ...current.character,
        likedByViewer: !liked,
        likeCount: Math.max(0, (current.character.likeCount || 0) + (liked ? -1 : 1)),
        publicStats: {
          ...current.character.publicStats,
          likes: current.character.publicStats.likes === null ? null : Math.max(0, current.character.publicStats.likes + (liked ? -1 : 1)),
        },
      },
    } : current);
  }, [character]);

  const share = useCallback(() => {
    const url = window.location.href;
    if (navigator.share) { void navigator.share({ title: character?.name ?? "Afterglow", url }).catch(() => undefined); return; }
    void navigator.clipboard?.writeText(url).catch(() => undefined);
  }, [character]);

  const submitComment = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      const response = await fetch("/api/comments", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId, body }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not post that comment");
      setComments((current) => [payload.comment, ...(current ?? [])]);
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not post that comment");
    } finally { setPosting(false); }
  }, [characterId, draft]);

  if (error && !detail) return <main className={styles.state}><Sparkles size={26} /><h1>Character unavailable</h1><p>{error}</p><Link href="/">Return to Afterglow</Link></main>;
  if (!detail || !character) return <main className={styles.state}><Sparkles size={26} className={styles.spin} /><h1>Opening character</h1></main>;

  const image = avatarSource(characterAvatarBucket, character.avatarPath, character.avatarUrl);
  const creatorName = character.creator?.username ? `@${character.creator.username}` : character.creator?.displayName || "";
  const created = relative(character.createdAt);
  // Keep the verified badge glued to the final word of the name.
  const nameWords = character.name.trim().split(/\s+/);
  const nameLead = nameWords.slice(0, -1).join(" ");
  const nameTail = nameWords[nameWords.length - 1] ?? character.name;
  const stats = character.publicStats;
  const heroTags = character.tags.slice(0, 6);

  return <main className={styles.page} style={{ "--character-accent": character.accent } as React.CSSProperties}>
    <div className={styles.hero}>
      <div className={styles.heroMedia}>
        {image ? <img src={image} alt="" /> : <span className={styles.heroFallback}>{initials(character.name)}</span>}
        <div className={styles.heroScrim} />
      </div>

      <div className={styles.heroBar}>
        <Link href="/" className={styles.circleButton} aria-label="Back to Afterglow"><ArrowLeft size={18} /></Link>
        <div className={styles.heroBarActions}>
          {!detail.owner && <button className={styles.circleButton} aria-label={character.likedByViewer ? "Remove from favourites" : "Add to favourites"} onClick={() => void toggleLike()}>
            <Heart size={18} fill={character.likedByViewer ? "currentColor" : "none"} />
          </button>}
          <button className={styles.circleButton} aria-label="Share character" onClick={share}><Share2 size={18} /></button>
          {detail.owner && <Link href={`/characters/${character.id}/edit`} className={styles.circleButton} aria-label="Edit character"><MoreHorizontal size={18} /></Link>}
        </div>
      </div>

      <div className={styles.heroCopy}>
        <h1 className={styles.name}>
          {nameLead && `${nameLead} `}
          <span className={styles.nameTail}>
            {nameTail}
            {character.creator?.username && <BadgeCheck size={26} className={styles.verified} aria-label="Verified creator" />}
          </span>
        </h1>
        {character.tagline && <p className={styles.tagline}>{character.tagline}</p>}
        {heroTags.length > 0 && <ul className={styles.heroTags}>{heroTags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}
        <p className={styles.byline}>
          {creatorName && <><strong>{creatorName}</strong><span aria-hidden>·</span></>}
          {stats.chats !== null && <><span>{compact(stats.chats)} chats</span><span aria-hidden>·</span></>}
          <span>Created {created}</span>
        </p>

        <div className={styles.ctaRow}>
          <button className={styles.primaryCta} onClick={() => void start()} disabled={starting}>
            <Sparkles size={18} />{starting ? "Opening story…" : `Chat with ${character.name}`}
          </button>
          <button className={styles.ghostButton} aria-label="Save character" onClick={() => void toggleLike()}>
            <Bookmark size={18} fill={character.likedByViewer ? "currentColor" : "none"} />
          </button>
        </div>

        <dl className={styles.stats}>
          <Stat label={stats.rankCategory ? `in ${stats.rankCategory}` : "Rank"} value={stats.rank === null ? null : `#${stats.rank}`} />
          <Stat label="Messages" value={stats.messages === null ? null : compact(stats.messages)} />
          <Stat label="Likes" value={stats.likes === null ? null : compact(stats.likes)} />
          <Stat label="Chats" value={stats.chats === null ? null : compact(stats.chats)} />
        </dl>
      </div>
    </div>

    {sections.length > 1 && <nav className={styles.sectionNav} aria-label="Character sections">
      {sections.map((section) => {
        const Icon = section.icon;
        return <button key={section.id} className={active === section.id ? styles.navActive : ""} onClick={() => navigate(section.id)}>
          <Icon size={15} />{section.label}
        </button>;
      })}
    </nav>}

    <div className={styles.body}>
        {character.gallery.length > 0 && <section id="gallery" className={`${styles.card} ${illuminated === "gallery" ? styles.illuminate : ""}`}>
          <header><Images size={16} /><h2>Gallery</h2></header>
          <ul className={styles.gallery}>
            {character.gallery.map((item) => {
              const source = avatarSource(characterAvatarBucket, item.storagePath, item.externalUrl);
              return <li key={item.id}><img src={source} alt={item.caption} loading="lazy" /></li>;
            })}
          </ul>
        </section>}

        {overview && <section id="overview" className={`${styles.card} ${illuminated === "overview" ? styles.illuminate : ""}`}>
          <header><Sparkles size={16} /><h2>About {character.name}</h2></header>
          <p ref={overviewRef} className={`${styles.prose} ${expanded ? styles.proseOpen : ""}`}>{overview}</p>
          {(overflowing || expanded) && <button className={styles.showMore} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show less" : "Show more"}<ChevronDown size={15} className={expanded ? styles.flip : ""} />
          </button>}
        </section>}

        {character.tags.length > 0 && <section id="tags" className={`${styles.card} ${illuminated === "tags" ? styles.illuminate : ""}`}>
          <header><Tag size={16} /><h2>Tags</h2>{character.nsfwEnabled && <em className={styles.adultBadge}>18+</em>}</header>
          <ul className={styles.tagList}>{character.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>
          {character.nsfwEnabled && <p className={styles.adultNote}>This character may generate mature and explicit content.</p>}
        </section>}

        {character.quickFacts.length > 0 && <section id="facts" className={`${styles.card} ${illuminated === "facts" ? styles.illuminate : ""}`}>
          <header><BadgeCheck size={16} /><h2>Quick facts</h2></header>
          <dl className={styles.facts}>
            {character.quickFacts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
          </dl>
        </section>}

        {character.creator && <section id="creator" className={`${styles.card} ${styles.creatorCard} ${illuminated === "creator" ? styles.illuminate : ""}`}>
          <header><UserRound size={16} /><h2>Creator</h2></header>
          <div className={styles.creator}>
            <span className={styles.creatorAvatar}>
              {character.creator.avatarPath
                ? <img src={avatarSource(profileAvatarBucket, character.creator.avatarPath, "")} alt="" />
                : initials(character.creator.displayName || character.creator.username)}
            </span>
            <div>
              <strong>{character.creator.username ? `@${character.creator.username}` : character.creator.displayName}</strong>
              {character.creator.displayName && character.creator.username && <small>{character.creator.displayName}</small>}
            </div>
          </div>
          {character.creator.username && <Link className={styles.creatorLink} href={`/?view=creator&creator=${character.creator.username}`}>View creator</Link>}
        </section>}

        {worlds.length > 0 && <section id="world" className={`${styles.card} ${illuminated === "world" ? styles.illuminate : ""}`}>
          <header><Globe2 size={16} /><h2>World</h2></header>
          <div className={styles.worldList}>
            {worlds.map((world) => {
              const cover = avatarSource(worldCoverBucket, world.coverPath, world.coverUrl);
              return <Link key={world.id} href={`/worlds/${world.id}`} className={styles.worldCard}>
                {cover && <img src={cover} alt="" />}
                <div className={styles.worldScrim} />
                <div>
                  <strong>{world.name}<Sparkles size={14} /></strong>
                  {world.description && <p>{world.description}</p>}
                </div>
              </Link>;
            })}
          </div>
        </section>}

        <section id="comments" className={`${styles.card} ${illuminated === "comments" ? styles.illuminate : ""}`}>
          <header><MessageCircle size={16} /><h2>Comments</h2>{comments?.length ? <em className={styles.count}>{comments.length}</em> : null}</header>
          <div className={styles.composer}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={2000} placeholder={`Share what you think of ${character.name}…`} />
            <button className={styles.postButton} disabled={posting || !draft.trim()} onClick={() => void submitComment()}>{posting ? "Posting…" : "Post"}</button>
          </div>
          {comments === null && <p className={styles.quiet}>Loading comments…</p>}
          {comments?.length === 0 && <p className={styles.quiet}>No comments yet. Be the first.</p>}
          {comments && comments.length > 0 && <ul className={styles.comments}>
            {comments.map((comment) => <li key={comment.id}>
              <span className={styles.commentAvatar}>
                {comment.author?.avatarPath
                  ? <img src={avatarSource(profileAvatarBucket, comment.author.avatarPath, "")} alt="" />
                  : initials(comment.author?.displayName || comment.author?.username || "?")}
              </span>
              <div>
                <p className={styles.commentMeta}>
                  <strong>{comment.author?.username ? `@${comment.author.username}` : comment.author?.displayName || "Afterglow reader"}</strong>
                  <time>{relative(comment.createdAt)}</time>
                </p>
                <p className={styles.commentBody}>{comment.body}</p>
              </div>
            </li>)}
          </ul>}
        </section>
    </div>

    {error && <div className={styles.toast} role="status">{error}<button onClick={() => setError("")} aria-label="Dismiss">×</button></div>}
  </main>;
}

/** A metric with no backend answer yet renders as unavailable, never as zero. */
function Stat({ label, value }: { label: string; value: string | null }) {
  return <div className={styles.stat}>
    <dt>{label}</dt>
    <dd>{value ?? <span className={styles.unavailable}>—</span>}</dd>
  </div>;
}
