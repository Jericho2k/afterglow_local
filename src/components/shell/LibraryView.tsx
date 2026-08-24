"use client";

import { useCallback, useEffect, useState } from "react";
import { Bookmark, Globe2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { toggleCreationSave } from "@/lib/saves";
import { toggleWorldSave } from "@/lib/world-saves";
import type { CreationSummary, WorldSummary } from "@/lib/types";
import { CreationGrid, CreationGridSkeleton, FeedState } from "@/components/feed";
import { WorldCard, WorldSaveButton } from "@/components/world";
import { PageHeader } from "./PageHeader";
import styles from "./shell.module.css";

/**
 * Saved.
 *
 * Afterglow now saves two kinds of thing, and they had ended up in two
 * unrelated places: creations on their own page and worlds inside a tab of the
 * Worlds hub. One library, two tabs.
 *
 * It is a second VIEW of existing data, never a second store: the cards are the
 * canonical `CreationCard` and `WorldCard`, the writes go through the same
 * `/api/saves` and `/api/world-saves` relations the feed uses, and no new
 * bookmark concept is introduced. Each tab is a summary query — covers, names
 * and counts — so opening the library never loads lore or definitions.
 */

type Tab = "creations" | "worlds";

export function LibraryView({ onOpenMenu }: { onOpenMenu?: () => void }) {
  const [tab, setTab] = useState<Tab>("creations");
  const [creations, setCreations] = useState<CreationSummary[] | null>(null);
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadCreations = useCallback(() => {
    setError("");
    api<{ creations: CreationSummary[] }>("/api/saves")
      .then((data) => setCreations(data.creations))
      .catch((reason) => { setCreations([]); setError(reason instanceof Error ? reason.message : "Could not load your saved creations"); });
  }, []);

  const loadWorlds = useCallback(() => {
    setError("");
    api<{ worlds: WorldSummary[] }>("/api/worlds?scope=saved")
      .then((data) => setWorlds(data.worlds))
      .catch((reason) => { setWorlds([]); setError(reason instanceof Error ? reason.message : "Could not load your saved worlds"); });
  }, []);

  // Each tab loads once, the first time it is opened, and is kept afterwards.
  useEffect(() => {
    if (tab === "creations" && creations === null) loadCreations();
    if (tab === "worlds" && worlds === null) loadWorlds();
  }, [tab, creations, worlds, loadCreations, loadWorlds]);

  /** Unsaving leaves the card in place rather than making it vanish mid-tap. */
  const toggleCreation = useCallback(async (creation: CreationSummary) => {
    const failure = await toggleCreationSave(creation, (state) => setCreations((items) => (items ?? []).map((item) =>
      item.id === creation.id ? { ...item, ...state } : item)));
    if (failure) setNotice(failure);
  }, []);

  const toggleWorld = useCallback(async (world: WorldSummary) => {
    const failure = await toggleWorldSave(world, (state) => setWorlds((items) => (items ?? []).map((item) =>
      item.id === world.id ? { ...item, ...state } : item)));
    if (failure) setNotice(failure);
  }, []);

  return <section className={styles.page} aria-label="Saved">
    <div className={styles.inner}>
      <PageHeader
        eyebrow="Kept for later"
        title="Saved"
        lede="Everything you bookmarked, in one place. Creators only ever see the total — never who saved, and never what you play."
        onOpenMenu={onOpenMenu}
      />

      <div className={styles.tabs} role="tablist" aria-label="Saved">
        {([["creations", "Creations", creations], ["worlds", "Worlds", worlds]] as const).map(([id, label, items]) => <button
          key={id}
          role="tab"
          aria-selected={tab === id}
          className={`${styles.tab} ${tab === id ? styles.tabActive : ""}`}
          onClick={() => setTab(id)}
        >{label}{items ? <em>{items.length}</em> : null}</button>)}
      </div>

      {tab === "creations" && (creations === null
        ? <CreationGridSkeleton count={6} />
        : error
          ? <FeedState icon={<Bookmark size={26} />} title="Could not load your saved creations" description={error} action={{ label: "Try again", onClick: loadCreations }} />
          : creations.length === 0
            ? <div className={styles.empty}>
                <Bookmark size={26} aria-hidden />
                <h2>Nothing saved yet</h2>
                <p>Tap the bookmark on any creation in Discover and it will wait for you here.</p>
              </div>
            : <CreationGrid creations={creations} onToggleSave={toggleCreation} />)}

      {tab === "worlds" && (worlds === null
        ? <p className={styles.quiet}>Loading your saved worlds…</p>
        : error
          ? <FeedState icon={<Globe2 size={26} />} title="Could not load your saved worlds" description={error} action={{ label: "Try again", onClick: loadWorlds }} />
          : worlds.length === 0
            ? <div className={styles.empty}>
                <Globe2 size={26} aria-hidden />
                <h2>No saved worlds</h2>
                <p>Worlds are reusable canon other creators published. Save one and it is here whenever you build something inside it.</p>
              </div>
            : <div className={styles.grid}>
                {worlds.map((world) => <WorldCard
                  key={world.id}
                  world={world}
                  variant="feature"
                  // The canonical control, not a look-alike: one save button
                  // means one behaviour and one appearance wherever a world is.
                  action={<WorldSaveButton
                    saved={world.savedByViewer}
                    count={world.saveCount}
                    name={world.name}
                    onToggle={() => void toggleWorld(world)}
                  />}
                />)}
              </div>)}

      {notice && <p className={styles.error} style={{ marginTop: 16 }} role="status">{notice}</p>}
    </div>
  </section>;
}
