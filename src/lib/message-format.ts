export type MessageSegment = { text: string; kind: "speech" | "narration" };

export function compactMessagePreview(value: string, maxLength = 48): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function tokenizeCharacterMessage(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const addSegment = (text: string, kind: MessageSegment["kind"]) => {
    // Models occasionally escape Markdown markers (\*\*text\*\*) even though
    // the chat renderer is intentionally not a Markdown surface. Strip both
    // forms so formatting syntax never leaks into the visible prose.
    const cleaned = text.replace(/\\?\*\\?\*/g, "");
    if (cleaned) segments.push({ text: cleaned, kind });
  };
  let cursor = 0;

  while (cursor < content.length) {
    const straight = content.indexOf('"', cursor);
    const curly = content.indexOf("“", cursor);
    const opening = straight === -1 ? curly : curly === -1 ? straight : Math.min(straight, curly);
    if (opening === -1) {
      addSegment(content.slice(cursor), "narration");
      break;
    }
    if (opening > cursor) addSegment(content.slice(cursor, opening), "narration");
    const closingMark = content[opening] === "“" ? "”" : '"';
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
