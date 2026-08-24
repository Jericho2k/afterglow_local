"use client";

import { useMemo, useState } from "react";
import { Check, Plus, Search, Tag, X } from "lucide-react";
import { adultTagsIn, canonicalTag, isAdultTag, isPlatformTag, maxTags, platformTagCategories } from "@/lib/tags";
import styles from "./studio.module.css";

/**
 * Platform tags.
 *
 * The taxonomy is the platform's, so the creator picks rather than types — but
 * a tag saved before the taxonomy existed still appears in the selected row
 * and can still be removed. Nothing is silently dropped.
 *
 * Adult tags are ordinary tags with one extra consequence: choosing one turns
 * adult mode on, because a creation carrying them is adult by definition. It is
 * announced rather than hidden, the creator can still turn adult mode off on
 * the publish step, and publishing then stops with a problem that says exactly
 * which tags disagree — so nothing tagged 18+ ships as safe content.
 */
export function TagSelector({ tags, onChange, adultMode, onAdultMode }: {
  tags: string[];
  onChange: (tags: string[]) => void;
  adultMode?: boolean;
  onAdultMode?: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [autoAdult, setAutoAdult] = useState("");
  const full = tags.length >= maxTags;
  const selectedAdult = adultTagsIn(tags);

  function change(next: string[]) {
    const added = next.filter((tag) => !tags.includes(tag)).find(isAdultTag);
    if (added && onAdultMode && !adultMode) {
      onAdultMode(true);
      setAutoAdult(added);
    }
    onChange(next);
  }

  return <div className={styles.field}>
    <span className={styles.fieldLabel}>Tags<span className={styles.optional}>platform categories</span></span>
    <span className={styles.hint}>Chosen from Afterglow&rsquo;s categories. They power filtering, browsing and recommendations.</span>
    <div className={styles.chipRow}>
      {tags.map((tag) => <button
        key={tag}
        type="button"
        className={`${styles.chip} ${styles.chipSelected}`}
        onClick={() => change(tags.filter((item) => item !== tag))}
        aria-label={isAdultTag(tag) ? `Remove tag ${tag}, 18+` : `Remove tag ${tag}`}
      >
        {tag}
        {isAdultTag(tag) && <span className={styles.adultMark} aria-hidden>18+</span>}
        <X size={13} aria-hidden />
      </button>)}
      <button type="button" className={`${styles.chip} ${styles.chipAdd}`} onClick={() => setOpen(true)}>
        <Plus size={14} aria-hidden />{tags.length ? "Add tags" : "Choose tags"}
      </button>
    </div>
    {full && <span className={styles.hint}>That is the maximum of {maxTags} tags.</span>}
    {autoAdult && adultMode && <span className={styles.adultNotice} role="status">
      Adult mode was switched on because &ldquo;{autoAdult}&rdquo; is an 18+ tag. This creation will be marked 18+.
    </span>}
    {selectedAdult.length > 0 && adultMode === false && <span className={styles.adultNotice} role="status">
      {selectedAdult.length === 1 ? "This 18+ tag needs" : `These ${selectedAdult.length} 18+ tags need`} adult mode on before you can publish.
    </span>}
    {open && <TagPicker tags={tags} onChange={change} onClose={() => setOpen(false)} />}
  </div>;
}

function TagPicker({ tags, onChange, onClose }: { tags: string[]; onChange: (tags: string[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(tags.map((tag) => tag.toLowerCase())), [tags]);
  const needle = query.trim().toLowerCase();

  const categories = useMemo(() => platformTagCategories
    .map((category) => ({ ...category, tags: category.tags.filter((tag) => !needle || tag.toLowerCase().includes(needle)) }))
    .filter((category) => category.tags.length), [needle]);

  // Tags a creator entered before the taxonomy existed keep a home of their own
  // rather than disappearing from the picker.
  const legacy = tags.filter((tag) => !isPlatformTag(tag));

  function toggle(tag: string) {
    const canonical = canonicalTag(tag);
    if (selected.has(canonical.toLowerCase())) {
      onChange(tags.filter((item) => item.toLowerCase() !== canonical.toLowerCase()));
      return;
    }
    if (tags.length >= maxTags) return;
    onChange([...tags, canonical]);
  }

  return <div className={styles.sheetBackdrop} role="dialog" aria-modal="true" aria-label="Choose tags" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className={styles.sheet}>
      <header className={styles.sheetHead}>
        <Tag size={18} aria-hidden />
        <h3>Tags</h3>
        <button type="button" className={styles.iconButton} aria-label="Close tag picker" onClick={onClose}><X size={18} /></button>
      </header>
      <div className={styles.sheetBody}>
        <div className={styles.searchRow}>
          <Search size={16} aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tags" aria-label="Search tags" />
        </div>
        <span className={styles.hint}>{tags.length} of {maxTags} selected</span>
        {legacy.length > 0 && <div className={styles.tagGroup}>
          <div className={styles.tagGroupHead}>
            <strong>Your existing tags</strong>
            <small>Added before these categories existed. They keep working.</small>
          </div>
          <div className={styles.chipRow}>
            {legacy.map((tag) => <button key={tag} type="button" className={`${styles.chip} ${styles.chipSelected}`} onClick={() => toggle(tag)} aria-pressed>
              {tag}<X size={13} aria-hidden />
            </button>)}
          </div>
        </div>}
        {categories.map((category) => <div key={category.id} className={styles.tagGroup}>
          <div className={styles.tagGroupHead}>
            <strong>{category.label}{category.adult && <span className={styles.adultMark}>18+</span>}</strong>
            <small>{category.hint}</small>
          </div>
          <div className={styles.chipRow}>
            {category.tags.map((tag) => {
              const active = selected.has(tag.toLowerCase());
              return <button
                key={tag}
                type="button"
                aria-pressed={active}
                className={`${styles.chip} ${active ? styles.chipSelected : ""}`}
                aria-label={category.adult ? `${tag}, 18+` : undefined}
                onClick={() => toggle(tag)}
                disabled={!active && tags.length >= maxTags}
              >
                {active && <Check size={13} aria-hidden />}{tag}
                {category.adult && <span className={styles.adultMark} aria-hidden>18+</span>}
              </button>;
            })}
          </div>
        </div>)}
        {!categories.length && <p className={styles.emptyNote}>No tag matches “{query}”. Use a hashtag instead for anything the categories do not cover.</p>}
      </div>
      <footer className={styles.sheetFoot}>
        <button type="button" className={styles.primaryCta} onClick={onClose}>Done</button>
      </footer>
    </div>
  </div>;
}
