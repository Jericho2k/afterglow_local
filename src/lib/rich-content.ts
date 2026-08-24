/**
 * Rich content: creator-placed images inside long-form text.
 *
 * One primitive serves the public creation description, world lore and opening
 * messages. Three unrelated image systems would have been three sets of bugs.
 *
 * The rule that governs the whole design: EMBEDDED IMAGES ARE DECORATION FOR
 * PEOPLE. They are never model input. That is enforced structurally rather
 * than by care — the plain text column beside every rich column stays
 * canonical, `richToText` is what writes it, and the prompt builder reads only
 * that column and has no access to blocks at all. An image cannot leak into a
 * prompt by somebody forgetting a case, because there is no case to forget.
 *
 * The block model is deliberately small. Text and image, nothing else. It is
 * not a document format, it is a way to put a picture between two paragraphs,
 * and a schema that cannot express arbitrary markup is a schema that cannot
 * carry an injection.
 */

export type RichTextBlock = { type: "text"; text: string };

export type RichImageBlock = {
  type: "image";
  /** Supabase Storage object path. The normal case. */
  path: string;
  /** An external image URL, for content imported with one. */
  url: string;
  /** Optional short caption, rendered as text and never as markup. */
  caption: string;
};

export type RichBlock = RichTextBlock | RichImageBlock;

/** How many blocks one field may hold. Matches the database constraints. */
export const maxBlocks = 200;
export const maxBlockText = 30_000;
export const maxCaption = 200;

export function isTextBlock(block: RichBlock): block is RichTextBlock {
  return block.type === "text";
}

export function isImageBlock(block: RichBlock): block is RichImageBlock {
  return block.type === "image";
}

function str(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  return value.slice(0, limit);
}

/**
 * Anything at all to a valid block list.
 *
 * Applied on the way in and on the way out, because both directions can carry
 * something unexpected: a hand-edited jsonb column, a payload from an older
 * client, a row written before a field existed. A malformed block is dropped
 * rather than rendered or thrown on — a page must not go blank because one
 * image entry lost its path.
 */
export function normalizeBlocks(value: unknown): RichBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: RichBlock[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (item.type === "image") {
      const path = str(item.path, 400);
      // An external URL is accepted only when it is one. Anything else — a
      // data URI, a javascript: scheme, a relative path — is not an image
      // source this product will render.
      const rawUrl = str(item.url, 1500);
      const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
      if (!path && !url) continue;
      blocks.push({ type: "image", path, url, caption: str(item.caption, maxCaption).trim() });
      continue;
    }
    // Everything that is not an image is text. A block from a future version
    // of this format degrades to whatever text it carries rather than
    // disappearing silently.
    const text = str(item.text ?? item.content, maxBlockText);
    if (!text.trim()) continue;
    blocks.push({ type: "text", text });
  }
  return blocks.slice(0, maxBlocks);
}

/**
 * The text-only form.
 *
 * This is what goes into the plain column, which is what every prompt, every
 * snapshot and every backup reads. Images contribute nothing — not a
 * placeholder, not a caption, not a marker. A reader of this string cannot
 * tell that the content had pictures in it, which is the point: a creation
 * with decorative art must not need a different model, a longer prompt or a
 * multimodal capability to run.
 */
export function richToText(blocks: RichBlock[]): string {
  return blocks
    .filter(isTextBlock)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The blocks a plain string is equivalent to.
 *
 * Every existing row is exactly this, which is why no data migration is
 * needed: legacy text renders through the same component as new rich content
 * because it becomes one text block on the way to it.
 */
export function textToRich(text: string): RichBlock[] {
  const trimmed = text.trim();
  return trimmed ? [{ type: "text", text: trimmed }] : [];
}

/**
 * What to render.
 *
 * Blocks win when there are any; otherwise the plain text is presented as one
 * block. Callers therefore never branch on which era a record was written in.
 */
export function renderableBlocks(blocks: RichBlock[] | null | undefined, fallbackText: string): RichBlock[] {
  const normalized = normalizeBlocks(blocks);
  return normalized.length ? normalized : textToRich(fallbackText ?? "");
}

/** True when a field carries at least one image, for counts and summaries. */
export function imageCount(blocks: RichBlock[] | null | undefined) {
  return normalizeBlocks(blocks).filter(isImageBlock).length;
}

/**
 * Whether the blocks say anything the plain text does not.
 *
 * Storing blocks for content that is a single paragraph of text costs a jsonb
 * column for no benefit and makes every such row look "rich" in the editor.
 * When the blocks are just the text, the field goes back to being plain.
 */
export function blocksAreJustText(blocks: RichBlock[], text: string) {
  const normalized = normalizeBlocks(blocks);
  if (normalized.some(isImageBlock)) return false;
  return richToText(normalized) === text.trim();
}

/**
 * The pair a rich field is stored as.
 *
 * One call site for the invariant, so the text column and the block column can
 * never disagree about what the content says.
 */
export function richFieldPayload(blocks: RichBlock[]): { text: string; rich: RichBlock[] } {
  const normalized = normalizeBlocks(blocks);
  const text = richToText(normalized);
  return { text, rich: blocksAreJustText(normalized, text) ? [] : normalized };
}
