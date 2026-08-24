"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Trash2, Type } from "lucide-react";
import { avatarSource } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import { maxBlockText, maxBlocks, maxCaption, normalizeBlocks, richToText, textToRich, type RichBlock } from "@/lib/rich-content";
import styles from "./editor.module.css";

/**
 * Writing rich content.
 *
 * Deliberately small: text and images, in an order the creator controls. It is
 * not a document editor and should not become one — the feature is "put a
 * picture between two paragraphs", and a schema that can express only that is
 * a schema that cannot carry a surprise.
 *
 * The editor opens in plain mode for content that has no images, which is
 * every creation written so far: the field looks and behaves exactly like the
 * textarea it has always been until somebody adds a picture, and it goes back
 * to being one if they remove the last one.
 */
export function RichEditor({ blocks, text, bucket, onChange, placeholder, size = "tall", onError }: {
  blocks: RichBlock[];
  /** The plain text the field currently holds, for content with no blocks yet. */
  text: string;
  bucket: string;
  /** Receives both halves, because the two are always decided together. */
  onChange: (value: { blocks: RichBlock[]; text: string }) => void;
  placeholder?: string;
  size?: "tall" | "epic";
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const normalized = normalizeBlocks(blocks);
  const hasImages = normalized.some((block) => block.type === "image");
  // Plain content is edited as plain text. Only once there is an image does
  // the block list become the thing on screen.
  const editing = hasImages ? normalized : textToRich(text);

  function commit(next: RichBlock[]) {
    const cleaned = normalizeBlocks(next);
    onChange({ blocks: cleaned, text: richToText(cleaned) });
  }

  function setBlockText(index: number, value: string) {
    // An emptied text block is kept while it is being edited — deleting the
    // last character must not make the box the creator is typing in vanish.
    const next = editing.map((block, position) => position === index && block.type === "text" ? { ...block, text: value } : block);
    if (!hasImages) { onChange({ blocks: [], text: value }); return; }
    onChange({ blocks: normalizeBlocks(next), text: richToText(next.filter((block): block is RichBlock & { type: "text" } => block.type === "text")) });
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= editing.length) return;
    const next = [...editing];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  }

  async function addImage(file: File) {
    setBusy(true);
    try {
      const path = await uploadImage(file, bucket);
      // A new image goes at the end, followed by a fresh paragraph to carry on
      // writing in — which is the shape people actually want after inserting
      // one, rather than a cursor stranded above it.
      commit([...editing, { type: "image", path, url: "", caption: "" }, { type: "text", text: "" }]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Image upload failed");
    } finally { setBusy(false); }
  }

  return <div className={styles.editor}>
    {editing.length === 0 && <textarea
      className={`${styles.textarea} ${size === "epic" ? styles.epic : styles.tall}`}
      value=""
      maxLength={maxBlockText}
      placeholder={placeholder}
      onChange={(event) => onChange({ blocks: [], text: event.target.value })}
    />}

    {editing.map((block, index) => block.type === "text"
      ? <div key={index} className={styles.textBlock}>
        <textarea
          className={`${styles.textarea} ${hasImages ? styles.compact : size === "epic" ? styles.epic : styles.tall}`}
          value={block.text}
          maxLength={maxBlockText}
          placeholder={index === 0 ? placeholder : "Keep writing…"}
          onChange={(event) => setBlockText(index, event.target.value)}
        />
        {hasImages && <BlockControls
          index={index}
          count={editing.length}
          onMove={move}
          onRemove={() => commit(editing.filter((_, position) => position !== index))}
          label="text section"
        />}
      </div>
      : <figure key={index} className={styles.imageBlock}>
        <img src={avatarSource(bucket, block.path, block.url)} alt={block.caption} />
        <input
          className={styles.caption}
          value={block.caption}
          maxLength={maxCaption}
          placeholder="Caption (optional)"
          aria-label={`Caption for image ${index + 1}`}
          onChange={(event) => commit(editing.map((item, position) =>
            position === index && item.type === "image" ? { ...item, caption: event.target.value } : item))}
        />
        <BlockControls
          index={index}
          count={editing.length}
          onMove={move}
          onRemove={() => commit(editing.filter((_, position) => position !== index))}
          label="image"
        />
      </figure>)}

    <div className={styles.tools}>
      <button
        type="button"
        className={styles.tool}
        disabled={busy || editing.length >= maxBlocks}
        onClick={() => fileInput.current?.click()}
      >
        <ImagePlus size={15} aria-hidden />{busy ? "Uploading…" : "Add an image"}
      </button>
      {hasImages && <button
        type="button"
        className={styles.tool}
        disabled={editing.length >= maxBlocks}
        onClick={() => commit([...editing, { type: "text", text: "" }])}
      >
        <Type size={15} aria-hidden />Add a text section
      </button>}
      <input
        ref={fileInput}
        type="file"
        className={styles.srOnly}
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) await addImage(file);
        }}
      />
    </div>
    {hasImages && <p className={styles.note}>
      Images are decoration for readers. The AI receives only the words, so a creation with pictures needs nothing special to run.
    </p>}
  </div>;
}

/** Reorder and remove, kept identical for both kinds of block. */
function BlockControls({ index, count, onMove, onRemove, label }: {
  index: number;
  count: number;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: () => void;
  label: string;
}) {
  return <div className={styles.blockControls}>
    <button type="button" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUp size={14} /></button>
    <button type="button" aria-label={`Move ${label} down`} disabled={index === count - 1} onClick={() => onMove(index, 1)}><ArrowDown size={14} /></button>
    <button type="button" className={styles.remove} aria-label={`Remove ${label}`} onClick={onRemove}><Trash2 size={14} /></button>
  </div>;
}
