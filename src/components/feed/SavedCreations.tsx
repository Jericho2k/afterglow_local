"use client";

import { useCallback, useEffect, useState } from "react";
import { Bookmark, Menu } from "lucide-react";
import { api } from "@/lib/api-client";
import { toggleCreationSave } from "@/lib/saves";
import type { CreationSummary } from "@/lib/types";
import { CreationGrid, CreationGridSkeleton, FeedState } from "./CreationGrid";
import styles from "./feed.module.css";

/**
 * The viewer's saved library.
 *
 * The same cards, the same save state and the same `/api/saves` relation the
 * feed writes — this is a second view of one dataset, not a second store.
 *
 * Unsaving leaves the card in place rather than making it vanish mid-tap; it
 * is simply no longer saved, and it is gone the next time the list loads.
 */
export function SavedCreations({ onOpenMenu }: { onOpenMenu?: () => void }) {
  const [creations, setCreations] = useState<CreationSummary[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    setError("");
    api<{ creations: CreationSummary[] }>("/api/saves")
      .then((data) => setCreations(data.creations))
      .catch((reason) => { setCreations([]); setError(reason instanceof Error ? reason.message : "Could not load your saved creations"); });
  }, []);

  useEffect(load, [load]);

  const toggleSave = useCallback(async (creation: CreationSummary) => {
    const failure = await toggleCreationSave(creation, (state) => setCreations((items) => (items ?? []).map((item) =>
      item.id === creation.id ? { ...item, ...state } : item)));
    if (failure) setNotice(failure);
  }, []);

  return <section className={styles.feed} aria-label="Saved creations">
    <header className={styles.head}>
      {onOpenMenu && <button type="button" className={styles.menuButton} aria-label="Open menu" onClick={onOpenMenu}><Menu size={18} /></button>}
      <span className={styles.eyebrow}>Kept for later</span>
      <h1 className={styles.title}>Saved</h1>
      <p className={styles.lede}>Creations you saved to come back to. Their creators only ever see the total, never who saved or what you play.</p>
    </header>

    {creations === null
      ? <CreationGridSkeleton count={6} />
      : error
        ? <div className={styles.grid}><FeedState
            icon={<Bookmark size={26} />}
            title="Could not load your saved creations"
            description={error}
            action={{ label: "Try again", onClick: load }}
          /></div>
        : creations.length === 0
          ? <div className={styles.grid}><FeedState
              icon={<Bookmark size={26} />}
              title="Nothing saved yet"
              description="Tap the bookmark on any creation in Discover and it will wait for you here."
            /></div>
          : <CreationGrid creations={creations} onToggleSave={toggleSave} />}

    {notice && <div className={styles.toast} role="status">
      {notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss">×</button>
    </div>}
  </section>;
}
