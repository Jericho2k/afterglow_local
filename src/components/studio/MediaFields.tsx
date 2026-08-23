"use client";

import { useState } from "react";
import { ImagePlus, Images, Trash2, Upload, X } from "lucide-react";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import type { StagedGalleryImage } from "./draft";
import { Field, SectionCard, TextInput } from "./fields";
import styles from "./studio.module.css";

/**
 * Cover art.
 *
 * Upload and direct image link are both preserved because imported cards
 * frequently arrive with an external URL and no file. There is no "generate
 * with AI" action: this deployment has no image generation, and an button that
 * cannot work is worse than no button.
 */
export function CoverPicker({ avatarPath, avatarUrl, accent, onChange, onError }: {
  avatarPath: string;
  avatarUrl: string;
  accent: string;
  onChange: (value: { avatarPath?: string; avatarUrl?: string }) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const preview = avatarSource(characterAvatarBucket, avatarPath, avatarUrl);

  async function upload(file: File) {
    setBusy(true);
    try { onChange({ avatarPath: await uploadImage(file, characterAvatarBucket) }); }
    catch (error) { onError(error instanceof Error ? error.message : "Image upload failed"); }
    finally { setBusy(false); }
  }

  return <Field label="Cover image" optional hint="Shown on the feed card and behind the title. PNG, JPEG, WebP or GIF up to 5 MB.">
    <div className={styles.coverRow}>
      <div className={styles.coverPreview} style={{ "--accent": accent } as React.CSSProperties}>
        {preview ? <img src={preview} alt="" /> : <ImagePlus size={22} aria-hidden />}
      </div>
      <div className={styles.coverActions}>
        <label className={styles.fileButton}>
          <Upload size={15} aria-hidden />{busy ? "Uploading…" : preview ? "Replace image" : "Upload image"}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) await upload(file);
          }} />
        </label>
        {(avatarPath || avatarUrl) && <button type="button" className={styles.ghostButton} onClick={() => onChange({ avatarPath: "", avatarUrl: "" })}>
          Remove image
        </button>}
        <TextInput
          value={avatarUrl.startsWith("data:") ? "" : avatarUrl}
          onChange={(value) => onChange({ avatarUrl: value })}
          placeholder="…or paste an image URL"
        />
      </div>
    </div>
  </Field>;
}

/**
 * Gallery.
 *
 * The public page already renders a gallery; until now nothing could author
 * one. Images are staged in the draft and written through the gallery endpoint
 * once the creation has an id.
 */
export function GalleryEditor({ images, onChange, onError }: {
  images: StagedGalleryImage[];
  onChange: (images: StagedGalleryImage[]) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function add(files: FileList) {
    setBusy(true);
    try {
      const uploaded: StagedGalleryImage[] = [];
      for (const file of Array.from(files).slice(0, 12 - images.length)) {
        uploaded.push({ storagePath: await uploadImage(file, characterAvatarBucket), externalUrl: "", caption: "" });
      }
      onChange([...images, ...uploaded].slice(0, 12));
    } catch (error) { onError(error instanceof Error ? error.message : "Image upload failed"); }
    finally { setBusy(false); }
  }

  return <SectionCard
    icon={<Images size={17} aria-hidden />}
    title="Gallery"
    description="Up to twelve extra images. The gallery section is hidden on the public page when it is empty."
  >
    <div className={styles.galleryGrid}>
      {images.map((image, index) => {
        const source = avatarSource(characterAvatarBucket, image.storagePath, image.externalUrl);
        return <div key={`${image.storagePath}${image.externalUrl}${index}`} className={styles.galleryItem}>
          {source && <img src={source} alt={image.caption} />}
          <button
            type="button"
            className={styles.galleryRemove}
            aria-label={`Remove gallery image ${index + 1}`}
            onClick={() => onChange(images.filter((_, position) => position !== index))}
          ><Trash2 size={13} /></button>
        </div>;
      })}
      {images.length < 12 && <label className={styles.galleryAdd}>
        {busy ? "…" : <ImagePlus size={19} aria-hidden />}
        <span className={styles.srOnly}>Add gallery images</span>
        <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={async (event) => {
          const files = event.target.files;
          if (files?.length) await add(files);
          event.target.value = "";
        }} />
      </label>}
    </div>
  </SectionCard>;
}

/** Optional public label/value facts. Free-form labels, never a fixed schema. */
export function QuickFactsEditor({ facts, onChange }: {
  facts: { label: string; value: string }[];
  onChange: (facts: { label: string; value: string }[]) => void;
}) {
  return <div className={styles.field}>
    <span className={styles.fieldLabel}>Quick facts<span className={styles.optional}>up to six</span></span>
    <span className={styles.hint}>Any label you like — Age, Occupation, Genre, Difficulty. Shown as a small public panel, and hidden entirely when empty.</span>
    {facts.map((fact, index) => <div key={index} className={styles.inlineRow}>
      <input
        className={styles.input}
        value={fact.label}
        maxLength={40}
        placeholder="Label"
        aria-label={`Fact ${index + 1} label`}
        onChange={(event) => onChange(facts.map((item, position) => position === index ? { ...item, label: event.target.value } : item))}
      />
      <input
        className={styles.input}
        value={fact.value}
        maxLength={120}
        placeholder="Value"
        aria-label={`Fact ${index + 1} value`}
        onChange={(event) => onChange(facts.map((item, position) => position === index ? { ...item, value: event.target.value } : item))}
      />
      <button
        type="button"
        className={styles.miniButton}
        aria-label={`Remove fact ${index + 1}`}
        onClick={() => onChange(facts.filter((_, position) => position !== index))}
      ><X size={15} /></button>
    </div>)}
    <button type="button" className={styles.addButton} disabled={facts.length >= 6} onClick={() => onChange([...facts, { label: "", value: "" }])}>
      Add a fact
    </button>
  </div>;
}
