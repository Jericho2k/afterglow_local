"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Compass, Globe2, Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { AppMenuButton } from "@/components/ui";
import { toggleWorldSave } from "@/lib/world-saves";
import type { WorldSummary } from "@/lib/types";
import { MoreMenu, type MoreMenuItem } from "@/components/nav";
import { WorldCard, WorldSaveButton } from "@/components/world";
import styles from "./worlds.module.css";

/**
 * The Worlds hub.
 *
 * Three views of one kind of object: what other people published, what this
 * account saved, and what it owns. They share the world card, because a world
 * should look like a world wherever it is met, and they differ only in what
 * each one is allowed to offer — saving on somebody else's, managing on your
 * own, and nothing at all on a world you cannot open.
 *
 * Worlds stay out of the creation feed. A world is a setting rather than
 * something to play, and mixing the two would make Discovery answer two
 * questions badly instead of one well.
 */

type Tab = "discover" | "saved" | "mine";

const tabs: { id: Tab; label: string; scope: string }[] = [
  { id: "discover", label: "Discover", scope: "discover" },
  { id: "saved", label: "Saved", scope: "saved" },
  { id: "mine", label: "Your Worlds", scope: "mine" },
];

export function WorldsHub({ onOpenMenu, onCreate, onEdit, onChanged }: {
  onOpenMenu?: () => void;
  onCreate?: () => void;
  onEdit?: (world: WorldSummary) => void;
  onChanged?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("discover");
  const [worlds, setWorlds] = useState<Record<Tab, WorldSummary[] | null>>({ discover: null, saved: null, mine: null });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback((target: Tab) => {
    const scope = tabs.find((item) => item.id === target)!.scope;
    api<{ worlds: WorldSummary[] }>(`/api/worlds?scope=${scope}`)
      .then((data) => setWorlds((current) => ({ ...current, [target]: data.worlds })))
      .catch((reason) => {
        setWorlds((current) => ({ ...current, [target]: [] }));
        setError(reason instanceof Error ? reason.message : "Could not load worlds");
      });
  }, []);

  // Each tab loads the first time it is opened and is kept afterwards, so
  // moving between them is instant and the saved state stays consistent.
  useEffect(() => { if (worlds[tab] === null) load(tab); }, [load, tab, worlds]);

  const current = worlds[tab];

  /**
   * Saving updates every list that holds this world at once.
   *
   * A world saved from Discover is saved on the Saved tab too, so the two
   * cannot disagree about it while both are loaded.
   */
  const toggleSave = useCallback(async (world: WorldSummary) => {
    const failure = await toggleWorldSave(world, (state) => setWorlds((current) => {
      const next = { ...current };
      for (const key of ["discover", "saved", "mine"] as Tab[]) {
        next[key] = current[key]?.map((item) => item.id === world.id ? { ...item, ...state } : item) ?? null;
      }
      return next;
    }));
    if (failure) setNotice(failure);
    // The saved list is a membership query, so it is refetched rather than
    // patched: unsaving from another tab should remove it, not leave it.
    else if (tab !== "saved") setWorlds((currentWorlds) => ({ ...currentWorlds, saved: null }));
  }, [tab]);

  const remove = useCallback(async (world: WorldSummary) => {
    if (!window.confirm(
      `Delete the world “${world.name}”?\n\n`
      + (world.creationCount > 0
        ? `${world.creationCount} of your creation${world.creationCount === 1 ? "" : "s"} use it. They are not deleted — they simply stop having this world attached.\n\n`
        : "")
      + "This cannot be undone.",
    )) return;
    try {
      const result = await api<{ detachedCreations: number }>(`/api/worlds/${world.id}`, { method: "DELETE" });
      setWorlds({ discover: null, saved: null, mine: null });
      setNotice(result.detachedCreations
        ? `“${world.name}” was deleted and detached from ${result.detachedCreations} creation${result.detachedCreations === 1 ? "" : "s"}.`
        : `“${world.name}” was deleted.`);
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete that world");
    }
  }, [onChanged]);

  const emptyState = useMemo(() => ({
    discover: { title: "No published worlds yet", body: "When creators publish a world it appears here, ready to attach to anything you make." },
    saved: { title: "Nothing saved yet", body: "Save any public world and it waits for you here, ready to attach to your own creations." },
    mine: { title: "You have not made a world yet", body: "A world is reusable setting and lore — rules, factions, places, history — that any number of your creations can share." },
  }[tab]), [tab]);

  return <section className={styles.page} aria-label="Worlds">
    <header className={styles.head}>
      {onOpenMenu && <AppMenuButton className={styles.menuButton} onOpen={onOpenMenu} />}
      <span className={styles.eyebrow}>Reusable settings and lore</span>
      <h1 className={styles.title}>Worlds</h1>
      <p className={styles.lede}>A world is the setting a story happens in. Attach one to any number of creations, and it stays one document.</p>
      {onCreate && <button type="button" className={styles.createButton} onClick={onCreate}>
        <Plus size={16} aria-hidden />Create a world
      </button>}
    </header>

    <div className={styles.tabs} role="group" aria-label="Which worlds to show">
      {tabs.map((item) => <button
        key={item.id}
        type="button"
        aria-pressed={tab === item.id}
        className={`${styles.tab} ${tab === item.id ? styles.tabActive : ""}`}
        onClick={() => setTab(item.id)}
      >{item.label}</button>)}
    </div>

    {current === null
      ? <div className={styles.grid} aria-hidden>{Array.from({ length: 4 }, (_, index) => <div key={index} className={styles.skeleton} />)}</div>
      : current.length === 0
        ? <div className={styles.state} role="status">
          <Globe2 size={26} />
          <h2>{emptyState.title}</h2>
          <p>{emptyState.body}</p>
          {tab === "mine" && onCreate && <button type="button" className={styles.stateAction} onClick={onCreate}>Create your first world</button>}
          {tab === "saved" && <button type="button" className={styles.stateAction} onClick={() => setTab("discover")}>Browse worlds</button>}
        </div>
        : <div className={styles.grid}>
          {current.map((world) => {
            const owned = world.ownedByViewer;
            const items: MoreMenuItem[] = owned && onEdit ? [
              { label: "Edit world", icon: <Pencil size={16} aria-hidden />, onSelect: () => onEdit(world) },
              { label: "Delete world", icon: <Trash2 size={16} aria-hidden />, danger: true, onSelect: () => void remove(world) },
            ] : [];
            return <div key={world.id} className={styles.cell}>
              <WorldCard
                world={world}
                variant="feature"
                meta={<>
                  {/* Visibility is shown on your own worlds, where it is the
                      thing you manage by, and nowhere else — a reader browsing
                      Discover already knows everything there is public. */}
                  {owned && <span className={styles.visibility}>
                    {world.visibility === "public" ? <><Compass size={11} aria-hidden />Public</> : <><Lock size={11} aria-hidden />Private</>}
                  </span>}
                  {world.creationCount > 0 && <span>{world.creationCount} creation{world.creationCount === 1 ? "" : "s"}</span>}
                  {world.saveCount > 0 && <span>{world.saveCount} save{world.saveCount === 1 ? "" : "s"}</span>}
                </>}
                action={owned
                  ? (items.length ? <MoreMenu className={styles.cardMenuButton} label={`Manage ${world.name}`} items={items} /> : undefined)
                  // Saving your own world is not a thing the backend allows,
                  // so an owner's card has no save control rather than a
                  // failing one.
                  : <WorldSaveButton saved={world.savedByViewer} count={world.saveCount} name={world.name} onToggle={() => void toggleSave(world)} />}
              />
            </div>;
          })}
        </div>}

    {notice && <div className={styles.toast} role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} aria-hidden /></button></div>}
    {error && <div className={styles.toast} role="alert">{error}<button type="button" onClick={() => { setError(""); load(tab); }} aria-label="Dismiss"><X size={14} aria-hidden /></button></div>}
  </section>;
}
