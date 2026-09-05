import { contentModes } from "./content-mode";
import type { ContentMode } from "./types";

/**
 * Reading a character card from SillyTavern, Chub, and everything that copied
 * their format.
 *
 * This is a separate act from Paste Everything. That flow takes prose a person
 * assembled by hand and asks a model to organise it; this one takes a FILE with
 * a known structure and reads it, so no model is involved and nothing is
 * rewritten. A creator who exported a card they spent a month on gets that card
 * back, word for word, not a summary of it.
 *
 * Three shapes exist in the wild and all three are handled:
 *
 *   V1 — a bare JSON object, no wrapper. TavernAI's original: name,
 *        description, personality, scenario, first_mes, mes_example.
 *   V2 — `{ spec: "chara_card_v2", spec_version: "2.0", data: {...} }`, which
 *        added alternate greetings, a system prompt, a character book, tags and
 *        creator metadata.
 *   V3 — `{ spec: "chara_card_v3", spec_version: "3.0", data: {...} }`, a
 *        superset adding nickname, assets, source and group-only greetings.
 *
 * In a PNG they live in a tEXt chunk: `chara` for V1/V2, `ccv3` for V3, both
 * base64-encoded UTF-8 JSON. SillyTavern writes BOTH chunks into an export so
 * one file opens everywhere, and the V3 spec is explicit that a reader seeing
 * both must prefer `ccv3` — a V2 chunk beside it is a backfill for older
 * clients and may be stale.
 *
 * Nothing here decodes or re-encodes image data. The chunk walk reads lengths
 * and types and copies nothing, so the file a creator uploads is byte-identical
 * to the file that reaches storage: a card is often the only copy of artwork
 * somebody has, and an importer that silently recompresses it is destroying the
 * thing it was asked to preserve.
 */

export type CharacterBookEntry = {
  keys: string[];
  content: string;
  name: string;
  enabled: boolean;
  insertionOrder: number;
};

export type CharacterBook = {
  name: string;
  description: string;
  entries: CharacterBookEntry[];
};

export type ParsedCard = {
  spec: "v1" | "v2" | "v3";
  name: string;
  nickname: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  alternateGreetings: string[];
  groupOnlyGreetings: string[];
  exampleDialogue: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creatorNotes: string;
  creator: string;
  characterVersion: string;
  tags: string[];
  avatarUrl: string;
  book: CharacterBook | null;
  /** The card exactly as it arrived, kept so an import loses nothing. */
  raw: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function book(value: unknown): CharacterBook | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const rawEntries = Array.isArray(source.entries) ? source.entries : [];
  const entries: CharacterBookEntry[] = [];
  for (const entry of rawEntries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const content = text(item.content);
    if (!content.trim()) continue;
    entries.push({
      keys: stringList(item.keys),
      content,
      name: text(item.name) || text(item.comment),
      // Absent means enabled: every format treats the flag as an opt-out, and
      // an importer that read a missing field as "off" would silently drop the
      // whole lorebook of any card that never wrote it.
      enabled: item.enabled !== false,
      insertionOrder: Number.isFinite(Number(item.insertion_order)) ? Number(item.insertion_order) : 0,
    });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => a.insertionOrder - b.insertionOrder);
  return { name: text(source.name), description: text(source.description), entries };
}

/**
 * A parsed JSON value, whatever spec it claims.
 *
 * The spec field is trusted for its VERSION and not for its field layout: V3 is
 * a superset of V2, and every V2 field is read the same way in both, so one
 * reader covers both and a card mislabelled by its exporter still imports.
 */
export function parseCardObject(value: unknown): ParsedCard | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const spec = text(root.spec).toLowerCase();
  const data = (spec === "chara_card_v2" || spec === "chara_card_v3") && root.data && typeof root.data === "object"
    ? root.data as Record<string, unknown>
    : root;

  const name = text(data.name) || text(data.char_name);
  const description = text(data.description) || text(data.char_persona);
  const firstMessage = text(data.first_mes) || text(data.char_greeting);
  // A card with none of the three is not a character card — it is some other
  // JSON that happened to be uploaded, and saying so is better than importing
  // an empty creation.
  if (!name.trim() && !description.trim() && !firstMessage.trim()) return null;

  return {
    spec: spec === "chara_card_v3" ? "v3" : spec === "chara_card_v2" ? "v2" : "v1",
    name,
    nickname: text(data.nickname),
    description,
    personality: text(data.personality),
    scenario: text(data.scenario) || text(data.world_scenario),
    firstMessage,
    alternateGreetings: stringList(data.alternate_greetings),
    groupOnlyGreetings: stringList(data.group_only_greetings),
    exampleDialogue: text(data.mes_example) || text(data.example_dialogue),
    systemPrompt: text(data.system_prompt),
    postHistoryInstructions: text(data.post_history_instructions),
    creatorNotes: text(data.creator_notes),
    creator: text(data.creator),
    characterVersion: text(data.character_version),
    tags: stringList(data.tags),
    // V3 assets can carry an icon, but only as a URL this importer does not
    // fetch: pulling a remote image server-side on somebody else's say-so is a
    // request forgery primitive, and the card's own PNG is the artwork anyway.
    avatarUrl: text(data.avatar) === "none" ? "" : text(data.avatar),
    book: book(data.character_book) ?? book(data.book),
    raw: value,
  };
}

/**
 * The tEXt chunks of a PNG, as keyword/value pairs.
 *
 * A deliberately minimal walk: signature, then `length | type | data | crc`
 * until IEND. It reads only what it needs to find the chunk boundaries and
 * copies only the chunks it was asked for, so a 6 MB card costs one pass and no
 * image decoding. Malformed input falls off the end of the loop and yields
 * whatever was valid up to that point rather than throwing.
 */
export function pngTextChunks(bytes: Uint8Array): Map<string, string> {
  const chunks = new Map<string, string>();
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((byte, index) => bytes[index] !== byte)) return chunks;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    // A length that runs past the file is a truncated download, not a chunk.
    if (dataStart + length > bytes.length) break;
    if (type === "tEXt") {
      const data = bytes.subarray(dataStart, dataStart + length);
      const separator = data.indexOf(0);
      if (separator > 0) {
        const keyword = new TextDecoder("latin1").decode(data.subarray(0, separator));
        // The VALUE is UTF-8 in practice — every exporter writes base64 ASCII
        // here, and decoding it as latin1 would corrupt anything that is not.
        const value = new TextDecoder("utf-8").decode(data.subarray(separator + 1));
        if (!chunks.has(keyword)) chunks.set(keyword, value);
      }
    }
    if (type === "IEND") break;
    offset = dataStart + length + 4;
  }
  return chunks;
}

function decodeBase64Json(value: string): unknown {
  try {
    const json = typeof atob === "function"
      ? new TextDecoder().decode(Uint8Array.from(atob(value.trim()), (character) => character.charCodeAt(0)))
      : Buffer.from(value.trim(), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    // Some exporters write the JSON straight into the chunk without base64.
    try { return JSON.parse(value); } catch { return null; }
  }
}

/** A card read out of PNG bytes, preferring `ccv3` exactly as the spec says. */
export function parseCardPng(bytes: Uint8Array): ParsedCard | null {
  const chunks = pngTextChunks(bytes);
  for (const keyword of ["ccv3", "chara"]) {
    const value = chunks.get(keyword);
    if (!value) continue;
    const card = parseCardObject(decodeBase64Json(value));
    if (card) return card;
  }
  return null;
}

/** A card read from a file of either kind, chosen by its own contents. */
export function parseCard(bytes: Uint8Array): ParsedCard | null {
  const png = parseCardPng(bytes);
  if (png) return png;
  try {
    return parseCardObject(JSON.parse(new TextDecoder("utf-8").decode(bytes)));
  } catch {
    return null;
  }
}

/**
 * The mode an imported card is SUGGESTED to have.
 *
 * A suggestion, never a decision: the import lands private and the creator
 * confirms in the studio. What this does is refuse to start anybody at "clean"
 * when the card announces otherwise, because the failure that matters is the
 * silent one — adult material arriving with no signal and inheriting the
 * permissive default.
 *
 * It reads the card's own tags rather than its prose. A tag is the author's
 * classification of their own work; scanning a description for words would be
 * both wrong more often and wrong in the direction that matters.
 */
const adultTagPattern = /^(nsfw|explicit|erotic|erotica|smut|hentai|porn|adult|18\+|xxx|lewd)$/i;
const suggestiveTagPattern = /^(romance|romantic|dating|flirt|flirting|seduction|suggestive|kissing|love)$/i;

export function suggestedContentMode(card: ParsedCard): ContentMode {
  const tags = card.tags.map((tag) => tag.trim());
  if (tags.some((tag) => adultTagPattern.test(tag))) return "adult_focused";
  if (tags.some((tag) => suggestiveTagPattern.test(tag))) return "adult_capable";
  return "clean";
}

/** Every mode, for the studio's own use. Kept here so the list has one home. */
export const importableContentModes = contentModes;

/**
 * A character book, as Afterglow world lore.
 *
 * The entries keep their keys, because that is what makes a lorebook a
 * lorebook: "the Ashfall Rebellion" matters when the story mentions it and not
 * otherwise, and dropping the keys would flatten a keyed reference document
 * into an undifferentiated wall that every prompt then carries in full.
 *
 * The formatting is deliberately plain and lossless — a heading, the keys, the
 * content verbatim — rather than an attempt to translate one lore system into
 * another. A creator can read it, edit it, and recognise what they wrote.
 */
export function bookToWorldLore(source: CharacterBook): string {
  const sections = source.entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const heading = entry.name.trim() || entry.keys[0] || "Entry";
      const keys = entry.keys.length ? `Keywords: ${entry.keys.join(", ")}\n` : "";
      return `## ${heading}\n${keys}\n${entry.content.trim()}`;
    });
  const preamble = source.description.trim() ? `${source.description.trim()}\n\n` : "";
  return `${preamble}${sections.join("\n\n")}`.trim();
}
