"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Award, BadgeCheck, Bookmark, ChevronDown, Compass, Globe2, Images, Link2,
  Flag, MessageCircle, Pencil, Share2, ShieldAlert, Sparkles, Tag, Trash2, UserRound, Users, X,
} from "lucide-react";
import type { AttachedWorld, Character, CharacterComment } from "@/lib/types";
import {
  castSectionLabel, creationOverview, creationSubject,
  creationTitle, creationType, inlineTitle, publicCastMembers,
} from "@/lib/creation";
import { accentVariables } from "@/lib/accent";
import { AdultGate, type AdultState } from "@/components/AdultGate";
import { presentsAsAdult } from "@/lib/content-mode";
import { artPresentation, bannerArt } from "@/lib/art-presentation";
import { contentModeBadge } from "@/lib/content-mode";
import { castMemberKey } from "@/lib/cast";
import { imageCount } from "@/lib/rich-content";
import { RichContent } from "@/components/rich";
import { chatCta, chatCtaDescription, creationActions, creationEditHref } from "@/lib/creation-actions";
import { chatHref } from "@/lib/shell-route";
import { compactCount, exactCount } from "@/lib/format";
import { creatorProfileHref } from "@/lib/follows";
import { toggleCreationSave } from "@/lib/saves";
import { shareLink, shareMessage } from "@/lib/share";
import { avatarSource, characterAvatarBucket, profileAvatarBucket } from "@/lib/storage";
import { backFallbacks } from "@/lib/back-navigation";
import { readCreation, rememberCreation } from "@/lib/creation-cache";
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

/*
 * What this tab has already been shown, per creation — see
 * src/lib/creation-cache.ts, which owns the store. It used to live here, and
 * moved out for one reason: the editor has to be able to forget an entry after
 * a save, or the page it navigates back to paints the copy that predates it.
 */
const remember = (characterId: string, patch: Partial<{ detail: Detail; comments: CharacterComment[] }>) =>
  rememberCreation<Detail, CharacterComment>(characterId, patch);

export default function CharacterProfile({ characterId }: { characterId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  /*
   * The reader's own adult standing.
   *
   * Read here rather than inferred from the creation, because it is a fact
   * about the ACCOUNT and the page has to know it before it renders anything:
   * an adult-focused creation must show its gate instead of itself, not after
   * itself. `null` means "not answered yet", which is why the page waits for it
   * rather than treating an unloaded state as "not confirmed" and flashing a
   * gate at somebody who confirmed months ago.
   */
  const [adult, setAdult] = useState<AdultState | null>(null);
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

  /*
   * COMING BACK TO THIS PAGE MUST NOT MEAN LOOKING AT AN EMPTY ONE.
   *
   * The router unmounts this component when the reader opens a cast member, so
   * pressing Back remounts it with `detail` at null — an empty page with a
   * spinner — and the whole creation is fetched again over the network. On a
   * phone that is the reported "mostly black with empty elements": the reader
   * came BACK to a page they had just been reading and got a blank one, for as
   * long as a round trip took, with the images arriving later still.
   *
   * The fix is not an animation or a lifecycle event; it is that the data
   * outlives the component. This cache is deliberately tiny and deliberately
   * per-tab: it holds what the reader has already been shown, it is written
   * when a fetch succeeds, and a Back that finds an entry paints the page in
   * the first frame and revalidates behind it. There is no staleness risk worth
   * a blank screen here — the entry was fetched seconds ago, by this reader, in
   * this tab, and the revalidation replaces it either way.
   */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/adult")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("unavailable"))))
      .then((data: { adult: AdultState }) => { if (!cancelled) setAdult(data.adult); })
      // A failure here must not block the page: the server gate is the real
      // one, so the worst case is a reader meeting it at the chat instead.
      .catch(() => { if (!cancelled) setAdult({ confirmedAdult: false, confirmedAt: null, adultContentEnabled: false }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const cached = readCreation<Detail, CharacterComment>(characterId);
    if (cached) { setDetail(cached.detail); setComments(cached.comments); }

    /*
     * LATEST REQUEST WINS, AND A CANCELLED ONE MAY NOT SPEAK.
     *
     * Two navigations in quick succession — Back into this page while its own
     * fetch is still in flight, or a cast member opened and abandoned — used to
     * race, and the loser could arrive last and paint a different creation, or
     * set an error over a page that had already loaded. The abort stops the
     * request; the token stops its handlers, including the catch, because an
     * aborted fetch rejects and that rejection must not become the reader's
     * error banner.
     */
    const controller = new AbortController();
    let current = true;
    const stopped = () => !current || controller.signal.aborted;

    fetch(`/api/characters/${characterId}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not open this character");
        if (stopped()) return;
        setDetail(body);
        remember(characterId, { detail: body });
      })
      .catch((reason) => {
        if (stopped()) return;
        // A page that is already showing the creation from cache must not be
        // replaced by an error because a background revalidation failed.
        if (cached) return;
        setError(reason instanceof Error ? reason.message : "Could not open this character");
      });

    fetch(`/api/comments?characterId=${characterId}`, { signal: controller.signal })
      .then(async (response) => (response.ok ? (await response.json()).comments : []))
      .then((loaded) => {
        if (stopped()) return;
        setComments(loaded);
        remember(characterId, { comments: loaded });
      })
      .catch(() => { if (!stopped()) setComments((existing) => existing ?? []); });

    return () => { current = false; controller.abort(); };
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
      (state) => setDetail((current) => {
        if (!current) return current;
        const next = {
          ...current,
          character: {
            ...current.character,
            savedByViewer: state.savedByViewer,
            saveCount: state.saveCount,
            // The hero stat and the button read one number, never two.
            publicStats: { ...current.character.publicStats, saves: state.saveCount },
          },
        };
        // The cache is what a Back into this page paints from, so a save the
        // reader just made has to be in it — otherwise returning here would
        // show the bookmark un-filled again for a moment.
        remember(characterId, { detail: next });
        return next;
      }),
    );
    if (failure) setError(failure);
  }, [character, characterId]);

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
  if (!detail || !character || (presentsAsAdult(character.contentMode) && !adult)) {
    return <main className={styles.state}><Sparkles size={26} className={styles.spin} /><h1>Opening creation</h1></main>;
  }

  /*
   * An adult-focused creation, in front of a reader who has not opened it yet.
   *
   * BEFORE the page, not over it: the gate replaces the creation rather than
   * covering it, so nothing of an 18+ creation is painted for somebody who has
   * not said they are 18. Which question it asks depends on what is missing —
   * an age that was never stated, or a preference that is switched off.
   *
   * The owner is exempt: a creator opening their own creation has already seen
   * everything in it, and asking them to confirm their age to look at their own
   * work would be theatre. The chat route still checks server-side.
   */
  if (presentsAsAdult(character.contentMode) && adult && !detail.owner && (!adult.confirmedAdult || !adult.adultContentEnabled)) {
    return <AdultGate
      variant={adult.confirmedAdult ? "enable" : "confirm"}
      title={creationTitle(character)}
      onContinue={setAdult}
      onBack={() => router.back()}
    />;
  }

  /*
   * The hero image, and how this creation asked for it to be framed.
   *
   * `bannerArt` answers both halves at once: a creation with a dedicated wide
   * image uses it, and one without uses its primary artwork with the cover
   * focal point — which is exactly what this page did before banners existed.
   * A creation whose creator has set no focal point gets an empty style object,
   * so the stylesheet's own crop still applies and nothing moves.
   */
  const hero = bannerArt({
    avatarPath: character.avatarPath,
    avatarUrl: character.avatarUrl,
    bannerPath: character.bannerPath ?? "",
    bannerUrl: character.bannerUrl ?? "",
    presentation: artPresentation(character.artPresentation),
  });
  const image = avatarSource(characterAvatarBucket, hero.path, hero.url);
  const created = relative(character.createdAt);
  // The hero is titled with the creation, which is not necessarily anybody's
  // name: "The Final War" and "Your New Roommate" are both valid titles.
  const title = creationTitle(character);
  const kind = creationType(character);
  // Resume or start, decided from real data rather than from the button's own
  // wording. See `chatCta` in src/lib/creation-actions.ts.
  const cta = chatCta(character, detail.viewerConversationId ?? null);
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
        {image ? <img src={image} alt="" style={hero.style} /> : <span className={styles.heroFallback}>{initials(character.name)}</span>}
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

        {/*
          * The page's two actions, ONCE.
          *
          * On a phone this row is not rendered at all: the same two controls
          * live in the fixed bar at the bottom of the page, which is where a
          * reader on a long page can actually reach them. Two copies of one
          * primary action is not redundancy, it is a page with two different
          * answers to "what do I do here" — and the copy at the top was the one
          * nobody could see by the time they had decided.
          *
          * On a wide screen the hero stays in view for most of the page, a
          * floating bar would be furniture, and this row is the only instance.
          *
          * The `+` that used to sit between them is gone. Starting a separate
          * story is a real action and it still exists — inside the chat, in the
          * story drawer, where it is spelled out rather than being a glyph
          * competing with the primary control for the same thumb.
          */}
        <div className={styles.ctaRow}>
          {/* Stable copy inside the control, the creation's own name outside
              it. The full title is the heading directly above, and the
              accessible name spells it out for anybody who cannot see that.

              The button RESUMES when there is something to resume. It used to
              create a story on every press, which is how a reader ended up
              with a dozen one-message conversations and none of the one they
              were actually in. */}
          <button
            className={styles.primaryCta}
            onClick={() => openChat(cta.conversationId)}
            disabled={starting}
            aria-label={chatCtaDescription(character, cta)}
            title={chatCtaDescription(character, cta)}
          >
            <Sparkles size={18} /><span>{starting ? "Opening story…" : cta.label}</span>
          </button>
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
              // The gallery is the one place lazy loading earns its keep: full
              // -size uploads, far below the fold, often several of them.
              return <li key={item.id}><img src={source} alt={item.caption} loading="lazy" decoding="async" /></li>;
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
          <header><Tag size={16} /><h2>Tags</h2>{contentModeBadge(character.contentMode) && <em className={styles.adultBadge}>{contentModeBadge(character.contentMode)}</em>}</header>
          {/* Platform taxonomy and creator hashtags are two systems, so they
              are presented as two, never merged into one wall of chips. */}
          {character.tags.length > 0 && <ul className={styles.tagList}>{character.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}
          {/* A hashtag is discovery vocabulary, so it goes somewhere: each one
              opens the feed already searching for it. */}
          {character.hashtags.length > 0 && <ul className={styles.hashtagList}>
            {character.hashtags.map((tag) => <li key={tag}><Link href={`/?q=%23${encodeURIComponent(tag)}`}>#{tag}</Link></li>)}
          </ul>}
          {/* Two different sentences, because they are two different facts. An
              adult-focused creation IS adult; an adult-capable one only
              becomes explicit if this reader steers it there and has asked
              for that, and saying so is the whole point of the distinction. */}
          {character.contentMode === "adult_focused" && <p className={styles.adultNote}>This creation is 18+. Mature and explicit content is a core part of it.</p>}
          {character.contentMode === "adult_capable" && <p className={styles.adultNote}>This story stays non-explicit unless you steer it otherwise and have turned on adult content.</p>}
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
                {/*
                  * EAGER, DELIBERATELY.
                  *
                  * A cast portrait is a 52px thumbnail in a list of a handful,
                  * so lazy loading saved nothing worth having — and it cost the
                  * reported bug. A `loading="lazy"` image is evaluated against
                  * the viewport as the page lays out, and a page RESTORED by
                  * the browser lays out at scroll 0 and is scrolled afterwards;
                  * images that were below the fold at that instant are never
                  * re-evaluated, so returning from a cast member's page left a
                  * list of empty boxes that filled in only when the reader
                  * nudged the screen. `decoding="async"` keeps the paint off
                  * the main thread, which is the part that was actually worth
                  * having.
                  */}
                <span className={styles.castAvatar}>
                  {portrait ? <img src={portrait} alt="" decoding="async" /> : initials(member.name)}
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
      * The action bar, on phones only, and the ONLY instance of these two
      * controls there.
      *
      * A creation page is long — hero, definition, cast, gallery, worlds,
      * comments — and the one thing a reader came to do was at the very top of
      * it. Scrolling back up to start a story is not a gesture anybody should
      * have to learn, so the two actions that matter follow the reader down the
      * page, and the copies in the hero are not rendered beside them.
      *
      * IT USES THE PAGE'S OWN BUTTONS. It previously had a style of its own — a
      * blurred translucent pane, and a Save control shaped like nothing else on
      * the page — which read as an advertisement floating over the content
      * rather than as part of it. `.primaryCta` and `.ghostButton` are the
      * controls this page already has and the ones the design is built around,
      * so the bar reuses them exactly; only the Save gets a label, because a
      * bare icon at the bottom of a page has no neighbours to explain it.
      *
      * Hidden while the report dialog is open: that dialog covers the viewport
      * and a bar floating over a modal is the wrong layer.
      */}
    {!reportOpen && <div className={styles.actionBar}>
      <button
        className={styles.primaryCta}
        onClick={() => openChat(cta.conversationId)}
        disabled={starting}
        aria-label={chatCtaDescription(character, cta)}
      >
        <Sparkles size={18} /><span>{starting ? "Opening story…" : cta.label}</span>
      </button>
      <button
        className={`${styles.ghostButton} ${styles.actionBarSave}`}
        aria-pressed={Boolean(character.savedByViewer)}
        aria-label={character.savedByViewer ? "Remove from your saved creations" : "Save this creation"}
        onClick={() => void toggleSave()}
      >
        <Bookmark size={18} fill={character.savedByViewer ? "currentColor" : "none"} />
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
