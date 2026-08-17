export type MessageSegment = { text: string; kind: "speech" | "narration" };

export function tokenizeCharacterMessage(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const straight = content.indexOf('"', cursor);
    const curly = content.indexOf("“", cursor);
    const opening = straight === -1 ? curly : curly === -1 ? straight : Math.min(straight, curly);
    if (opening === -1) {
      segments.push({ text: content.slice(cursor), kind: "narration" });
      break;
    }
    if (opening > cursor) segments.push({ text: content.slice(cursor, opening), kind: "narration" });
    const closingMark = content[opening] === "“" ? "”" : '"';
    const closing = content.indexOf(closingMark, opening + 1);
    if (closing === -1) {
      segments.push({ text: content.slice(opening + 1), kind: "speech" });
      break;
    }
    if (closing > opening + 1) segments.push({ text: content.slice(opening + 1, closing), kind: "speech" });
    cursor = closing + 1;
  }

  return segments;
}
