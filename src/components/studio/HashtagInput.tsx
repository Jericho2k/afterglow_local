"use client";

import { useState } from "react";
import { Hash, Plus, X } from "lucide-react";
import { maxHashtags, normalizeHashtag, parseHashtags } from "@/lib/tags";
import styles from "./studio.module.css";

/**
 * Creator hashtags.
 *
 * Deliberately lighter than the platform tag selector: freeform, typed rather
 * than chosen, and visually distinct so the two systems never read as one.
 */
export function HashtagInput({ hashtags, onChange }: { hashtags: string[]; onChange: (hashtags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const full = hashtags.length >= maxHashtags;

  function commit(raw: string) {
    const parsed = parseHashtags(raw);
    if (!parsed.length) { setDraft(""); return; }
    const next = [...hashtags];
    for (const tag of parsed) {
      if (next.length >= maxHashtags) break;
      if (!next.includes(tag)) next.push(tag);
    }
    onChange(next);
    setDraft("");
  }

  return <div className={styles.field}>
    <span className={styles.fieldLabel}>Hashtags<span className={styles.optional}>your own words</span></span>
    <span className={styles.hint}>Freeform keywords for discovery — fandoms, tropes, anything the categories miss. Typing “mha” saves it as #mha.</span>
    {hashtags.length > 0 && <div className={styles.chipRow}>
      {hashtags.map((tag) => <button
        key={tag}
        type="button"
        className={styles.hashtag}
        onClick={() => onChange(hashtags.filter((item) => item !== tag))}
        aria-label={`Remove hashtag #${tag}`}
      >
        <b>#</b>{tag}<X size={12} aria-hidden />
      </button>)}
    </div>}
    <div className={styles.inlineRow}>
      <div className={styles.searchRow} style={{ flex: 1 }}>
        <Hash size={16} aria-hidden />
        <input
          value={draft}
          disabled={full}
          maxLength={60}
          placeholder={full ? `Maximum of ${maxHashtags} hashtags` : "slowburn, villainau…"}
          aria-label="Add a hashtag"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "," || event.key === " ") { event.preventDefault(); commit(draft); }
            if (event.key === "Backspace" && !draft && hashtags.length) onChange(hashtags.slice(0, -1));
          }}
          onBlur={() => commit(draft)}
        />
      </div>
      <button type="button" className={styles.ghostButton} disabled={full || !normalizeHashtag(draft)} onClick={() => commit(draft)}>
        <Plus size={15} aria-hidden /> Add
      </button>
    </div>
  </div>;
}
