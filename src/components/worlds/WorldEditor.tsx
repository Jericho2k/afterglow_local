"use client";

import { useEffect, useRef, useState } from "react";
import { Compass, Globe2, ImagePlus, Lock, Trash2, Upload, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { normalizeBlocks, richToText, textToRich, type RichBlock } from "@/lib/rich-content";
import { avatarSource, worldCoverBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import type { CharacterVisibility, World, WorldSummary } from "@/lib/types";
import { RichEditor } from "@/components/rich";
import { ChoiceList, Counter, Field, SectionCard, TextArea, TextInput } from "@/components/studio/fields";
import studio from "@/components/studio/studio.module.css";

/**
 * Creating and editing a world.
 *
 * The old form was from an earlier design generation — a modal with three
 * boxes in it. This is built from the Creation Studio's own field primitives,
 * so a world is authored with the same labels, helper text, inputs and
 * disclosure behaviour as everything else, and deliberately in one page rather
 * than a wizard: a world is a cover, a name, a description, a visibility and
 * some lore, which is not five steps' worth of decision.
 *
 * The lore field is the shared rich editor, which is the surface this feature
 * exists for most: world pages are long-form canon, and a map or a location
 * study between two sections is what makes one readable.
 */
export function WorldEditor({ world, onSaved, onClose, onDeleted }: {
  /** The world being edited, or null when creating one. */
  world: World | WorldSummary | null;
  onSaved: (world: World) => void;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(world?.name ?? "");
  const [description, setDescription] = useState(world?.description ?? "");
  const [content, setContent] = useState("content" in (world ?? {}) ? (world as World).content : "");
  const [blocks, setBlocks] = useState<RichBlock[]>(
    world && "contentRich" in world ? normalizeBlocks((world as World).contentRich) : [],
  );
  const [visibility, setVisibility] = useState<CharacterVisibility>(world?.visibility ?? "private");
  const [coverPath, setCoverPath] = useState(world?.coverPath ?? "");
  const [coverUrl, setCoverUrl] = useState(world?.coverUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const dirty = useRef(false);

  /**
   * Editing a summary loads the rest.
   *
   * The hub's cards deliberately carry no lore, so opening one for editing
   * fetches the full record. What the creator has already typed wins, so a
   * slow response never overwrites their work.
   */
  useEffect(() => {
    if (!world || "content" in world) return;
    let cancelled = false;
    api<{ world: World }>(`/api/worlds/${world.id}`)
      .then(({ world: full }) => {
        if (cancelled || dirty.current) return;
        setContent(full.content);
        setBlocks(normalizeBlocks(full.contentRich));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [world]);

  const cover = avatarSource(worldCoverBucket, coverPath, coverUrl);
  const lore = blocks.length ? richToText(blocks) : content;
  const savable = Boolean(name.trim() && lore.trim()) && !busy;

  function track<T>(setter: (value: T) => void) {
    return (value: T) => { dirty.current = true; setter(value); };
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const payload = {
        name, description, visibility, coverPath, coverUrl,
        // Both halves together, so the lore a prompt reads and the lore a page
        // renders can never describe different worlds.
        content: lore,
        contentRich: blocks.length ? blocks : textToRich(content),
      };
      const saved = await api<{ world: World }>(world ? `/api/worlds/${world.id}` : "/api/worlds", {
        method: world ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      dirty.current = false;
      onSaved(saved.world);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this world");
    } finally { setBusy(false); }
  }

  function close() {
    // The one unsaved-work protection a single-page editor needs: nothing is
    // autosaved here, so leaving with typed changes asks first.
    if (dirty.current && !window.confirm("Leave without saving? Your changes to this world will be lost.")) return;
    onClose();
  }

  return <div className={studio.studio} role="dialog" aria-modal="true" aria-label={world ? `Edit ${world.name}` : "Create a world"}>
    <header className={studio.header}>
      <button type="button" className={studio.iconButton} aria-label="Close" onClick={close}><X size={18} /></button>
      <div className={studio.headerTitle}>
        <strong>{world ? "Edit world" : "Create a world"}</strong>
        <small>{name.trim() || "Reusable setting and lore"}</small>
      </div>
      <span className={studio.headerSpacer} />
    </header>

    <div className={studio.body}>
      <div className={studio.inner}>
        <header className={studio.stepHead}>
          <h2>{world ? "Your world" : "A new world"}</h2>
          <p>A world is the setting a story happens in — rules, places, factions, history. Attach it to as many creations as you like; it stays one document.</p>
        </header>

        {error && <div className={studio.error} role="alert">{error}</div>}

        <Field label="World name" required hint="Name the setting itself, not a story set in it.">
          <TextInput value={name} maxLength={120} onChange={track(setName)} placeholder="What this world is called" />
        </Field>

        <Field label="Cover image" optional hint="Upload the artwork shown on the world card and behind the title. PNG, JPEG, WebP or GIF, up to 5 MB.">
          <div className={studio.coverRow}>
            <div className={studio.coverPreview}>
              {cover ? <img src={cover} alt="" /> : <ImagePlus size={22} aria-hidden />}
            </div>
            <div className={studio.coverActions}>
              <label className={studio.fileButton}>
                <Upload size={15} aria-hidden />{uploading ? "Uploading…" : cover ? "Replace image" : "Upload image"}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={uploading} onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setUploading(true);
                  try { dirty.current = true; setCoverPath(await uploadImage(file, worldCoverBucket)); }
                  catch (reason) { setError(reason instanceof Error ? reason.message : "Image upload failed"); }
                  finally { setUploading(false); }
                }} />
              </label>
              {(coverPath || coverUrl) && <button type="button" className={studio.ghostButton} onClick={() => { dirty.current = true; setCoverPath(""); setCoverUrl(""); }}>
                Remove image
              </button>}
            </div>
          </div>
        </Field>

        <Field label="Short description" optional hint="Write one line for the world card and the top of its page." counter={<Counter value={description.length} max={500} />}>
          <TextArea value={description} maxLength={500} onChange={track(setDescription)} placeholder="One line about this setting" />
        </Field>

        <Field
          label="Lore & canon"
          required
          hint="Write everything the AI should consistently know about this setting: rules, places, factions, history, terminology and constraints. You can place maps and artwork between sections — readers see them, the AI does not."
          counter={<Counter value={lore.length} max={100000} />}
        >
          <RichEditor
            blocks={blocks}
            text={content}
            bucket={worldCoverBucket}
            size="epic"
            onError={setError}
            onChange={({ blocks: next, text }) => { dirty.current = true; setBlocks(next); setContent(text); }}
            placeholder="Write the rules, places, factions and history of this world"
          />
        </Field>

        <SectionCard title="Who can see this" description="A private world still works on your own creations — readers see that it exists without being able to open it.">
          <ChoiceList<CharacterVisibility>
            label="Visibility"
            value={visibility}
            onChange={track(setVisibility)}
            options={[
              { value: "private", label: "Private", description: "Only you. It stays usable on your own creations." },
              { value: "unlisted", label: "Unlisted", description: "Anyone with the link, but never listed for browsing." },
              { value: "public", label: "Public", description: "Listed in Worlds, and anybody can open and save it." },
            ]}
          />
        </SectionCard>

        <p className={studio.hint}>
          {visibility === "public"
            ? <><Compass size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> Public worlds appear in the Worlds hub and can be saved by anybody.</>
            : <><Lock size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> A creation of yours can still use this world. Readers see a locked card rather than the lore.</>}
        </p>

        {world && onDeleted && <button type="button" className={studio.dangerButton} onClick={async () => {
          if (!window.confirm(`Delete the world “${world.name}”?\n\nCreations using it are not deleted — they simply stop having this world attached. This cannot be undone.`)) return;
          setBusy(true);
          try { await api(`/api/worlds/${world.id}`, { method: "DELETE" }); dirty.current = false; onDeleted(); }
          catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete this world"); setBusy(false); }
        }}>
          <Trash2 size={15} aria-hidden />Delete this world
        </button>}
      </div>
    </div>

    <footer className={studio.footer}>
      <div className={studio.footerInner}>
        <button type="button" className={studio.primaryCta} disabled={!savable} onClick={() => void save()}>
          <Globe2 size={17} aria-hidden />{busy ? "Saving…" : world ? "Save changes" : "Create world"}
        </button>
      </div>
    </footer>
  </div>;
}
