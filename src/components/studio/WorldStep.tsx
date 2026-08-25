"use client";

import { useState } from "react";
import { Check, Globe2, Map, Plus, Upload, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { maxLoreBlockText } from "@/lib/rich-content";
import { avatarSource, worldCoverBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import type { World, WorldSummary } from "@/lib/types";
import { Counter, Field, TextArea, TextInput } from "./fields";
import type { CreationDraft } from "./draft";
import styles from "./studio.module.css";

/**
 * A world as the studio's picker knows one.
 *
 * Built on `WorldSummary`, not `World`, because that is what `/api/worlds`
 * actually returns — card columns with no lore in them. Declaring it as a full
 * `World` was a lie the compiler could not catch, and it crashed this step:
 * the card below read `world.content.length` on a value that was never sent,
 * so opening the World step with any world whose short description was empty
 * threw and took the whole shell down with it.
 */
export type StudioWorld = WorldSummary & { characterCount?: number };

/** A freshly created world, reduced to what a picker card needs. */
export function studioWorldFromRecord(world: World, characterCount = 0): StudioWorld {
  return {
    id: world.id, name: world.name, description: world.description,
    coverPath: world.coverPath, coverUrl: world.coverUrl, visibility: world.visibility,
    saveCount: world.saveCount, savedByViewer: world.savedByViewer, ownedByViewer: world.ownedByViewer,
    creationCount: characterCount, creator: world.creator, updatedAt: world.updatedAt,
    characterCount,
  };
}

/**
 * Worlds.
 *
 * A World is a reusable entity with its own page, cover and lore — not a text
 * field on this creation. The scenario describes what is happening here; the
 * World describes the setting that outlives it and can be attached to any
 * number of creations.
 */
export function WorldStep({ draft, update, worlds, onWorldCreated, onError }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  worlds: StudioWorld[];
  onWorldCreated: (world: StudioWorld) => void;
  onError: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const attached = worlds.filter((world) => draft.worldIds.includes(world.id));
  const available = worlds.filter((world) => !draft.worldIds.includes(world.id));

  function toggle(id: string) {
    update({ worldIds: draft.worldIds.includes(id) ? draft.worldIds.filter((item) => item !== id) : [...draft.worldIds, id] });
  }

  return <>
    <header className={styles.stepHead}>
      <h2>World</h2>
      <p>Attach setting and lore you want to reuse across creations. Optional — a creation that needs no shared world simply skips this step.</p>
    </header>

    {attached.length > 0 && <div className={styles.field}>
      <span className={styles.fieldLabel}>Attached</span>
      <div className={styles.worldList}>
        {attached.map((world) => <WorldCard key={world.id} world={world} selected onToggle={() => toggle(world.id)} />)}
      </div>
    </div>}

    {available.length > 0 && <div className={styles.field}>
      <span className={styles.fieldLabel}>{attached.length ? "Attach another" : "Your worlds"}</span>
      <span className={styles.hint}>Select any world this creation takes place in. The same world document can belong to any number of creations.</span>
      <div className={styles.worldList}>
        {available.map((world) => <WorldCard key={world.id} world={world} selected={false} onToggle={() => toggle(world.id)} />)}
      </div>
    </div>}

    {!worlds.length && <p className={styles.emptyNote}>You have no reusable worlds yet. Create one here and it becomes its own page, attachable to anything you make later.</p>}

    {creating
      ? <WorldCreator
        onCancel={() => setCreating(false)}
        onError={onError}
        onCreated={(world) => {
          onWorldCreated(world);
          update({ worldIds: [...draft.worldIds, world.id] });
          setCreating(false);
        }}
      />
      : <button type="button" className={styles.addButton} onClick={() => setCreating(true)}>
        <Plus size={16} aria-hidden />Create a new world
      </button>}

    {draft.lorebook.trim() && <Field
      label={draft.proposedWorld ? `Proposed world · ${draft.proposedWorld.name}` : "Imported world draft"}
      hint="World material separated out of your import. Review or edit it here — saving turns it into a reusable World and attaches it to this creation. Clear the text to keep it as part of the creation instead."
      counter={<Counter value={draft.lorebook.length} max={50000} />}
    >
      <TextArea value={draft.lorebook} maxLength={50000} size="tall" onChange={(value) => update({ lorebook: value })} />
    </Field>}
  </>;
}

function WorldCard({ world, selected, onToggle }: { world: StudioWorld; selected: boolean; onToggle: () => void }) {
  const cover = avatarSource(worldCoverBucket, world.coverPath, world.coverUrl);
  return <button type="button" className={`${styles.worldCard} ${selected ? styles.worldSelected : ""}`} aria-pressed={selected} onClick={onToggle}>
    <span className={styles.worldArt}>
      {cover ? <img src={cover} alt="" /> : <Map size={20} aria-hidden />}
      <span className={styles.worldArtScrim} aria-hidden />
    </span>
    <span className={styles.worldCopy}>
      <strong>{world.name}</strong>
      {/* A card describes a world; it never reaches for the lore, which a
          listing deliberately does not carry. */}
      <p>{world.description || "Reusable setting and lore"}</p>
      <span>{world.characterCount ? `Used by ${world.characterCount} creation${world.characterCount === 1 ? "" : "s"}` : "Not attached anywhere else yet"}</span>
    </span>
    {selected && <span className={styles.worldMark} aria-hidden><Check size={14} /></span>}
  </button>;
}

function WorldCreator({ onCreated, onCancel, onError }: {
  onCreated: (world: StudioWorld) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [coverPath, setCoverPath] = useState("");
  const [busy, setBusy] = useState(false);
  const cover = avatarSource(worldCoverBucket, coverPath, "");

  async function create() {
    setBusy(true);
    try {
      const data = await api<{ world: World }>("/api/worlds", {
        method: "POST",
        body: JSON.stringify({ name, description, content, coverPath, coverUrl: "", visibility: "private" }),
      });
      onCreated(studioWorldFromRecord(data.world));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not create that world");
    } finally { setBusy(false); }
  }

  return <section className={styles.card}>
    <div className={styles.cardHead}>
      <Globe2 size={17} aria-hidden />
      <div><strong>New world</strong><small>Lore, factions, rules and locations that any creation can reuse.</small></div>
      <button type="button" className={styles.iconButton} aria-label="Cancel new world" onClick={onCancel}><X size={17} /></button>
    </div>
    <div className={styles.coverRow}>
      <div className={styles.coverPreview} style={{ width: 88, height: 110 }}>
        {cover ? <img src={cover} alt="" /> : <Map size={20} aria-hidden />}
      </div>
      <div className={styles.coverActions}>
        <label className={styles.fileButton}>
          <Upload size={15} aria-hidden />{cover ? "Replace cover" : "Cover image"}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            try { setCoverPath(await uploadImage(file, worldCoverBucket)); }
            catch (error) { onError(error instanceof Error ? error.message : "Image upload failed"); }
          }} />
        </label>
      </div>
    </div>
    <Field label="World name" required hint="Name the setting itself, not a creation set in it.">
      <TextInput value={name} maxLength={120} onChange={setName} placeholder="What this world is called" />
    </Field>
    <Field label="Short description" optional hint="Write one line for the world card.">
      <TextInput value={description} maxLength={500} onChange={setDescription} placeholder="One line about this setting" />
    </Field>
    <Field label="World canon" required hint="Write everything the AI should consistently know about this setting: rules, factions, locations, history, terminology and constraints." counter={<Counter value={content.length} max={maxLoreBlockText} />}>
      <TextArea value={content} maxLength={maxLoreBlockText} size="tall" onChange={setContent} placeholder="Write the rules, places, factions and history of this world" />
    </Field>
    <button type="button" className={styles.primaryCta} disabled={busy || !name.trim() || !content.trim()} onClick={() => void create()}>
      {busy ? "Creating…" : "Create & attach"}
    </button>
  </section>;
}
