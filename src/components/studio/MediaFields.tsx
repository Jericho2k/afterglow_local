"use client";

import { useState } from "react";
import { ImagePlus, Images, Trash2, Upload, X } from "lucide-react";
import { shareMediaNotice } from "@/lib/content-mode";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import type { CreationDraft, StagedGalleryImage } from "./draft";
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

  return <Field label="Cover image" optional hint="Upload the artwork shown on the feed card and behind the title. PNG, JPEG, WebP or GIF, up to 5 MB.">
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
          placeholder="…or paste a direct image URL"
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
    description="Add up to twelve more images. The gallery section is hidden on the public page while it is empty."
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
    <span className={styles.hint}>Add short public facts worth stating outright. The label is yours to choose — Age, Occupation, Genre, Difficulty. The panel is hidden entirely while this is empty, so leave out anything you would have to invent.</span>
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

/**
 * Which image a link preview should use.
 *
 * The half of the share-media rule a creator owns. Afterglow decides whether an
 * image may leave the site; the creator decides WHICH image is put forward for
 * that decision, and until now they could not — the studio told them previews
 * were reviewed and gave them nothing to submit. A creation's cover was
 * nominated by default and there was no way to say "not that one, this one".
 *
 * Three answers, because there are three images a creation can have: the cover,
 * the desktop banner, and one chosen for this purpose alone. The third exists
 * because the artwork that makes a creation compelling on its own page is not
 * always the artwork that belongs in somebody's work chat, and a creator who
 * knows that needs somewhere to put the quieter picture.
 *
 * Nominating is NOT classifying, and the copy says so rather than implying a
 * choice here changes what is allowed. Changing the nomination sends the new
 * image back to unreviewed — enforced by the server, in the same statement that
 * writes the change — so this control cannot be used to swap an approved image
 * for an unapproved one.
 */
export function ShareImageField({ draft, update, onError }: {
  draft: Pick<CreationDraft, "avatarPath" | "avatarUrl" | "bannerPath" | "bannerUrl" | "shareImagePath" | "shareImageUrl" | "shareMediaStatus">;
  update: (changes: Partial<CreationDraft>) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const sharePath = (draft.shareImagePath ?? "").trim();
  const shareUrl = (draft.shareImageUrl ?? "").trim();
  const bannerPath = (draft.bannerPath ?? "").trim();
  const bannerUrl = (draft.bannerUrl ?? "").trim();
  const nominated = Boolean(sharePath || shareUrl);
  const usesBanner = nominated && ((bannerPath && sharePath === bannerPath) || (bannerUrl && shareUrl === bannerUrl));
  // Nothing nominated means the cover, which is what `nominatedMedia` resolves
  // on the server. "Leave it alone" is an answer rather than an omission.
  const choice: "cover" | "banner" | "custom" = !nominated ? "cover" : usesBanner ? "banner" : "custom";
  const status = draft.shareMediaStatus ?? "unreviewed";

  const cover = avatarSource(characterAvatarBucket, draft.avatarPath, draft.avatarUrl);
  const banner = avatarSource(characterAvatarBucket, bannerPath, bannerUrl);
  const custom = avatarSource(characterAvatarBucket, choice === "custom" ? sharePath : "", choice === "custom" ? shareUrl : "");

  async function uploadShareImage(file: File) {
    setBusy(true);
    try { update({ shareImagePath: await uploadImage(file, characterAvatarBucket), shareImageUrl: "" }); }
    catch (error) { onError(error instanceof Error ? error.message : "Image upload failed"); }
    finally { setBusy(false); }
  }

  const options: { id: typeof choice; label: string; preview: string; available: boolean; select?: () => void }[] = [
    { id: "cover", label: "Cover artwork", preview: cover, available: Boolean(cover), select: () => update({ shareImagePath: "", shareImageUrl: "" }) },
    {
      id: "banner", label: "Desktop banner", preview: banner, available: Boolean(banner),
      // The path is copied rather than referenced, so this is a snapshot of the
      // banner as it stands. Replacing the banner later does not silently
      // re-submit a different picture under an approval granted to this one.
      select: () => update({ shareImagePath: bannerPath, shareImageUrl: bannerPath ? "" : bannerUrl }),
    },
    { id: "custom", label: "Another image", preview: custom, available: true },
  ];

  return <Field
    label="Share image"
    optional
    hint="The image Afterglow composes a link preview around. Your page is unaffected — this is only what leaves the site."
  >
    <div className={styles.shareOptions}>
      {options.map((option) => {
        const selected = choice === option.id;
        const tile = <>
          <span className={styles.shareThumb}>
            {option.preview ? <img src={option.preview} alt="" /> : <ImagePlus size={18} aria-hidden />}
          </span>
          <small>{option.label}</small>
        </>;
        // The third option is a file input rather than a button: choosing it IS
        // uploading, and a radio that opens a file dialog would leave a
        // selected state with nothing behind it.
        if (option.id === "custom") {
          return <label key={option.id} className={styles.shareOption} data-selected={selected || undefined}>
            {tile}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) await uploadShareImage(file);
            }} />
          </label>;
        }
        return <button
          key={option.id}
          type="button"
          className={styles.shareOption}
          data-selected={selected || undefined}
          disabled={!option.available}
          aria-pressed={selected}
          onClick={option.select}
        >{tile}</button>;
      })}
    </div>
    <p className={styles.framingNote}>
      {busy ? "Uploading…" : shareMediaNotice(status)}
    </p>
    <p className={styles.framingNote}>
      Afterglow reviews the image before it can appear outside the site, so choosing a different one sends it back for review.
      You cannot mark your own image safe, and nothing here changes who can read your page.
    </p>
  </Field>;
}
