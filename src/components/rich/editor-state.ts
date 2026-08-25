import { maxBlockText, normalizeBlocks, richToText, textToRich, type RichBlock } from "@/lib/rich-content";

/**
 * The rich editor's block algebra, separated from the component that draws it.
 *
 * This exists because of a bug that was invisible from the outside and obvious
 * from here: "Add a text section" appended an empty text block and then handed
 * the list to `normalizeBlocks`, which exists to remove empty text blocks. The
 * button worked perfectly and produced nothing.
 *
 * The distinction the whole file rests on:
 *
 *   EDITING STATE tolerates an empty text block, because every paragraph is
 *   empty for the moment before it is typed into.
 *
 *   STORED STATE does not, because an empty paragraph is not content and has
 *   no business occupying a jsonb column or a canonical text field.
 *
 * `storedValue` is the one place the second is derived from the first, so the
 * two can never drift, and the transformations below are pure — which is what
 * makes "add an image, add a paragraph, type, save, reopen" something that can
 * be asserted rather than clicked through.
 */

export type EditorState = RichBlock[];

/** Editing state for a stored pair. Always has at least one block to type in. */
export function editorStateFrom(blocks: RichBlock[] | null | undefined, text: string, limit = maxBlockText): EditorState {
  const normalized = normalizeBlocks(blocks, limit);
  if (normalized.length) return normalized;
  const fromText = textToRich(text ?? "");
  return fromText.length ? fromText : [{ type: "text", text: "" }];
}

export function hasImages(state: EditorState) {
  return state.some((block) => block.type === "image");
}

/**
 * A new, empty paragraph at the end.
 *
 * It survives here precisely because this is editing state. It disappears on
 * save if nothing is typed into it, which is the correct behaviour and was
 * never the complaint.
 */
export function addTextSection(state: EditorState): EditorState {
  return [...state, { type: "text", text: "" }];
}

/** An image, followed by a paragraph to carry on writing in. */
export function addImage(state: EditorState, path: string, url = ""): EditorState {
  return [...state, { type: "image", path, url, caption: "" }, { type: "text", text: "" }];
}

export function setBlockText(state: EditorState, index: number, value: string): EditorState {
  return state.map((block, position) => position === index && block.type === "text" ? { ...block, text: value } : block);
}

export function setCaption(state: EditorState, index: number, caption: string): EditorState {
  return state.map((block, position) => position === index && block.type === "image" ? { ...block, caption } : block);
}

export function moveBlock(state: EditorState, index: number, direction: -1 | 1): EditorState {
  const target = index + direction;
  if (target < 0 || target >= state.length) return state;
  const next = [...state];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function removeBlock(state: EditorState, index: number): EditorState {
  const next = state.filter((_, position) => position !== index);
  return next.length ? next : [{ type: "text", text: "" }];
}

/**
 * Collapse back to a single paragraph once the last image is gone.
 *
 * Without this, removing the only picture would leave several textareas that
 * merge into one the next time the record is opened — the field would appear
 * to reorganise itself behind the creator's back.
 */
export function collapseIfPlain(state: EditorState): EditorState {
  if (hasImages(state)) return state;
  return [{ type: "text", text: richToText(state) }];
}

/**
 * What would be saved for this editing state.
 *
 * Content with no images reports plain text and no blocks at all, which is
 * what keeps every creation written before rich content existed from growing a
 * blocks column merely by being opened.
 */
export function storedValue(state: EditorState, limit = maxBlockText): { blocks: RichBlock[]; text: string } {
  const cleaned = normalizeBlocks(state, limit);
  const text = richToText(cleaned);
  return hasImages(cleaned) ? { blocks: cleaned, text } : { blocks: [], text };
}
