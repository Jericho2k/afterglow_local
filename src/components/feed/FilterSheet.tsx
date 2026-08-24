"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { creationTypeLabels } from "@/lib/creation";
import { adultTagsIn, platformTagCategories } from "@/lib/tags";
import { creationTypes, type CreationType } from "@/lib/types";
import type { DiscoveryQuery } from "@/lib/discovery";
import styles from "./feed.module.css";

/**
 * Structured filtering over the platform tag taxonomy.
 *
 * The categories come from `src/lib/tags.ts` — the same list the studio's tag
 * picker offers — so there is one vocabulary, not a hard-coded copy of it in
 * the feed. Creator hashtags are absent on purpose: they are freeform
 * vocabulary, they are searched rather than browsed, and folding them in here
 * would quietly merge the two systems.
 *
 * Selections are held locally until "Show creations", so a phone is not
 * refetching the feed behind the sheet on every tap.
 */
type Draft = Pick<DiscoveryQuery, "tags" | "types" | "includeAdult">;

function toggle<T>(list: T[], value: T) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function FilterSheet({ query, onApply, onClose }: {
  query: DiscoveryQuery;
  onApply: (draft: Draft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ tags: query.tags, types: query.types, includeAdult: query.includeAdult });
  // Set when picking an adult tag turned adult inclusion on by itself, so the
  // change is announced rather than happening silently under the reader.
  const [autoIncluded, setAutoIncluded] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = draft.tags.length + draft.types.length + (draft.includeAdult ? 1 : 0);
  const selectedAdultTags = useMemo(() => adultTagsIn(draft.tags), [draft.tags]);
  /** An adult tag with adult content excluded can only ever return nothing. */
  const contradictory = selectedAdultTags.length > 0 && !draft.includeAdult;

  /**
   * Selecting an adult tag opts the feed in, because the alternative is a
   * filter that quietly guarantees zero results. Deselecting never opts back
   * out: turning adult content off again is the reader's decision to make.
   */
  function toggleTag(tag: string, adult: boolean) {
    setDraft((current) => {
      const tags = toggle(current.tags, tag);
      const adding = tags.length > current.tags.length;
      if (adult && adding && !current.includeAdult) {
        setAutoIncluded(true);
        return { ...current, tags, includeAdult: true };
      }
      return { ...current, tags };
    });
  }

  return <div
    className={styles.sheetBackdrop}
    role="dialog"
    aria-modal="true"
    aria-label="Filter creations"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
  >
    <div className={styles.sheet}>
      <header className={styles.sheetHead}>
        <h2>Filters</h2>
        <button type="button" className={styles.sheetClose} aria-label="Close filters" onClick={onClose}><X size={17} /></button>
      </header>

      <div className={styles.sheetBody}>
        <section className={styles.sheetGroup}>
          <h3>Kind of creation</h3>
          <p>Characters, defined casts and scenario roleplay all share this feed.</p>
          <div className={styles.chipRow}>
            {creationTypes.map((type: CreationType) => <button
              key={type}
              type="button"
              className={`${styles.chip} ${draft.types.includes(type) ? styles.chipSelected : ""}`}
              aria-pressed={draft.types.includes(type)}
              onClick={() => setDraft((current) => ({ ...current, types: toggle(current.types, type) }))}
            >{creationTypeLabels[type]}</button>)}
          </div>
        </section>

        <section className={styles.sheetGroup}>
          <h3>Content</h3>
          <label className={styles.sheetToggle}>
            <span>
              <strong>Include 18+ creations</strong>
              <small>
                Off, adult creations are left out of this feed. On, they appear alongside everything else.
                This is a filter for browsing only — your account settings are unchanged.
              </small>
            </span>
            <input
              type="checkbox"
              checked={draft.includeAdult}
              onChange={(event) => {
                setAutoIncluded(false);
                setDraft((current) => ({ ...current, includeAdult: event.target.checked }));
              }}
            />
          </label>
          {autoIncluded && draft.includeAdult && <p className={styles.sheetHelp} role="status">
            18+ creations were included because you chose an adult tag. Turn the switch off to leave them out again.
          </p>}
          {contradictory && <p className={styles.sheetWarning} role="status">
            {selectedAdultTags.length === 1 ? `“${selectedAdultTags[0]}” is an adult tag` : `${selectedAdultTags.length} adult tags are selected`} while
            18+ creations are excluded, so this filter will find nothing. Turn on <strong>Include 18+ creations</strong> to see them.
          </p>}
        </section>

        {platformTagCategories.map((category) => <section key={category.id} className={styles.sheetGroup}>
          <h3>{category.label}{category.adult && <span className={styles.adultBadge}>18+</span>}</h3>
          <p>{category.hint}</p>
          <div className={styles.chipRow}>
            {category.tags.map((tag) => <button
              key={tag}
              type="button"
              className={`${styles.chip} ${category.adult ? styles.chipAdult : ""} ${draft.tags.includes(tag) ? styles.chipSelected : ""}`}
              aria-pressed={draft.tags.includes(tag)}
              // The badge is decorative for a screen reader; the restriction is
              // carried by the accessible name instead of by colour or glyph.
              aria-label={category.adult ? `${tag}, 18+` : undefined}
              onClick={() => toggleTag(tag, Boolean(category.adult))}
            >{tag}{category.adult && <span className={styles.chipAdultMark} aria-hidden>18+</span>}</button>)}
          </div>
        </section>)}
      </div>

      <footer className={styles.sheetFoot}>
        <button type="button" className={styles.sheetReset} onClick={() => { setAutoIncluded(false); setDraft({ tags: [], types: [], includeAdult: false }); }}>
          Clear{selected ? ` (${selected})` : ""}
        </button>
        <button type="button" className={styles.sheetApply} onClick={() => onApply(draft)}>Show creations</button>
      </footer>
    </div>
  </div>;
}
