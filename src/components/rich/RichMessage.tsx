"use client";

import { avatarSource } from "@/lib/storage";
import { StyledMessage } from "./StyledText";
import { normalizeBlocks, type RichBlock } from "@/lib/rich-content";
import styles from "./rich.module.css";

/**
 * An opening message rendered in the chat.
 *
 * The only place rich content appears inside a conversation, and it appears
 * without changing anything about how conversations work. The message row
 * still holds text and only text; the blocks come from the creation the chat
 * was started with and are matched to the message by its content. So:
 *
 *   * nothing was migrated, because messages have no block column;
 *   * an edited or regenerated message stops matching and renders as the plain
 *     message it now is, which is correct;
 *   * and the model still receives exactly what the table holds — text.
 *
 * Text keeps the chat's own speech/narration styling, so an illustrated
 * opening reads like every other message with pictures between its paragraphs
 * rather than like a different kind of content.
 */
export function RichMessage({ blocks, bucket }: {
  blocks: RichBlock[] | null | undefined;
  bucket: string;
}) {
  const resolved = normalizeBlocks(blocks);
  return <>
    {resolved.map((block, index) => {
      if (block.type === "text") return <StyledMessage key={index} content={block.text} />;
      const source = avatarSource(bucket, block.path, block.url);
      if (!source) return null;
      return <figure key={index} className={`${styles.figure} ${styles.inset} ${styles.messageFigure}`}>
        <img src={source} alt={block.caption} loading="lazy" decoding="async" />
        {block.caption && <figcaption>{block.caption}</figcaption>}
      </figure>;
    })}
  </>;
}

/**
 * The blocks that belong to a message, if any.
 *
 * A conversation's first assistant message is the opening the reader chose, so
 * its blocks are whichever opening's text it still matches exactly. Anything
 * else — a reply, an edited opening, a regenerated one — has no blocks and
 * renders as text.
 */
export function openingBlocksFor(
  content: string,
  openings: { text: string; blocks: RichBlock[] }[],
): RichBlock[] | null {
  const needle = content.trim();
  if (!needle) return null;
  const match = openings.find((opening) => opening.text.trim() === needle);
  const blocks = match ? normalizeBlocks(match.blocks) : [];
  // Only worth taking over the rendering when there is actually a picture in
  // it; a plain opening keeps the chat's ordinary path.
  return blocks.some((block) => block.type === "image") ? blocks : null;
}
