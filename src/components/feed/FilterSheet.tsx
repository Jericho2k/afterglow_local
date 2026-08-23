"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { creationTypeLabels } from "@/lib/creation";
import { platformTagCategories } from "@/lib/tags";
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
type Draft = Pick<DiscoveryQuery, "tags" | "types" | "hideAdult">;

function toggle<T>(list: T[], value: T) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function FilterSheet({ query, onApply, onClose }: {
  query: DiscoveryQuery;
  onApply: (draft: Draft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ tags: query.tags, types: query.types, hideAdult: query.hideAdult });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = draft.tags.length + draft.types.length + (draft.hideAdult ? 1 : 0);

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
              <strong>Hide 18+ creations</strong>
              <small>Leaves out anything its creator marked as adult. Your account&apos;s own settings are unchanged.</small>
            </span>
            <input
              type="checkbox"
              checked={draft.hideAdult}
              onChange={(event) => setDraft((current) => ({ ...current, hideAdult: event.target.checked }))}
            />
          </label>
        </section>

        {platformTagCategories.map((category) => <section key={category.id} className={styles.sheetGroup}>
          <h3>{category.label}</h3>
          <p>{category.hint}</p>
          <div className={styles.chipRow}>
            {category.tags.map((tag) => <button
              key={tag}
              type="button"
              className={`${styles.chip} ${draft.tags.includes(tag) ? styles.chipSelected : ""}`}
              aria-pressed={draft.tags.includes(tag)}
              onClick={() => setDraft((current) => ({ ...current, tags: toggle(current.tags, tag) }))}
            >{tag}</button>)}
          </div>
        </section>)}
      </div>

      <footer className={styles.sheetFoot}>
        <button type="button" className={styles.sheetReset} onClick={() => setDraft({ tags: [], types: [], hideAdult: false })}>
          Clear{selected ? ` (${selected})` : ""}
        </button>
        <button type="button" className={styles.sheetApply} onClick={() => onApply(draft)}>Show creations</button>
      </footer>
    </div>
  </div>;
}
