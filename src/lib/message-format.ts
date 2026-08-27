import { parseInlineMarkup, plainText, type InlineSegment, type MarkupOptions } from "./markup";

export type MessageSegment = { text: string; kind: "speech" | "narration" };

/**
 * One run of message prose: what it says, whether it is speech, and how it is
 * emphasised. The three are separate because they come from three different
 * decisions — the writer's quotation marks, the writer's markup, and the
 * product's own styling — and collapsing them is what produced a renderer that
 * deleted asterisks.
 */
export type StyledSegment = InlineSegment & { kind: MessageSegment["kind"] };

export function compactMessagePreview(value: string, maxLength = 48): string {
  // A preview is a line of plain text, so markup resolves rather than showing.
  const compact = plainText(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/**
 * Splits prose into quoted speech and everything else.
 *
 * Deliberately unchanged in what it decides; what changed is what it no longer
 * does. It used to strip every `**` it passed, which removed the emphasis a
 * writer meant AND the literal asterisks a reader typed. Markup is now parsed
 * by `styleMessage` below, which can tell those two apart.
 */
export function tokenizeCharacterMessage(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const addSegment = (text: string, kind: MessageSegment["kind"]) => {
    if (text) segments.push({ text, kind });
  };
  let cursor = 0;

  while (cursor < content.length) {
    const straight = content.indexOf('"', cursor);
    const curly = content.indexOf("\u201c", cursor);
    const opening = straight === -1 ? curly : curly === -1 ? straight : Math.min(straight, curly);
    if (opening === -1) {
      addSegment(content.slice(cursor), "narration");
      break;
    }
    if (opening > cursor) addSegment(content.slice(cursor, opening), "narration");
    const closingMark = content[opening] === "\u201c" ? "\u201d" : '"';
    const closing = content.indexOf(closingMark, opening + 1);
    if (closing === -1) {
      addSegment(content.slice(opening + 1), "speech");
      break;
    }
    if (closing > opening + 1) addSegment(content.slice(opening + 1, closing), "speech");
    cursor = closing + 1;
  }

  return segments;
}

/**
 * A message, ready to render: speech/narration and emphasis together.
 *
 * Markup is resolved WITHIN each speech or narration run rather than across the
 * whole message, so a stray asterisk inside dialogue cannot reach out and
 * italicise the narration after it. An unpaired marker simply stays where the
 * writer put it.
 *
 * This is the one function every chat surface renders through — the reader's
 * own messages included, which previously went to the screen as raw text and
 * were the most visible source of the literal `**` in the report.
 */
export function styleMessage(content: string, options: MarkupOptions = {}): StyledSegment[] {
  return tokenizeCharacterMessage(content).flatMap((segment) =>
    parseInlineMarkup(segment.text, options).map((piece) => ({ ...piece, kind: segment.kind })));
}

/**
 * The same segments, as the chat actually draws them.
 *
 * `styleMessage` answers what the WRITER wrote; this answers what the READER
 * sees, and in Afterglow those differ in exactly one way.
 *
 * A single asterisk pair is not typographic emphasis in a roleplay — it is the
 * convention for an action or a line of narration, and it is used for most of
 * the prose in a story. Rendering it as `<em>` put the majority of every reply
 * in italics, which is the complaint: the previous fix stopped the markers
 * being VISIBLE and, in doing so, made the text they wrapped look different
 * from the text around it.
 *
 * So narration markup is resolved and then styled as nothing. The markers
 * still do not print, the text still ends up in the paragraph it belongs to,
 * and it reads in the same face as the rest of the scene. `**bold**` is
 * untouched, because a writer reaching for double asterisks meant emphasis and
 * there is no competing convention for it.
 *
 * This is a RENDERING decision, not a parsing one. `parseInlineMarkup` still
 * reports `italic` faithfully, so nothing that needs to know what the markup
 * said — a future export, a diagnostic — loses that information.
 */
export function displaySegments(content: string, options: MarkupOptions = {}): StyledSegment[] {
  return styleMessage(content, options).map((segment) => segment.italic ? { ...segment, italic: false } : segment);
}
