"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Compass, Eye, Link2, Lock, PenLine, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { AppMenuButton } from "@/components/ui";
import { creationTitle, creationType, creationTypeLabels } from "@/lib/creation";
import { creationActions, creationEditHref } from "@/lib/creation-actions";
import { compactCount } from "@/lib/format";
import { artPresentation, artStyle } from "@/lib/art-presentation";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import type { CharacterVisibility, OwnedCreationSummary } from "@/lib/types";
import { MoreMenu, type MoreMenuItem } from "@/components/nav";
import { presentsAsAdult } from "@/lib/content-mode";
import styles from "./creations.module.css";

/**
 * Your Creations — the owner's management surface.
 *
 * Deliberately not the public creator profile. A profile answers "what has
 * this person published"; this answers "what do I have, what state is each
 * thing in, and what can I do about it" — which is why private and unlisted
 * work appears here and nowhere else, and why every card carries its
 * visibility rather than only its metrics.
 *
 * The list is lean by construction: `/api/characters?scope=manage` selects
 * card columns only, so a creator with fifty creations does not download fifty
 * hidden definitions to look at a grid. The whole record is fetched when one
 * of them is actually opened for editing.
 *
 * Every action here is one that exists. There is no Duplicate, no Export and
 * no analytics panel, because none of those are things this deployment can do.
 */

const visibilityLabels: Record<CharacterVisibility, string> = {
  private: "Private",
  unlisted: "Unlisted",
  public: "Public",
};

const visibilityIcons: Record<CharacterVisibility, typeof Lock> = {
  private: Lock,
  unlisted: Link2,
  public: Eye,
};

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

type Filter = "all" | CharacterVisibility;

export function YourCreations({ onOpenMenu, onCreate, onChanged }: {
  onOpenMenu?: () => void;
  /** Opens the Create screen, which is the app shell's own studio. */
  onCreate?: () => void;
  /** Lets the shell refresh the sidebar and chat list after a deletion. */
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [creations, setCreations] = useState<OwnedCreationSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(() => {
    setError("");
    api<{ creations: OwnedCreationSummary[] }>("/api/characters?scope=manage")
      .then((data) => setCreations(data.creations))
      .catch((reason) => {
        setCreations([]);
        setError(reason instanceof Error ? reason.message : "Could not load your creations");
      });
  }, []);

  useEffect(load, [load]);

  const counts = useMemo(() => {
    const all = creations ?? [];
    return {
      all: all.length,
      public: all.filter((item) => item.visibility === "public").length,
      unlisted: all.filter((item) => item.visibility === "unlisted").length,
      private: all.filter((item) => item.visibility === "private").length,
    };
  }, [creations]);

  const visible = useMemo(
    () => (creations ?? []).filter((item) => filter === "all" || item.visibility === filter),
    [creations, filter],
  );

  /**
   * Deleting.
   *
   * Confirmed by name, then decided by the server — the ownership predicate
   * and the row level security policy both live there, and this list never
   * decides who may delete what. The database also refuses to cascade a
   * published creation's deletion into other accounts' private chats, which
   * comes back as an instruction rather than an error.
   */
  const remove = useCallback(async (creation: OwnedCreationSummary) => {
    const label = creationTitle(creation);
    if (!window.confirm(`Permanently delete “${label}”?\n\nThis also deletes your own chats and memories for it, and cannot be undone.`)) return;
    setPending(creation.id);
    try {
      await api(`/api/characters/${creation.id}`, { method: "DELETE" });
      setCreations((current) => (current ?? []).filter((item) => item.id !== creation.id));
      setNotice(`“${label}” was deleted.`);
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete that creation");
    } finally { setPending(null); }
  }, [onChanged]);

  return <section className={styles.page} aria-label="Your creations">
    <header className={styles.head}>
      {onOpenMenu && <AppMenuButton className={styles.menuButton} onOpen={onOpenMenu} />}
      <span className={styles.eyebrow}>Everything you have made</span>
      <h1 className={styles.title}>Your Creations</h1>
      <p className={styles.lede}>Characters, casts and scenarios you own — published or not. Only you can see this list.</p>
      {onCreate && <button type="button" className={styles.createButton} onClick={onCreate}>
        <Plus size={16} aria-hidden />Create something new
      </button>}
    </header>

    {creations !== null && counts.all > 0 && <div className={styles.filters} role="group" aria-label="Filter by visibility">
      {([["all", "All"], ["public", "Public"], ["unlisted", "Unlisted"], ["private", "Private"]] as const).map(([value, label]) => <button
        key={value}
        type="button"
        aria-pressed={filter === value}
        className={`${styles.filter} ${filter === value ? styles.filterActive : ""}`}
        onClick={() => setFilter(value)}
      >
        {label}<span className={styles.filterCount}>{counts[value]}</span>
      </button>)}
    </div>}

    {creations === null
      ? <div className={styles.grid} aria-hidden>
        {Array.from({ length: 6 }, (_, index) => <div key={index} className={styles.skeleton} />)}
      </div>
      : error && !creations.length
        ? <div className={styles.state} role="status">
          <PenLine size={26} />
          <h2>Could not load your creations</h2>
          <p>{error}</p>
          <button type="button" className={styles.stateAction} onClick={load}>Try again</button>
        </div>
        : counts.all === 0
          ? <div className={styles.state} role="status">
            <PenLine size={26} />
            <h2>Nothing here yet</h2>
            <p>Everything you make appears here — a character, a cast or a whole scenario — whether you publish it or keep it to yourself.</p>
            {onCreate && <button type="button" className={styles.stateAction} onClick={onCreate}>Create your first</button>}
          </div>
          : visible.length === 0
            ? <div className={styles.state} role="status">
              <PenLine size={26} />
              <h2>Nothing {visibilityLabels[filter as CharacterVisibility].toLowerCase()} yet</h2>
              <p>You have {counts.all} creation{counts.all === 1 ? "" : "s"}, but none of them {filter === "public" ? "are published" : filter === "unlisted" ? "are shared by link" : "are private"}.</p>
              <button type="button" className={styles.stateAction} onClick={() => setFilter("all")}>Show all</button>
            </div>
            : <div className={styles.grid}>
              {visible.map((creation) => <OwnedCard
                key={creation.id}
                creation={creation}
                busy={pending === creation.id}
                onEdit={() => router.push(creationEditHref(creation.id))}
                onDelete={() => void remove(creation)}
              />)}
            </div>}

    {notice && <div className={styles.toast} role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} aria-hidden /></button></div>}
    {error && creations?.length ? <div className={styles.toast} role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss"><X size={14} aria-hidden /></button></div> : null}
  </section>;
}

/**
 * One owned creation.
 *
 * View is the card itself, because opening the thing is the common action and
 * a whole card is a better target than a button. Edit and Delete live in the
 * menu beside it — the same menu primitive the creation page uses, so a
 * three-dot control means the same thing in both places.
 */
function OwnedCard({ creation, busy, onEdit, onDelete }: {
  creation: OwnedCreationSummary;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const title = creationTitle(creation);
  const type = creationType(creation);
  const cover = avatarSource(characterAvatarBucket, creation.avatarPath, creation.avatarUrl);
  const VisibilityIcon = visibilityIcons[creation.visibility];
  // Every creation in this list is owned by the caller, so the same shared
  // decision yields the owner's actions. Copy link is dropped here: the card
  // itself is the link, and a management grid is not where somebody is
  // sharing one.
  const handlers = { edit: onEdit, copy_link: onEdit, report:onEdit, delete: onDelete };
  const items: MoreMenuItem[] = creationActions({ owner: true })
    .filter((action) => action.id !== "copy_link")
    .map((action) => ({
      label: action.label,
      icon: action.id === "delete" ? <Trash2 size={16} aria-hidden /> : <Pencil size={16} aria-hidden />,
      danger: action.danger,
      onSelect: handlers[action.id],
    }));

  return <article className={`${styles.card} ${busy ? styles.cardBusy : ""}`} style={{ "--accent-card": creation.accent } as React.CSSProperties}>
    <Link href={`/characters/${creation.id}`} className={styles.cardLink}>
      <div className={styles.cover}>
        {cover
          ? <img src={cover} alt="" loading="lazy" decoding="async" style={artStyle(artPresentation(creation.artPresentation), "cover", "3:4")} />
          : <span className={styles.coverFallback} aria-hidden>{title.split(/\s+/).filter(Boolean).map((word) => word[0]).join("").slice(0, 2).toUpperCase() || "?"}</span>}
        <div className={styles.coverScrim} />
        <div className={styles.badges}>
          {presentsAsAdult(creation.contentMode) && <em className={`${styles.badge} ${styles.badgeAdult}`}>18+</em>}
          {type === "cast" && <em className={styles.badge}><Users size={11} aria-hidden />Cast</em>}
          {type === "scenario" && <em className={styles.badge}><Compass size={11} aria-hidden />Scenario</em>}
        </div>
      </div>
      <div className={styles.copy}>
        <span className={`${styles.status} ${styles[`status_${creation.visibility}`]}`}>
          <VisibilityIcon size={11} aria-hidden />{visibilityLabels[creation.visibility]}
        </span>
        <h3 className={styles.cardTitle}>{title}</h3>
        <span className={styles.kind}>{creationTypeLabels[type]}</span>
        {/* Only totals the database already maintains. Nothing here is
            estimated, and a metric this deployment cannot answer is absent
            rather than shown as zero. */}
        <div className={styles.metrics}>
          <span>{compactCount(creation.messageCount)} messages</span>
          <span aria-hidden>·</span>
          <span>{compactCount(creation.saveCount)} saves</span>
        </div>
        {creation.updatedAt && <span className={styles.updated}>Updated {relative(creation.updatedAt)}</span>}
      </div>
    </Link>
    <div className={styles.cardActions}>
      <MoreMenu className={styles.cardMenuButton} label={`Manage ${title}`} items={items} />
    </div>
  </article>;
}
