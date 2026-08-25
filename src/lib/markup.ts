/**
 * The little bit of markup Afterglow's prose actually uses.
 *
 * There was no contract here before, only a deletion: the chat renderer ran a
 * regular expression that stripped every double asterisk from an assistant
 * message, and nothing at all over the reader's own. Three separate wrongs came
 * out of that.
 *
 *   `**emphasis**` LOST ITS MEANING. The markers were removed and the emphasis
 *   with them, so a writer's stress became flat text.
 *
 *   `*italics*` WAS NEVER HANDLED. The system prompt explicitly asks the writer
 *   to use it for action, so the most common markup in the product rendered as
 *   literal asterisks around every gesture.
 *
 *   A GENUINE ASTERISK WAS DESTROYED. `2 ** 8` lost its operator, and an
 *   unmatched `**` — which is malformed markup, not emphasis — silently
 *   vanished instead of being shown as what it is.
 *
 * So this parses instead of deleting, and the rule it follows is the one that
 * keeps literal text literal: A MARKER IS ONLY MARKUP WHEN IT PAIRS. An opener
 * with no closer, a pair around nothing, or a pair whose content begins or ends
 * with a space is not emphasis and is returned as the characters it is. `\*`
 * escapes an asterisk that must never be read as markup at all.
 *
 * This produces DATA, never markup: a list of runs with flags. The components
 * that render it use ordinary React elements, so there is no path from a
 * creation's description or a model's reply to injected HTML.
 */

export type InlineSegment = { text: string; bold: boolean; italic: boolean };

const delimiters = new Set(["*", "_"]);

/** How many identical delimiter characters run from `at`, capped at three. */
function runLength(text: string, at: number) {
  const character = text[at];
  let length = 1;
  while (length < 3 && text[at + length] === character) length += 1;
  return length;
}

function isWordCharacter(character: string | undefined) {
  return Boolean(character) && /[\p{L}\p{N}]/u.test(character as string);
}

/**
 * Underscore is emphasis between words, not inside them.
 *
 * `snake_case_identifier` and `some_file_name` are ordinary content in a
 * roleplay about anything technical, and treating their underscores as markup
 * would eat them. Asterisks have no such ambiguity and get no such rule.
 */
function underscoreOpensHere(text: string, start: number) {
  return !isWordCharacter(text[start - 1]);
}
function underscoreClosesHere(text: string, end: number) {
  return !isWordCharacter(text[end]);
}

type Match = { start: number; contentStart: number; contentEnd: number; end: number; bold: boolean; italic: boolean };

/** The next VALID pair at or after `from`, or null when the rest is literal. */
function nextPair(text: string, from: number): Match | null {
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") { index += 1; continue; }
    if (!delimiters.has(character)) continue;
    const length = runLength(text, index);
    if (character === "_" && !underscoreOpensHere(text, index)) { index += length - 1; continue; }
    const contentStart = index + length;
    // Emphasis never opens on whitespace: "a * b * c" is arithmetic or a list,
    // not italics.
    if (contentStart >= text.length || /\s/.test(text[contentStart])) { index += length - 1; continue; }

    for (let close = contentStart; close < text.length; close += 1) {
      if (text[close] === "\\") { close += 1; continue; }
      if (text[close] !== character) continue;
      const closeLength = runLength(text, close);
      // The closing run must be the SAME length as the opening one. A longer
      // run belongs to a different pair, and stepping into it is how `*a **b**
      // c*` used to close its italics on the first asterisk of the bold pair
      // and swallow the rest as literal text.
      if (closeLength !== length) { close += closeLength - 1; continue; }
      // Emphasis never closes on whitespace either.
      if (/\s/.test(text[close - 1])) { close += closeLength - 1; continue; }
      if (character === "_" && !underscoreClosesHere(text, close + length)) { close += closeLength - 1; continue; }
      return {
        start: index,
        contentStart,
        contentEnd: close,
        end: close + length,
        bold: length >= 2,
        italic: length === 1 || length === 3,
      };
    }
    // An opener with no closer is literal text. Step past this run rather than
    // into it, so `** a **` is not re-examined character by character.
    index += length - 1;
  }
  return null;
}

/** `\*` and `\_` become the character they protect; nothing else changes. */
function unescape(text: string) {
  return text.replace(/\\([*_\\])/g, "$1");
}

function push(into: InlineSegment[], text: string, bold: boolean, italic: boolean) {
  if (!text) return;
  const last = into[into.length - 1];
  if (last && last.bold === bold && last.italic === italic) { last.text += text; return; }
  into.push({ text, bold, italic });
}

function scan(text: string, bold: boolean, italic: boolean, into: InlineSegment[]) {
  let cursor = 0;
  while (cursor < text.length) {
    const pair = nextPair(text, cursor);
    if (!pair) { push(into, unescape(text.slice(cursor)), bold, italic); return; }
    if (pair.start > cursor) push(into, unescape(text.slice(cursor, pair.start)), bold, italic);
    scan(text.slice(pair.contentStart, pair.contentEnd), bold || pair.bold, italic || pair.italic, into);
    cursor = pair.end;
  }
}

/**
 * Emphasis a provider escaped on its way out.
 *
 * Some routed models emit their own markdown already escaped, so bold arrives
 * as `\*\*like this\*\*`. Read strictly that means "show two literal
 * asterisks", and read practically it never does: a person typing literal
 * asterisks into a chat box does not type backslashes in front of them, and a
 * writer asked for emphasis did not mean to show punctuation.
 *
 * The rule that separates the two is PAIRING, the same rule the rest of this
 * file uses. An escaped run that has a matching escaped run after it is
 * emphasis and loses its backslashes here; a lone `\*` is a deliberate escape
 * and stays one, becoming a single literal asterisk later.
 */
function resolveEscapedEmphasis(text: string) {
  if (!text.includes("\\")) return text;
  type Run = { start: number; end: number; character: string; length: number };
  const runs: Run[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\" || !delimiters.has(text[index + 1])) continue;
    const character = text[index + 1];
    let end = index;
    let length = 0;
    while (text[end] === "\\" && text[end + 1] === character) { end += 2; length += 1; }
    runs.push({ start: index, end, character, length });
    index = end - 1;
  }
  const unescape = new Set<number>();
  const claimed = new Set<number>();
  for (let open = 0; open < runs.length; open += 1) {
    if (claimed.has(open)) continue;
    const opener = runs[open];
    const content = text.slice(opener.end, runs[open + 1]?.start ?? text.length);
    if (!content || /^\s/.test(content)) continue;
    for (let close = open + 1; close < runs.length; close += 1) {
      const closer = runs[close];
      if (claimed.has(close) || closer.character !== opener.character || closer.length !== opener.length) continue;
      if (/\s$/.test(text.slice(opener.end, closer.start)) || closer.start === opener.end) break;
      claimed.add(open); claimed.add(close);
      unescape.add(open); unescape.add(close);
      break;
    }
  }
  if (!unescape.size) return text;
  let result = "";
  let cursor = 0;
  runs.forEach((run, index) => {
    if (!unescape.has(index)) return;
    result += text.slice(cursor, run.start) + run.character.repeat(run.length);
    cursor = run.end;
  });
  return result + text.slice(cursor);
}

export type MarkupOptions = {
  /**
   * Whether a MATCHED escaped delimiter pair should be read as emphasis.
   *
   * True for text a model wrote or a creator imported, where `\*\*bold\*\*`
   * is a provider escaping its own markdown. False for text the reader typed,
   * where a backslash is a deliberate instruction from a person and must be
   * obeyed exactly. Same parser, different provenance.
   */
  providerEscapes?: boolean;
};

export function parseInlineMarkup(text: string, options: MarkupOptions = {}): InlineSegment[] {
  const segments: InlineSegment[] = [];
  scan(options.providerEscapes === false ? text : resolveEscapedEmphasis(text), false, false, segments);
  return segments;
}

/** The same text with markup resolved away, for previews and titles. */
export function plainText(text: string, options: MarkupOptions = {}) {
  return parseInlineMarkup(text, options).map((segment) => segment.text).join("");
}
