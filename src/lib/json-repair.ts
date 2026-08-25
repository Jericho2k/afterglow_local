/**
 * Tolerant JSON recovery for provider output.
 *
 * Character imports ask a model for a large JSON document, and large documents
 * are where models slip: a missing comma between array elements, a literal
 * newline inside a quoted string, a trailing comma before a closing brace, or
 * a response that simply stops mid-array when it runs out of tokens.
 *
 * `JSON.parse` rejects all of those outright, which turned a recoverable
 * formatting mistake into a failed import. Each repair below is deliberately
 * conservative: it only rewrites syntax, never meaning, and the canonical Zod
 * schema still decides whether the result is acceptable.
 */

/** Strips markdown fences and any prose surrounding the JSON document. */
function isolate(raw: string) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0) return cleaned;
  return end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
}

/**
 * Walks the document once, tracking whether each character sits inside a
 * string. Structural repairs are only safe outside strings, and string
 * repairs are only safe inside them, so a single pass that knows the
 * difference avoids the usual regex damage to prose containing braces.
 */
function repairStructure(input: string) {
  let out = "";
  let inString = false;
  let escaped = false;

  /**
   * True when the next non-space character starts another value. A closed
   * value followed by another value is never valid JSON regardless of the
   * whitespace between them, so the separator is unambiguously missing.
   * `:` and `,` are excluded, which is what keeps keys and correct arrays
   * from being touched.
   */
  const valueFollows = (index: number) => /^\s*(["{[]|-?\d|true\b|false\b|null\b)/.test(input.slice(index + 1));

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) { out += char; escaped = false; continue; }
      if (char === "\\") { out += char; escaped = true; continue; }
      if (char === '"') {
        // Closing quote. A value starting immediately after it means the
        // model omitted the separating comma.
        inString = false;
        out += char;
        if (valueFollows(index)) out += ",";
        continue;
      }
      // Raw control characters inside a string are invalid JSON, and models
      // emit them constantly in multi-paragraph prose fields.
      if (char === "\n") { out += "\\n"; continue; }
      if (char === "\r") { out += "\\r"; continue; }
      if (char === "\t") { out += "\\t"; continue; }
      out += char;
      continue;
    }

    if (char === '"') { inString = true; out += char; continue; }

    // Drop a trailing comma before a closing bracket.
    if (char === "," && /^\s*[}\]]/.test(input.slice(index + 1))) continue;

    out += char;

    // A closed structure followed directly by another value is the same
    // missing-comma mistake one level up.
    if ((char === "}" || char === "]") && valueFollows(index)) out += ",";
  }

  return out;
}

/**
 * Closes brackets left open by a response that stopped early, discarding any
 * partial trailing value so the remaining document still parses.
 */
function closeTruncated(input: string) {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    if (char === "}" || char === "]") stack.pop();
    // A comma or a closed value at depth is a point the document can be cut
    // back to without leaving half a key/value behind.
    if (char === "," || char === "}" || char === "]") lastSafe = index;
  }

  if (!stack.length && !inString) return input;
  const truncated = input.slice(0, lastSafe > 0 ? lastSafe : input.length).replace(/,\s*$/, "");

  // Recompute the open brackets for the truncated document.
  const closers: string[] = [];
  let stringState = false;
  let escapeState = false;
  for (const char of truncated) {
    if (stringState) {
      if (escapeState) { escapeState = false; continue; }
      if (char === "\\") { escapeState = true; continue; }
      if (char === '"') stringState = false;
      continue;
    }
    if (char === '"') { stringState = true; continue; }
    if (char === "{") closers.push("}");
    if (char === "[") closers.push("]");
    if (char === "}" || char === "]") closers.pop();
  }
  return truncated + (stringState ? '"' : "") + closers.reverse().join("");
}

/**
 * What had to be done to make the document parse.
 *
 * `truncated` is the one worth telling somebody about: the response stopped
 * early, `closeTruncated` discarded the partial tail, and whatever the model
 * had not finished writing is simply not there. Everything that did arrive is
 * intact — but the caller should say so rather than present a short result as
 * a complete one.
 */
export type JsonRepair = "none" | "structure" | "truncated";

export type LenientJson<T> = { value: T; repair: JsonRepair };

/**
 * Parses provider JSON, repairing it only when a strict parse fails, and
 * reporting which repair was needed.
 *
 * Valid documents are never rewritten, so this cannot corrupt well-formed
 * output; it only widens what counts as recoverable.
 */
export function parseLenientJsonWithRepair<T>(raw: string): LenientJson<T> {
  const isolated = isolate(raw);

  const attempts: { text: string; repair: JsonRepair }[] = [
    { text: isolated, repair: "none" },
    { text: repairStructure(isolated), repair: "structure" },
    { text: closeTruncated(repairStructure(isolated)), repair: "truncated" },
  ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try { return { value: JSON.parse(attempt.text) as T, repair: attempt.repair }; } catch (error) { lastError = error; }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`The importer returned malformed JSON that could not be repaired (${detail}). Try the import again.`);
}

export function parseLenientJson<T>(raw: string): T {
  return parseLenientJsonWithRepair<T>(raw).value;
}
