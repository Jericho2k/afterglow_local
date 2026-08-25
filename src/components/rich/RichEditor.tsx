"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Trash2, Type } from "lucide-react";
import { avatarSource } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import { maxBlockText, maxBlocks, maxCaption, normalizeBlocks, type RichBlock } from "@/lib/rich-content";
import { addImage, addTextSection, collapseIfPlain, editorStateFrom, hasImages, moveBlock, removeBlock, setBlockText, setCaption, storedValue, type EditorState } from "./editor-state";
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
export function RichEditor({ blocks, text, bucket, onChange, placeholder, size = "tall", onError, maxTextLength = maxBlockText }: {
  blocks: RichBlock[];
  /** The plain text the field currently holds, for content with no blocks yet. */
  text: string;
  bucket: string;
  /** Receives both halves, because the two are always decided together. */
  onChange: (value: { blocks: RichBlock[]; text: string }) => void;
  placeholder?: string;
  size?: "tall" | "epic";
  onError: (message: string) => void;
  /** The field's own text ceiling, which is not the same for every surface. */
  maxTextLength?: number;
}) {
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /*
   * Editing state and stored state are not the same thing.
   *
   * They used to be. `editing` was derived straight from the props on every
   * render, and the props had already been through `normalizeBlocks`, which
   * drops any text block with nothing in it. That is correct for what gets
   * SAVED — an empty paragraph is not content — and completely wrong for what
   * is being TYPED, because a text block starts empty. It is why "Add a text
   * section" appeared to do nothing: the block was created and normalised away
   * inside the same call, so nothing ever reached the screen. The same
   * collapse deleted the box out from under anyone who removed the last
   * character of a paragraph they were still writing in.
   *
   * So the editor keeps its own draft, which tolerates an empty block for
   * exactly as long as the creator needs it to. Normalisation still happens —
   * on the way out, where it belongs — so an empty paragraph is never
   * persisted, and the canonical text column is written from the cleaned list
   * as it always was.
   */
  /*
   * Editing state and stored state are not the same thing.
   *
   * They used to be. The rendered list was derived straight from the props on
   * every render, and the props had already been through `normalizeBlocks`,
   * which exists to drop text blocks with nothing in them. That is correct for
   * what gets SAVED and completely wrong for what is being TYPED, because
   * every paragraph is empty for the moment before it is written in. It is why
   * "Add a text section" appeared to do nothing — the block was created and
   * normalised away inside one call — and why the box vanished from under
   * anyone who deleted the last character of a paragraph.
   *
   * The algebra lives in ./editor-state.ts so it can be asserted rather than
   * clicked through; this component only draws it and reports what would be
   * stored.
   */
  const incoming = normalizeBlocks(blocks, maxTextLength);
  const [draft, setDraft] = useState<EditorState>(() => editorStateFrom(blocks, text, maxTextLength));
  // What this component last handed upward, so a parent echoing our own value
  // back is not mistaken for someone else replacing the content.
  const emitted = useRef<string>(JSON.stringify({ blocks: incoming, text }));

  useEffect(() => {
    const next = JSON.stringify({ blocks: normalizeBlocks(blocks, maxTextLength), text });
    if (next === emitted.current) return;
    emitted.current = next;
    setDraft(editorStateFrom(blocks, text, maxTextLength));
  }, [blocks, text, maxTextLength]);

  const editing = draft;
  const withImages = hasImages(editing);

  /** Accept a new editing state and report what would be saved for it. */
  function apply(next: EditorState) {
    const collapsed = collapseIfPlain(next);
    setDraft(collapsed);
    const value = storedValue(collapsed, maxTextLength);
    emitted.current = JSON.stringify({ blocks: normalizeBlocks(value.blocks, maxTextLength), text: value.text });
    onChange(value);
  }

  function setText(index: number, value: string) {
    apply(setBlockText(editing, index, value));
  }

  function move(index: number, direction: -1 | 1) {
    apply(moveBlock(editing, index, direction));
  }

  async function uploadAndInsert(file: File) {
    setBusy(true);
    try {
      const path = await uploadImage(file, bucket);
      // A new image goes at the end, followed by a fresh paragraph to carry on
      // writing in — which is the shape people actually want after inserting
      // one, rather than a cursor stranded above it.
      apply(addImage(editing, path));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Image upload failed");
    } finally { setBusy(false); }
  }

  return <div className={styles.editor}>
    {editing.map((block, index) => block.type === "text"
      ? <div key={index} className={styles.textBlock}>
        <textarea
          className={`${styles.textarea} ${withImages ? styles.compact : size === "epic" ? styles.epic : styles.tall}`}
          value={block.text}
          maxLength={maxTextLength}
          placeholder={index === 0 ? placeholder : "Keep writing…"}
          onChange={(event) => setText(index, event.target.value)}
        />
        {withImages && <BlockControls
          index={index}
          count={editing.length}
          onMove={move}
          onRemove={() => apply(removeBlock(editing, index))}
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
          onChange={(event) => apply(setCaption(editing, index, event.target.value))}
        />
        <BlockControls
          index={index}
          count={editing.length}
          onMove={move}
          onRemove={() => apply(removeBlock(editing, index))}
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
      {withImages && <button
        type="button"
        className={styles.tool}
        disabled={editing.length >= maxBlocks}
        onClick={() => apply(addTextSection(editing))}
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
          if (file) await uploadAndInsert(file);
        }}
      />
    </div>
    {withImages && <p className={styles.note}>
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
