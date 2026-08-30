"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Award, BadgeCheck, Bookmark, ChevronDown, Compass, Globe2, Images, Link2,
  Flag, MessageCircle, Pencil, Plus, Share2, ShieldAlert, Sparkles, Tag, Trash2, UserRound, Users, X,
} from "lucide-react";
import type { AttachedWorld, Character, CharacterComment } from "@/lib/types";
import {
  castSectionLabel, creationOverview, creationSubject,
  creationTitle, creationType, inlineTitle, publicCastMembers,
} from "@/lib/creation";
import { accentVariables } from "@/lib/accent";
import { castMemberKey } from "@/lib/cast";
import { imageCount } from "@/lib/rich-content";
import { RichContent } from "@/components/rich";
import { chatCta, chatCtaDescription, creationActions, creationEditHref, newStoryLabel } from "@/lib/creation-actions";
import { chatHref } from "@/lib/shell-route";
import { compactCount, exactCount } from "@/lib/format";
import { creatorProfileHref } from "@/lib/follows";
import { toggleCreationSave } from "@/lib/saves";
import { shareLink, shareMessage } from "@/lib/share";
import { avatarSource, characterAvatarBucket, profileAvatarBucket } from "@/lib/storage";
import { backFallbacks } from "@/lib/back-navigation";
import { markEditorOpenedFromCreation } from "@/lib/editor-navigation";
import { BackButton, MoreMenu, type MoreMenuItem } from "@/components/nav";
import { iconButtonClass } from "@/components/ui";
import { WorldCard } from "@/components/world";
import { CreatorCard, type CreatorCardData } from "@/components/creator";
import { rankBadgeLabel, type CreationRank } from "@/lib/rankings";
import styles from "./profile.module.css";

/**
 * `worlds` may contain a locked stand-in for a world this viewer cannot open.
 * A public creation built on a private world still shows the association —
 * hiding it would misrepresent what the creation is — so the card renders with
 * its identity and without its content or its link.
 */
type Detail = {
  character: Character;
  worlds: AttachedWorld[];
  owner: boolean;
  /** The newest story this reader has with this creation, or null for none. */
  viewerConversationId?: string | null;
  viewerConversationCount?: number;
  /**
   * Who made this. Present for every viewer of every creation whose creator
   * profile resolved — which, since 0022, is every published creation. It used
   * to be present only for the owner, and the page used to render its entire
   * creator section conditionally on it.
   */
  creatorCard?: CreatorCardData | null;
  /** The single rank worth mentioning, chosen server-side. Null when none is. */
  rankBadge?: CreationRank | null;
};

/**
 * Public creation page.
 *
 * One page shell for all three authoring structures. Sections are derived from
 * what the creator actually supplied: a creation with no gallery, facts, cast
 * or world simply has a shorter page, and the section navigation is built from
 * the same list that renders, so the two can never disagree about order or
 * contents. A scenario with no defined characters renders correctly — the page
 * never invents a primary character so an older layout keeps working.
 */
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
  const [reportOpen,setReportOpen]=useState(false);
  const [reportReason,setReportReason]=useState<"underage"|"real_person"|"stolen"|"other">("other");
  const [reportDetails,setReportDetails]=useState("");
  const [reportState,setReportState]=useState<"ready"|"submitting"|"success"|"error">("ready");
  const [reportError,setReportError]=useState("");

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

  useEffect(()=>{
    if(!reportOpen)return;
    const close=(event:KeyboardEvent)=>{if(event.key==="Escape")setReportOpen(false);};
    window.addEventListener("keydown",close);
    return()=>window.removeEventListener("keydown",close);
  },[reportOpen]);

  const character = detail?.character;
  const worlds = useMemo(() => detail?.worlds ?? [], [detail]);

  // The public description only. Internal prompt engineering — response
  // directives, boundaries, example dialogue — never appears here.
  const overview = useMemo(() => (character ? creationOverview(character) : ""), [character]);
  // Only a description the creator actually placed an image in is "rich": a
  // plain one keeps its clamp and its Show more, exactly as before.
  const illustrated = useMemo(() => imageCount(character?.descriptionRich) > 0, [character]);
  const cast = useMemo(() => (character ? publicCastMembers(character.cast) : []), [character]);

  async function submitReport(){
    setReportState("submitting");setReportError("");
    try{
      const response=await fetch("/api/reports",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({characterId,reason:reportReason,details:reportDetails})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body.error||"Could not submit this report");
      setReportState("success");
    }catch(reason){setReportError(reason instanceof Error?reason.message:"Could not submit this report");setReportState("error");}
  }

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
    const kind = creationType(character);
    if (character.gallery.length) available.push({ id: "gallery", label: "Gallery", icon: Images });
    if (overview) available.push({ id: "overview", label: "Overview", icon: Sparkles });
    if (character.userRole.trim()) available.push({ id: "role", label: "Your role", icon: Compass });
    if (character.tags.length || character.hashtags.length) available.push({ id: "tags", label: "Tags", icon: Tag });
    if (character.quickFacts.length) available.push({ id: "facts", label: "Quick facts", icon: BadgeCheck });
    if (cast.length) available.push({ id: "cast", label: castSectionLabel(kind), icon: Users });
    if (detail?.creatorCard) available.push({ id: "creator", label: "Creator", icon: UserRound });
    if (worlds.length) available.push({ id: "world", label: worlds.length === 1 ? "World" : "Worlds", icon: Globe2 });
    available.push({ id: "comments", label: "Comments", icon: MessageCircle });
    return available;
  }, [character, cast, overview, worlds, detail?.creatorCard]);

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

  /**
   * Creating a story, and only when there is genuinely no story to open.
   *
   * `startingRef` rather than the state flag alone: React batches a state
   * update, so two taps inside one frame both saw `starting === false` and
   * both posted. A ref changes on the first line of the first tap, which is
   * what actually makes a double tap produce one conversation instead of two.
   */
  const startingRef = useRef(false);
  const createStory = useCallback(async (announce: string) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError("");
    try {
      const response = await fetch("/api/conversations", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || announce);
      // The shell's own address for a chat, so the entry left behind names the
      // exact story rather than "some chat with this creation".
      router.push(chatHref(characterId, body.conversation.id));
    } catch (reason) {
      startingRef.current = false;
      setError(reason instanceof Error ? reason.message : announce);
      setStarting(false);
    }
  }, [characterId, router]);

  /**
   * The main button.
   *
   * Resuming is a navigation and nothing more: the story exists, so pressing
   * this writes nothing and creates nothing. Only a creation this reader has
   * never opened takes the create path. See `chatCta`.
   */
  const openChat = useCallback((conversationId: string | null) => {
    if (startingRef.current) return;
    if (conversationId) {
      setStarting(true);
      router.push(chatHref(characterId, conversationId));
      return;
    }
    void createStory("Could not start chat");
  }, [characterId, createStory, router]);

  /**
   * Saving, through the same `/api/saves` relation the feed writes. The state
   * is applied optimistically and reverted if the write fails, so the page can
   * never sit on a count that never happened.
   */
  const toggleSave = useCallback(async () => {
    if (!character) return;
    const failure = await toggleCreationSave(
      { id: character.id, savedByViewer: Boolean(character.savedByViewer), saveCount: character.saveCount ?? 0 },
      (state) => setDetail((current) => current ? {
        ...current,
        character: {
          ...current.character,
          savedByViewer: state.savedByViewer,
          saveCount: state.saveCount,
          // The hero stat and the button read one number, never two.
          publicStats: { ...current.character.publicStats, saves: state.saveCount },
        },
      } : current),
    );
    if (failure) setError(failure);
  }, [character]);

  // One primitive, shared with the creator profile: native share sheet where
  // there is one, clipboard otherwise, one message either way. It used to copy
  // silently on desktop, which read as a button that did nothing.
  const share = useCallback(() => {
    void shareLink({ url: window.location.href, title: character ? creationTitle(character) : "Afterglow" })
      .then((outcome) => setError(shareMessage(outcome, "Creation")));
  }, [character]);

  const copyLink = useCallback(() => {
    void navigator.clipboard?.writeText(window.location.href)
      .then(() => setError("Link copied."))
      .catch(() => setError("Could not copy the link. Use your browser's address bar."));
  }, []);

  /**
   * Deleting, from the owner's menu.
   *
   * Confirmed first and then decided by the server: the ownership predicate
   * lives in the API, and the 409 the database raises for a creation other
   * accounts are chatting with is surfaced as the instruction it is rather
   * than as a failure.
   */
  const removeCreation = useCallback(async () => {
    if (!character) return;
    const label = creationTitle(character);
    if (!window.confirm(`Permanently delete “${label}”, including every chat and memory attached to it? This cannot be undone.`)) return;
    try {
      const response = await fetch(`/api/characters/${characterId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not delete this creation");
      router.replace("/?view=creations");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete this creation");
    }
  }, [character, characterId, router]);

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

  if (error && !detail) return <main className={styles.state}><Sparkles size={26} /><h1>Creation unavailable</h1><p>{error}</p><Link href="/">Return to Afterglow</Link></main>;
  if (!detail || !character) return <main className={styles.state}><Sparkles size={26} className={styles.spin} /><h1>Opening creation</h1></main>;

  const image = avatarSource(characterAvatarBucket, character.avatarPath, character.avatarUrl);
  const created = relative(character.createdAt);
  // The hero is titled with the creation, which is not necessarily anybody's
  // name: "The Final War" and "Your New Roommate" are both valid titles.
  const title = creationTitle(character);
  const kind = creationType(character);
  // Resume or start, decided from real data rather than from the button's own
  // wording. See `chatCta` in src/lib/creation-actions.ts.
  const cta = chatCta(character, detail.viewerConversationId ?? null);
  const storyCount = detail.viewerConversationCount ?? 0;
  const creatorCard = detail.creatorCard ?? null;
  const rankBadge = detail.rankBadge ?? null;
  const creatorHref = creatorProfileHref(creatorCard?.username);
  const creatorName = creatorCard
    ? (creatorCard.username ? `@${creatorCard.username}` : creatorCard.displayName)
    : "";
  // Keep the verified badge glued to the final word of the title.
  const titleWords = title.trim().split(/\s+/);
  const titleLead = titleWords.slice(0, -1).join(" ");
  const titleTail = titleWords[titleWords.length - 1] ?? title;
  const stats = character.publicStats;
  /*
   * Messages, saves and chats — the three totals the database actually
   * maintains. There is no rank here because rank is not computed, and no
   * likes because saving replaced liking; inventing either to fill the row
   * would be the wrong kind of polish.
   */
  const visibleStats = [
    { label: "Messages", icon: <MessageCircle size={11} aria-hidden />, value: stats.messages === null ? null : compactCount(stats.messages) },
    { label: "Saves", icon: <Bookmark size={11} aria-hidden />, value: stats.saves === null ? null : compactCount(stats.saves) },
    { label: "Chats", icon: <Sparkles size={11} aria-hidden />, value: stats.chats === null ? null : compactCount(stats.chats) },
  ];
  const heroTags = character.tags.slice(0, 6);
  // Which actions exist is decided in one place, so the menu here and any
  // other surface that grows one cannot disagree about what ownership allows.
  const menuIcons = { edit: <Pencil size={16} aria-hidden />, copy_link: <Link2 size={16} aria-hidden />, report:<Flag size={16} aria-hidden />, delete: <Trash2 size={16} aria-hidden /> };
  const menuHandlers = {
    /*
     * Straight to the edit route, which is a real page rather than a redirect
     * through the home shell.
     *
     * The marker says that THIS page is the entry underneath the editor, which
     * is what lets a save walk back to it instead of pushing a duplicate on
     * top — the fix for the "Back returns me to the editor" report. See
     * src/lib/editor-navigation.ts.
     */
    edit: () => {
      markEditorOpenedFromCreation(window.sessionStorage, character.id);
      router.push(creationEditHref(character.id));
    },
    copy_link: copyLink,
    report:()=>{setReportOpen(true);setReportState("ready");setReportError("");},
    delete: () => void removeCreation(),
  };
  const menuItems: MoreMenuItem[] = creationActions({ owner: detail.owner })
    .filter((action)=>character.moderationStatus!=="removed"||!(["edit","delete"] as const).includes(action.id as "edit"|"delete"))
    .map((action) => ({
    label: action.label,
    icon: menuIcons[action.id],
    danger: action.danger,
    onSelect: menuHandlers[action.id],
  }));

  return <main className={styles.page} style={accentVariables(character.accent) as React.CSSProperties}>
    {reportOpen&&<div className={styles.reportBackdrop} role="presentation" onMouseDown={(event)=>{if(event.target===event.currentTarget)setReportOpen(false);}}>
      <section className={styles.reportModal} role="dialog" aria-modal="true" aria-labelledby="report-title">
        <button className={styles.reportClose} aria-label="Close report dialog" onClick={()=>setReportOpen(false)}><X size={18}/></button>
        {reportState==="success"?<div className={styles.reportSuccess}><Flag size={26} aria-hidden/><h2 id="report-title">Report received</h2><p>Thank you. Afterglow’s moderation team can now review the creation and the snapshot captured with your report.</p><button onClick={()=>setReportOpen(false)}>Done</button></div>:<>
          <span className={styles.reportEyebrow}>Safety report</span><h2 id="report-title">Report {title}</h2>
          <p className={styles.reportIntro}>Choose the closest reason. The creator will not see your report or its details.</p>
          <fieldset className={styles.reportReasons}><legend>Reason</legend>{[
            ["underage","Sexual content involving minors"],["real_person","Real person or impersonation"],["stolen","Stolen or copied creation"],["other","Other safety concern"],
          ].map(([value,label],index)=><label key={value} data-active={reportReason===value}><input autoFocus={index===0} type="radio" name="report-reason" value={value} checked={reportReason===value} onChange={()=>setReportReason(value as typeof reportReason)}/><span>{label}</span></label>)}</fieldset>
          <label className={styles.reportDetails}>Details <span>Optional</span><textarea maxLength={3000} rows={5} value={reportDetails} onChange={(event)=>setReportDetails(event.target.value)} placeholder="What should the moderation team know?"/></label>
          {reportError&&<p className={styles.reportError} role="alert">{reportError}</p>}
          <div className={styles.reportActions}><button onClick={()=>setReportOpen(false)}>Cancel</button><button disabled={reportState==="submitting"} onClick={()=>void submitReport()}>{reportState==="submitting"?"Submitting…":"Submit report"}</button></div>
        </>}
      </section>
    </div>}
    {detail.owner&&character.moderationStatus==="removed"&&<div className={styles.moderationNotice} role="status"><ShieldAlert size={16} aria-hidden/><div><strong>This creation was removed by Afterglow.</strong><span>It is private and locked from publishing while moderation is active.{character.moderationReason?` ${character.moderationReason}`:""}</span></div></div>}
    <div className={styles.hero}>
      <div className={styles.heroMedia}>
        {image ? <img src={image} alt="" /> : <span className={styles.heroFallback}>{initials(character.name)}</span>}
        <div className={styles.heroGlow} />
        <div className={styles.heroScrim} />
      </div>

      <div className={styles.heroBar}>
        <BackButton className={iconButtonClass("media")} fallback={backFallbacks.creation} />
        <div className={styles.heroBarActions}>
          {!detail.owner && <button className={iconButtonClass("media")} aria-pressed={Boolean(character.savedByViewer)} aria-label={character.savedByViewer ? "Remove from your saved creations" : "Save this creation"} onClick={() => void toggleSave()}>
            <Bookmark size={18} fill={character.savedByViewer ? "currentColor" : "none"} />
          </button>}
          <button className={iconButtonClass("media")} aria-label="Share creation" title="Share creation" onClick={share}><Share2 size={18} /></button>
          {/* A menu, not a link. Pressing it opens the actions below and
              navigates nowhere; each action then does exactly the one thing
              it is labelled with. Owners get the two that need ownership,
              and everybody gets the one that does not — there is no Report
              or Duplicate here because neither exists to be offered. */}
          <MoreMenu className={iconButtonClass("media")} label={`More actions for ${title}`} items={menuItems} />
        </div>
      </div>

      <div className={styles.heroCopy}>
        <h1 className={styles.name}>
          {titleLead && `${titleLead} `}
          <span className={styles.nameTail}>
            {titleTail}
            {creatorCard?.username && <BadgeCheck size={26} className={styles.verified} aria-label="Verified creator" />}
          </span>
        </h1>
        {character.tagline && <p className={styles.tagline}>{character.tagline}</p>}
        {/* One rank, or none.
            A creation that is #147 overall, #5 in Drama and #19 in Romance has
            exactly one interesting fact about it; printing all three is how a
            page stops being read. Which one is chosen — and why nothing shows
            below the hundredth position — is `bestRankBadge` in
            src/lib/rankings.ts, decided server-side so every surface that
            grows a badge picks the same one. */}
        {rankBadge && <p className={styles.rankBadge}>
          <Award size={14} aria-hidden />
          <strong>{rankBadgeLabel(rankBadge)}</strong>
          <span className={styles.srOnly}>
            {` on Afterglow, out of ${exactCount(rankBadge.rankTotal)} ${rankBadge.category ? `${rankBadge.category} creations` : "creations"}`}
          </span>
        </p>}
        {heroTags.length > 0 && <ul className={styles.heroTags}>{heroTags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}
        <p className={styles.byline}>
          {/* The byline is a link. A reader who wants to know who made this
              should not have to scroll past the cast to find out. */}
          {creatorName && <>{creatorHref
            ? <Link className={styles.bylineCreator} href={creatorHref}>{creatorName}</Link>
            : <strong>{creatorName}</strong>}<span aria-hidden>·</span></>}
          {stats.chats !== null && <><span>{compactCount(stats.chats)} chats</span><span aria-hidden>·</span></>}
          <span>Created {created}</span>
        </p>

        <div className={styles.ctaRow}>
          {/* Stable copy inside the control, the creation's own name outside
              it. The full title is the heading directly above, and the
              accessible name spells it out for anybody who cannot see that.

              The button RESUMES when there is something to resume. It used to
              create a story on every press, which is how a reader ended up
              with a dozen one-message conversations and none of the one they
              were actually in. Beginning again is the separate control beside
              it, and it says so. */}
          <button
            className={styles.primaryCta}
            onClick={() => openChat(cta.conversationId)}
            disabled={starting}
            aria-label={chatCtaDescription(character, cta)}
            title={chatCtaDescription(character, cta)}
          >
            <Sparkles size={18} /><span>{starting ? "Opening story…" : cta.label}</span>
          </button>
          {cta.kind === "resume" && <button
            className={`${styles.ghostButton} ${styles.ghostWide}`}
            onClick={() => void createStory("Could not start a new story")}
            disabled={starting}
            aria-label={`Start a new story with ${title}, keeping the ${storyCount === 1 ? "one you already have" : `${storyCount} you already have`}`}
            title={newStoryLabel}
          >
            <Plus size={18} /><span className={styles.ghostLabel}>{newStoryLabel}</span>
          </button>}
          <button className={styles.ghostButton} aria-pressed={Boolean(character.savedByViewer)} aria-label={character.savedByViewer ? "Remove from your saved creations" : "Save this creation"} onClick={() => void toggleSave()}>
            <Bookmark size={18} fill={character.savedByViewer ? "currentColor" : "none"} />
          </button>
        </div>

        {/* Sized to what it actually contains. Rank is not one of these cells:
            it is an achievement rather than a metric, so it sits in the hero
            as a badge when it is worth mentioning and is absent when it is
            not, instead of occupying a column that reads "—" for most of the
            platform. */}
        <dl className={styles.stats} style={{ "--stat-count": visibleStats.length } as React.CSSProperties}>
          {visibleStats.map((stat) => <Stat key={stat.label} icon={stat.icon} label={stat.label} value={stat.value} />)}
        </dl>
      </div>
    </div>

    {sections.length > 1 && <nav className={styles.sectionNav} aria-label="Creation sections">
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
          <header><Sparkles size={16} /><h2>{kind === "character" ? `About ${inlineTitle(creationSubject(character))}` : "Overview"}</h2></header>
          {/* A description the creator illustrated renders as blocks; one they
              did not renders as the paragraph it has always been. The clamp
              only applies to the plain case, because collapsing a column that
              contains artwork reads as a broken image rather than as more
              text. */}
          {illustrated
            ? <RichContent blocks={character.descriptionRich} text={overview} bucket={characterAvatarBucket} />
            : <>
              <p ref={overviewRef} className={`${styles.prose} ${expanded ? styles.proseOpen : ""}`}>{overview}</p>
              {(overflowing || expanded) && <button className={styles.showMore} onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show less" : "Show more"}<ChevronDown size={15} className={expanded ? styles.flip : ""} />
              </button>}
            </>}
        </section>}

        {character.userRole.trim() && <section id="role" className={`${styles.card} ${illuminated === "role" ? styles.illuminate : ""}`}>
          <header><Compass size={16} /><h2>Your role</h2></header>
          <p className={styles.roleProse}>{character.userRole}</p>
        </section>}

        {(character.tags.length > 0 || character.hashtags.length > 0) && <section id="tags" className={`${styles.card} ${illuminated === "tags" ? styles.illuminate : ""}`}>
          <header><Tag size={16} /><h2>Tags</h2>{character.nsfwEnabled && <em className={styles.adultBadge}>18+</em>}</header>
          {/* Platform taxonomy and creator hashtags are two systems, so they
              are presented as two, never merged into one wall of chips. */}
          {character.tags.length > 0 && <ul className={styles.tagList}>{character.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}
          {/* A hashtag is discovery vocabulary, so it goes somewhere: each one
              opens the feed already searching for it. */}
          {character.hashtags.length > 0 && <ul className={styles.hashtagList}>
            {character.hashtags.map((tag) => <li key={tag}><Link href={`/?q=%23${encodeURIComponent(tag)}`}>#{tag}</Link></li>)}
          </ul>}
          {character.nsfwEnabled && <p className={styles.adultNote}>This creation may generate mature and explicit content.</p>}
        </section>}

        {character.quickFacts.length > 0 && <section id="facts" className={`${styles.card} ${illuminated === "facts" ? styles.illuminate : ""}`}>
          <header><BadgeCheck size={16} /><h2>Quick facts</h2></header>
          <dl className={styles.facts}>
            {character.quickFacts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
          </dl>
        </section>}

        {cast.length > 0 && <section id="cast" className={`${styles.card} ${illuminated === "cast" ? styles.illuminate : ""}`}>
          <header><Users size={16} /><h2>{castSectionLabel(kind)}</h2><em className={styles.count}>{cast.length}</em></header>
          {kind === "scenario" && <p className={styles.castNote}>Recurring characters the story knows in detail. Others appear as the scenario needs them.</p>}
          <ul className={styles.castList}>
            {cast.map((member, index) => {
              const portrait = avatarSource(characterAvatarBucket, member.avatarPath, member.avatarUrl);
              const key = castMemberKey(member);
              const body = <>
                <span className={styles.castAvatar}>
                  {portrait ? <img src={portrait} alt="" loading="lazy" /> : initials(member.name)}
                </span>
                <span className={styles.castCopy}>
                  <strong>{member.name}</strong>
                  {member.role && <small>{member.role}</small>}
                  {/* Only the blurb the creator wrote for readers. A cast
                      member's definition is prompt material and stays private. */}
                  {member.tagline && <p>{member.tagline}</p>}
                </span>
              </>;
              // A member with no addressable key — no id yet and a name that
              // does not survive slugging — is shown without a link rather
              // than linked to a page that cannot resolve it.
              return <li key={key || `${member.name}-${index}`} className={styles.castCard}>
                {key
                  ? <Link href={`/characters/${character.id}/cast/${encodeURIComponent(key)}`} className={styles.castLink}>{body}</Link>
                  : <span className={styles.castLink}>{body}</span>}
              </li>;
            })}
          </ul>
        </section>}

        {/* The creator.
            Shown to EVERY viewer of every creation, which is the fix rather
            than a detail: this section used to be conditional on a profile row
            that only the owner could read, so a visitor met an anonymous
            creation and its author met a byline. The card itself is shared —
            see src/components/creator/CreatorCard.tsx — so the identity beside
            a creation, on a ranked row and on a profile is one object with one
            follow primitive behind it. */}
        {creatorCard && <section id="creator" className={`${styles.card} ${styles.creatorCard} ${illuminated === "creator" ? styles.illuminate : ""}`}>
          <header><UserRound size={16} /><h2>Creator</h2></header>
          <CreatorCard creator={creatorCard} onError={setError} />
        </section>}

        {worlds.length > 0 && <section id="world" className={`${styles.card} ${illuminated === "world" ? styles.illuminate : ""}`}>
          <header><Globe2 size={16} /><h2>{worlds.length === 1 ? "World" : "Worlds"}</h2></header>
          <div className={styles.worldList}>
            {/* The same card the Worlds page uses, so a world looks like a
                world wherever it is met. */}
            {worlds.map((world) => <WorldCard key={world.id} world={world} variant="attached" />)}
          </div>
        </section>}

        <section id="comments" className={`${styles.card} ${illuminated === "comments" ? styles.illuminate : ""}`}>
          <header><MessageCircle size={16} /><h2>Comments</h2>{comments?.length ? <em className={styles.count}>{comments.length}</em> : null}</header>
          <div className={styles.composer}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={2000} placeholder={`Share what you think of ${inlineTitle(creationSubject(character))}…`} />
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

    {error && <div className={styles.toast} role="status">{error}<button onClick={() => setError("")} aria-label="Dismiss"><X size={14} aria-hidden /></button></div>}

    {/*
      * The action bar, on phones only.
      *
      * A creation page is long — hero, definition, cast, gallery, worlds,
      * comments — and the one thing a reader came to do was at the very top of
      * it. Scrolling back up to start a story is not a gesture anybody should
      * have to learn, so the two actions that matter follow the reader down
      * the page.
      *
      * It is a copy of the hero's controls rather than a move of them: on a
      * desktop the hero row is visible for most of the page and a floating bar
      * would be furniture. It is hidden while the report dialog is open,
      * because that dialog covers the viewport and a bar floating over a modal
      * is the wrong layer.
      *
      * `.page` reserves the bar's height at the bottom, so it rests over the
      * gradient and never over the last line of the last comment.
      */}
    {!reportOpen && <div className={styles.actionBar}>
      <button
        className={styles.primaryCta}
        onClick={() => openChat(cta.conversationId)}
        disabled={starting}
        aria-label={chatCtaDescription(character, cta)}
      >
        <Sparkles size={17} /><span>{starting ? "Opening story…" : cta.label}</span>
      </button>
      <button
        className={styles.actionBarSave}
        aria-pressed={Boolean(character.savedByViewer)}
        aria-label={character.savedByViewer ? "Remove from your saved creations" : "Save this creation"}
        onClick={() => void toggleSave()}
      >
        <Bookmark size={17} fill={character.savedByViewer ? "currentColor" : "none"} />
        <span>{character.savedByViewer ? "Saved" : "Save"}</span>
      </button>
    </div>}
  </main>;
}

/**
 * One metric.
 *
 * A metric the backend cannot answer renders as unavailable rather than as
 * zero — those are different facts. A metric that is genuinely zero renders as
 * "0", aligned exactly like every other value, so a creation published a
 * minute ago looks new rather than broken.
 */
function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string | null }) {
  return <div className={styles.stat}>
    <dt className={styles.statLabel}>{icon}<span>{label}</span></dt>
    <dd>{value ?? <span className={styles.unavailable}>—</span>}</dd>
  </div>;
}
