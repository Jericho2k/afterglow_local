"use client";

import { avatarSource } from "@/lib/storage";
import { maxBlockText, renderableBlocks, type RichBlock } from "@/lib/rich-content";
import { StyledProse } from "./StyledText";
import styles from "./rich.module.css";

/**
 * Rendering rich content.
 *
 * One renderer for the three surfaces that carry it — a creation's public
 * description, a world's lore and an opening message — so an image looks like
 * an image wherever a creator put one.
 *
 * Everything here is ordinary React, which is what makes it safe: text is a
 * child node and never markup, a caption is a child node and never markup, and
 * an image's source is a validated path or an http(s) URL decided long before
 * it reaches this component. There is no `dangerouslySetInnerHTML` in this
 * feature, at any layer.
 */
export function RichContent({ blocks, text, bucket, className = "", imageSize = "full", maxTextLength = maxBlockText }: {
  blocks: RichBlock[] | null | undefined;
  /** The plain text this content falls back to. Every legacy record is this. */
  text: string;
  /** Which storage bucket the image paths belong to. */
  bucket: string;
  className?: string;
  /** `inset` narrows images inside a already-narrow column, such as a chat. */
  imageSize?: "full" | "inset";
  /**
   * The field's own text ceiling. World lore is allowed far more than a
   * creation description, and rendering must not be the place a document is
   * quietly shortened.
   */
  maxTextLength?: number;
}) {
  const resolved = renderableBlocks(blocks, text, maxTextLength);
  if (!resolved.length) return null;

  return <div className={`${styles.content} ${className}`}>
    {resolved.map((block, index) => {
      if (block.type === "text") {
        // Whitespace is preserved by CSS rather than by parsing the text into
        // markup, so a paragraph break stays a paragraph break. Emphasis is the
        // one thing that IS read, because a description pasted in from
        // somewhere else routinely carries `**` and showing those characters is
        // not "not interpreting" the prose — it is rendering it wrongly. It
        // still becomes an element, never markup: see StyledText.
        return <p key={index} className={styles.paragraph}><StyledProse text={block.text} /></p>;
      }
      const source = avatarSource(bucket, block.path, block.url);
      if (!source) return null;
      return <figure key={index} className={`${styles.figure} ${imageSize === "inset" ? styles.inset : ""}`}>
        <img src={source} alt={block.caption} loading="lazy" decoding="async" />
        {block.caption && <figcaption>{block.caption}</figcaption>}
      </figure>;
    })}
  </div>;
}
