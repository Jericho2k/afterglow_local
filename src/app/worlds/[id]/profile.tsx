"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bookmark, Compass, Globe2, Lock, MessageCircle, Pencil, Sparkles, Trash2, UserRound } from "lucide-react";
import { api } from "@/lib/api-client";
import { backFallbacks } from "@/lib/back-navigation";
import { avatarSource, profileAvatarBucket, worldCoverBucket } from "@/lib/storage";
import { toggleCreationSave } from "@/lib/saves";
import { toggleWorldSave } from "@/lib/world-saves";
import { compactCount } from "@/lib/format";
import type { CharacterComment, CreationSummary, World } from "@/lib/types";
import { BackButton, MoreMenu, type MoreMenuItem } from "@/components/nav";
import { iconButtonClass } from "@/components/ui";
import { CreationGrid } from "@/components/feed";
import { RichContent } from "@/components/rich";
import styles from "./profile.module.css";

type Detail = { world: World; owner: boolean; creations: CreationSummary[] };

/**
 * A world's own page.
 *
 * Built to the standard the creation page set without copying its structure,
 * because a world is a different kind of thing: it has no cast, no opening and
 * nothing to chat with. What it has is lore, the creations built on it, and
 * the person who wrote it — so the page is a hero, the canon, those creations,
 * the creator, and discussion.
 *
 * Every section is derived from what actually exists. A world with no lore, no
 * creations and no comments is simply a short page rather than a long one full
 * of empty panels.
 */
function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

function relative(value: string) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.floor(months / 12)} year${Math.floor(months / 12) === 1 ? "" : "s"} ago`;
}

export default function WorldProfile({ worldId }: { worldId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [comments, setComments] = useState<CharacterComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Detail>(`/api/worlds/${worldId}`)
      .then(setDetail)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open this world"));
    api<{ comments: CharacterComment[] }>(`/api/comments?worldId=${worldId}`)
      .then((data) => setComments(data.comments))
      .catch(() => setComments([]));
  }, [worldId]);

  /** Optimistic, reconciled with the server's own total, reverted on failure. */
  const toggleSave = useCallback(async () => {
    if (!detail) return;
    const failure = await toggleWorldSave(
      { id: detail.world.id, savedByViewer: detail.world.savedByViewer, saveCount: detail.world.saveCount },
      (state) => setDetail((current) => current ? { ...current, world: { ...current.world, ...state } } : current),
    );
    if (failure) setError(failure);
  }, [detail]);

  /**
   * Saving a creation from a world's page.
   *
   * The same optimistic write the feed performs, through the same relation.
   * A control that looked like Save and did nothing would be worse than no
   * control at all.
   */
  const saveCreation = useCallback(async (creation: CreationSummary) => {
    const failure = await toggleCreationSave(creation, (state) => setDetail((current) => current ? {
      ...current,
      creations: current.creations.map((item) => item.id === creation.id ? { ...item, ...state } : item),
    } : current));
    if (failure) setError(failure);
  }, []);

  const submitComment = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      const payload = await api<{ comment: CharacterComment }>("/api/comments", {
        method: "POST", body: JSON.stringify({ worldId, body }),
      });
      setComments((current) => [payload.comment, ...(current ?? [])]);
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not post that comment");
    } finally { setPosting(false); }
  }, [draft, worldId]);

  const remove = useCallback(async () => {
    if (!detail) return;
    const { world } = detail;
    if (!window.confirm(`Delete the world “${world.name}”?\n\nCreations using it are not deleted — they simply stop having this world attached. This cannot be undone.`)) return;
    try {
      await api(`/api/worlds/${world.id}`, { method: "DELETE" });
      router.replace(backFallbacks.worlds);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete this world");
    }
  }, [detail, router]);

  if (error && !detail) return <main className={styles.state}>
    <Globe2 size={26} /><h1>World unavailable</h1><p>{error}</p>
    <Link href={backFallbacks.worlds}>Return to Worlds</Link>
  </main>;
  if (!detail) return <main className={styles.state}><Globe2 size={26} className={styles.spin} /><h1>Opening world</h1></main>;

  const { world, owner, creations } = detail;
  const cover = avatarSource(worldCoverBucket, world.coverPath, world.coverUrl);
  const creatorName = world.creator?.username ? `@${world.creator.username}` : world.creator?.displayName || "";
  const menuItems: MoreMenuItem[] = owner ? [
    { label: "Edit world", icon: <Pencil size={16} aria-hidden />, onSelect: () => router.push(`/?view=worlds&editWorld=${world.id}`) },
    { label: "Delete world", icon: <Trash2 size={16} aria-hidden />, danger: true, onSelect: () => void remove() },
  ] : [];

  return <main className={styles.page}>
    <div className={styles.hero}>
      <div className={styles.heroMedia}>
        {cover ? <img src={cover} alt="" /> : <span className={styles.heroFallback}><Globe2 size={64} /></span>}
        <div className={styles.heroScrim} />
      </div>
      <div className={styles.heroBar}>
        <BackButton className={iconButtonClass("media")} fallback={backFallbacks.worlds} />
        <div className={styles.heroBarActions}>
          {/* Saving your own world is not a thing the backend allows, so the
              owner gets management rather than a control that would fail. */}
          {!owner && <button
            className={iconButtonClass("media")}
            aria-pressed={world.savedByViewer}
            aria-label={world.savedByViewer ? "Remove from your saved worlds" : "Save this world"}
            onClick={() => void toggleSave()}
          ><Bookmark size={18} fill={world.savedByViewer ? "currentColor" : "none"} /></button>}
          {menuItems.length > 0 && <MoreMenu className={iconButtonClass("media")} label={`More actions for ${world.name}`} items={menuItems} />}
        </div>
      </div>
      <div className={styles.heroCopy}>
        <span className={styles.kicker}><Sparkles size={13} />Reusable world</span>
        <h1>{world.name}</h1>
        {world.description && <p className={styles.tagline}>{world.description}</p>}
        <p className={styles.byline}>
          {creatorName && <><strong>{creatorName}</strong><span aria-hidden>·</span></>}
          {/* Visibility is shown to the owner, for whom it is a setting they
              manage. Everybody else is already looking at something published. */}
          {owner && <><span className={styles.visibility}>
            {world.visibility === "public" ? <><Compass size={12} aria-hidden />Public</> : world.visibility === "unlisted" ? <>Unlisted</> : <><Lock size={12} aria-hidden />Private</>}
          </span><span aria-hidden>·</span></>}
          <span>Updated {relative(world.updatedAt)}</span>
        </p>
        {!owner && <div className={styles.ctaRow}>
          <button className={styles.primaryCta} aria-pressed={world.savedByViewer} onClick={() => void toggleSave()}>
            <Bookmark size={17} fill={world.savedByViewer ? "currentColor" : "none"} aria-hidden />
            {world.savedByViewer ? "Saved" : "Save world"}
            {world.saveCount > 0 && <em>{compactCount(world.saveCount)}</em>}
          </button>
        </div>}
      </div>
    </div>

    <div className={styles.body}>
      {world.content && <section className={styles.card}>
        <header><Globe2 size={16} /><h2>Lore &amp; canon</h2></header>
        {/* The shared renderer, so lore a creator illustrated reads the same
            way an illustrated creation description does. */}
        <RichContent
          blocks={world.contentRich}
          text={world.content}
          bucket={worldCoverBucket}
          className={styles.prose}
        />
      </section>}

      {creations.length > 0 && <section className={styles.card}>
        {/* "Creations", not "Characters": a world can back a character, a cast
            or a whole scenario, and only one of those is a person. */}
        <header><Sparkles size={16} /><h2>Creations in this World</h2><em className={styles.count}>{creations.length}</em></header>
        {/* The same grid the feed uses, so a creation looks like a creation
            here too — and its save control is the real one, writing through
            the same relation the feed does rather than being decoration. */}
        <CreationGrid creations={creations} onToggleSave={(creation) => void saveCreation(creation)} />
      </section>}

      {world.creator && <section className={`${styles.card} ${styles.creatorCard}`}>
        <header><UserRound size={16} /><h2>Creator</h2></header>
        <div className={styles.creator}>
          <span className={styles.creatorAvatar}>
            {world.creator.avatarPath
              ? <img src={avatarSource(profileAvatarBucket, world.creator.avatarPath, "")} alt="" />
              : initials(world.creator.displayName || world.creator.username)}
          </span>
          <div>
            <strong>{world.creator.username ? `@${world.creator.username}` : world.creator.displayName}</strong>
            {world.creator.displayName && world.creator.username && <small>{world.creator.displayName}</small>}
          </div>
        </div>
      </section>}

      <section className={styles.card}>
        <header><MessageCircle size={16} /><h2>Comments</h2>{comments?.length ? <em className={styles.count}>{comments.length}</em> : null}</header>
        <div className={styles.composer}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={2000} placeholder={`Share what you think of ${world.name}…`} />
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
