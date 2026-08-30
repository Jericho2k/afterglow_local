import { characterSchema } from "./schemas";
import { parseLenientJsonWithRepair, type JsonRepair } from "./json-repair";
import { adultTagsIn, canonicalTag, isAdultTag, isPlatformTag, maxHashtags, maxTags, normalizeHashtag } from "./tags";
import type { CreationType } from "./types";
import { creationTypes } from "./types";

/** The product limit on extra openings, matching `characterSchema`. */
export const maxAlternateGreetings = 12;

/**
 * The canonical AI creation result.
 *
 * Quick Idea and Paste Everything are two behaviours, not two data models.
 * Both answer with the same document, both are normalised here, and both end
 * up as the same Creation draft the manual studio edits — so there is no
 * "AI character schema" to drift away from the one creators actually use.
 *
 * Provider output is never an application payload. Everything below accepts
 * the field aliases real cards arrive with, repairs formatting rather than
 * meaning, bounds every value, drops what the platform does not recognise,
 * and then hands the result to the same Zod schema `/api/characters` uses.
 * A partially usable document therefore becomes a partially filled draft the
 * creator can finish, which is strictly better than discarding a long paste.
 */

export type CreationWorldDraft = {
  name: string;
  description: string;
  /** The lore itself. Never merged into a character's personality or backstory. */
  content: string;
};

export type CreationAiNotice = {
  /**
   * `age_conflict` is the only kind that changes what the draft is allowed to
   * be: it forces the creation back to safe, private settings. The rest are
   * informational and the creator may ignore all of them.
   */
  kind: "age_conflict" | "adult_enabled" | "tags_dropped" | "structure" | "world" | "source";
  message: string;
};

export type CreationAiResult = {
  /** The canonical creation payload, ready for the studio and for the API. */
  draft: ReturnType<typeof characterSchema.parse>;
  /** Reusable world material the source contained, awaiting the creator's confirmation. */
  world: CreationWorldDraft | null;
  notices: CreationAiNotice[];
  /** Never shown as a percentage; used to explain what the importer did. */
  stats: {
    sourceCharacters: number;
    organizedCharacters: number;
    castMembers: number;
    openings: number;
    tags: number;
    hashtags: number;
    /** Tag-shaped values the model invented, which are not platform tags. */
    unknownTags: string[];
    worldCharacters: number;
    audited: boolean;
    /** What had to be repaired to read the provider's answer. */
    repair: JsonRepair;
  };
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit: number) {
  if (value == null) return "";
  const result = typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join("\n") : String(value);
  return result.trim().slice(0, limit);
}

function list(value: unknown, itemLimit: number, countLimit: number) {
  if (Array.isArray(value)) return value.map((item) => text(item, itemLimit)).filter(Boolean).slice(0, countLimit);
  const single = text(value, itemLimit);
  return single ? [single] : [];
}

function boolish(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "yes", "1", "adult", "explicit", "nsfw"].includes(value.trim().toLowerCase());
  return false;
}

function parseObject(raw: string) {
  // Large imports are exactly where models produce a missing comma, a raw
  // newline inside prose, or a response that stops mid-array. Recovering the
  // document beats discarding a long paste over a formatting slip.
  const parsed = parseLenientJsonWithRepair<unknown>(raw);
  return { value: object(parsed.value), repair: parsed.repair };
}

/**
 * The structure the source actually has.
 *
 * A creator who already chose one in the interface keeps it: their choice is
 * an instruction, not a hint. Otherwise the model's answer is taken, and only
 * where it says nothing usable does the shape of what it returned decide —
 * several defined people is a cast, and one is a character. A scenario is
 * never converted into a fake person to satisfy an older schema, and a
 * scenario that happens to name important NPCs stays a scenario.
 */
export function resolveCreationType(raw: string, castCount: number, requested?: CreationType | null): CreationType {
  if (requested && (creationTypes as readonly string[]).includes(requested)) return requested;
  const hint = raw.toLowerCase();
  if (hint.includes("scenario") || hint.includes("rpg") || hint.includes("narrat") || hint.includes("world")) return "scenario";
  if (hint.includes("cast") || hint.includes("ensemble") || hint.includes("multiple") || hint.includes("group")) return "cast";
  if (hint.includes("character") || hint.includes("single")) return "character";
  return castCount > 1 ? "cast" : "character";
}

/**
 * The reader is not a cast member.
 *
 * Almost every card format describes who the READER plays — "You are the new
 * recruit", "{{user}} is her younger brother", a "User" entry in a character
 * list — and a model asked to extract "the characters" will dutifully return
 * that as one of them. The consequences are worse than one stray row: an
 * AI-portrayed cast that contains the reader means the writer plays the reader,
 * speaks for them and decides what they do, which is the one thing the roleplay
 * prompt forbids everywhere else. It also inflates the count that decides
 * Character versus Cast, so a single character with a described reader role
 * arrived as a two-person Cast.
 *
 * Matching is on the NAME, deliberately, and on an explicit flag if the model
 * sets one. A name is the reliable signal; a description that says "you" is
 * not — a character can be written in the second person and still be a
 * character. Anything not on this list stays.
 */
/** Already in `comparableName` form: lower case, no punctuation, single spaces. */
const readerNames = new Set([
  "user", "the user", "you", "yourself", "player", "the player", "reader", "the reader",
  "me", "myself", "protagonist you", "you the user", "you the reader", "you the player",
  "user persona", "player character", "the main character you",
]);

/** Strips template markers and punctuation so `{{user}}` and `<USER>` both match. */
function comparableName(name: string) {
  return name
    .toLowerCase()
    .replace(/\{\{\s*([^}]*?)\s*\}\}/g, "$1")
    .replace(/[<>[\]{}()]/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isReaderCastEntry(entry: { name: string; role?: string; isUser?: unknown; isPlayer?: unknown }) {
  if (boolish(entry.isUser) || boolish(entry.isPlayer)) return true;
  const name = comparableName(entry.name);
  if (readerNames.has(name)) return true;
  // "the user character", "user persona", "player character (you)".
  if (/^(the )?(user|player|reader)( character| persona| avatar| insert)?$/.test(name)) return true;
  // A role that says, in so many words, that this entry IS the reader.
  const role = comparableName(entry.role ?? "");
  return role === "the user" || role === "the player" || role === "the reader" || role === "you";
}

/** Cast members, de-duplicated by name so one person cannot arrive twice. */
function normalizeCast(value: unknown) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const members: { name: string; role: string; description: string; tagline: string; avatarPath: string; avatarUrl: string }[] = [];
  const readerEntries: string[] = [];
  let duplicates = 0;
  for (const entry of raw) {
    const item = object(entry);
    const name = text(item.name ?? item.characterName ?? item.character, 120);
    if (!name) continue;
    const role = text(item.role ?? item.relationship ?? item.title, 240);
    if (isReaderCastEntry({ name, role, isUser: item.isUser, isPlayer: item.isPlayer })) {
      // Kept, not discarded: what the source says about the reader belongs in
      // `userRole`, which is where the writer prompt already reads it from.
      readerEntries.push(text(item.description ?? item.profile ?? item.details ?? item.personality, 4000) || role);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      // A model that lists the same person twice usually splits their detail
      // across both entries, so the definitions are joined rather than one of
      // them being thrown away.
      const existing = members.find((member) => member.name.toLowerCase() === key)!;
      const extra = text(item.description ?? item.profile ?? item.details ?? item.personality, 8000);
      if (extra && !existing.description.includes(extra)) {
        existing.description = `${existing.description}\n\n${extra}`.trim().slice(0, 8000);
      }
      duplicates += 1;
      continue;
    }
    seen.add(key);
    members.push({
      name,
      role,
      description: text(item.description ?? item.profile ?? item.details ?? item.personality, 8000),
      tagline: text(item.tagline ?? item.summary ?? item.blurb ?? item.shortDescription, 240),
      avatarPath: "",
      avatarUrl: "",
    });
    if (members.length >= 50) break;
  }
  return { members, duplicates, readerEntries: readerEntries.filter(Boolean) };
}

/**
 * Platform tags, and only platform tags.
 *
 * The taxonomy is the platform's, so a model may choose from it and may not
 * extend it. Anything it invented is not silently accepted as an official
 * category: where the invention is a usable creator word it becomes a
 * hashtag, which is exactly what that system is for, and otherwise it is
 * dropped and reported.
 */
function normalizeTags(value: unknown) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : [];
  const tags: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const candidate = text(entry, 60);
    if (!candidate) continue;
    const canonical = canonicalTag(candidate);
    if (!isPlatformTag(canonical)) { if (!unknown.includes(candidate)) unknown.push(candidate); continue; }
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(canonical);
    if (tags.length >= maxTags) break;
  }
  return { tags, unknown: unknown.slice(0, 12) };
}

function normalizeHashtags(value: unknown, salvaged: string[]) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  const hashtags: string[] = [];
  for (const entry of [...raw, ...salvaged]) {
    const tag = normalizeHashtag(String(entry ?? ""));
    if (!tag || hashtags.includes(tag)) continue;
    hashtags.push(tag);
    if (hashtags.length >= maxHashtags) break;
  }
  return hashtags;
}

/** Up to six public label/value facts. Blank halves are dropped, never guessed. */
function normalizeQuickFacts(value: unknown) {
  const raw = Array.isArray(value) ? value : [];
  const facts: { label: string; value: string }[] = [];
  for (const entry of raw) {
    const item = object(entry);
    const label = text(item.label ?? item.name ?? item.key, 40);
    const fact = text(item.value ?? item.text ?? item.detail, 120);
    if (!label || !fact) continue;
    if (facts.some((existing) => existing.label.toLowerCase() === label.toLowerCase())) continue;
    facts.push({ label, value: fact });
    if (facts.length >= 6) break;
  }
  return facts;
}

function normalizeWorld(value: unknown, fallbackTitle: string): CreationWorldDraft | null {
  const item = object(value);
  const content = text(item.content ?? item.lore ?? item.canon ?? item.text, 100000);
  if (content.length < 40) return null;
  return {
    name: text(item.name ?? item.title, 120) || `${fallbackTitle || "Imported"} world`,
    description: text(item.description ?? item.summary, 500),
    content,
  };
}

export type NormalizeOptions = {
  /** The complete pasted source, preserved verbatim on an import. */
  sourceMaterial?: string;
  /** Adult mode as the creator had it set before generating. */
  nsfwEnabled?: boolean;
  /** A structure the creator explicitly chose, which the model may not override. */
  creationType?: CreationType | null;
  /** True when the inventory pass ran, for the import summary only. */
  audited?: boolean;
};

/**
 * Provider output to canonical Creation draft.
 *
 * Two rules decide everything about adult content here, and they are not the
 * same rule:
 *
 *   * A source that is unambiguously adult produces an adult draft. Adult
 *     tags and adult mode are turned on together, because a creation carrying
 *     one and not the other cannot be published and would strand the creator
 *     in a loop.
 *   * A source that states or implies a participant under 18 never produces
 *     an adult draft, whatever else it says. The material is preserved
 *     unchanged — nobody's stated age is rewritten — but adult mode is off,
 *     adult tags are removed, the creation stays private, and the creator is
 *     told exactly what the contradiction was. The importer reports the
 *     conflict; it does not resolve it by editing the fiction.
 */
export function normalizeCreationResult(raw: string, options: NormalizeOptions = {}): CreationAiResult {
  const parsed = parseObject(raw);
  const value = parsed.value;
  const notices: CreationAiNotice[] = [];
  // A response that stopped early is recovered rather than discarded, and the
  // creator is told. Silence here is what made a short import look complete.
  if (parsed.repair === "truncated") {
    notices.push({
      kind: "source",
      message: "The importer's response was cut short and had to be repaired, so some of the material may be missing. Check the cast and the openings before you publish, and re-run the import if something you wrote is not here.",
    });
  }

  const { members: cast, duplicates, readerEntries } = normalizeCast(value.cast ?? value.characters ?? value.castMembers);
  if (duplicates) notices.push({ kind: "structure", message: `${duplicates} duplicate cast ${duplicates === 1 ? "entry was" : "entries were"} merged into the character they described.` });
  if (readerEntries.length) {
    notices.push({
      kind: "structure",
      message: `${readerEntries.length === 1 ? "An entry described" : `${readerEntries.length} entries described`} the reader rather than a character the AI plays, so ${readerEntries.length === 1 ? "it was moved" : "they were moved"} to “Your role in this story”. Cast is only for characters Afterglow portrays.`,
    });
  }

  const typeHint = text(value.creationType ?? value.type ?? value.cardType ?? value.profileType, 60);
  /*
   * The reader must not be able to turn a Character into a Cast.
   *
   * `resolveCreationType` trusts the model's own answer over the member count,
   * and a model that put the reader in the cast usually answered "cast"
   * because of it. So when removing reader entries leaves at most one
   * AI-portrayed character, and the creator did not explicitly ask for a cast,
   * the answer is corrected rather than honoured. A creator's own choice is
   * still an instruction and is never overridden.
   */
  const hintedType = resolveCreationType(typeHint, cast.length, options.creationType);
  const readerInflatedCast = !options.creationType && hintedType === "cast" && readerEntries.length > 0 && cast.length <= 1;
  const creationType = readerInflatedCast ? "character" : hintedType;
  if (readerInflatedCast) {
    notices.push({
      kind: "structure",
      message: "This is one character with a described reader role, not a cast, so it was kept as a Character. Change it on the first step if that is wrong.",
    });
  }
  const profileType = creationType === "character" ? "single" as const : "ensemble" as const;

  const suppliedName = text(value.name ?? value.characterName ?? value.cardName, 120);
  const suppliedTitle = text(value.title ?? value.creationTitle ?? value.cardName, 120);
  // A scenario has no primary character and must never be given an invented
  // one: its title stands in for the column the row requires, and the public
  // page titles itself from `title` regardless.
  const title = suppliedTitle || (creationType === "character" ? suppliedName : "") || suppliedName || "Untitled creation";
  const name = creationType === "character"
    ? suppliedName || cast[0]?.name || title
    : suppliedName && suppliedName !== title ? suppliedName : title;

  const { tags: platformTagsChosen, unknown } = normalizeTags(value.tags ?? value.platformTags);
  if (unknown.length) {
    notices.push({
      kind: "tags_dropped",
      message: `${unknown.slice(0, 4).map((tag) => `“${tag}”`).join(", ")}${unknown.length > 4 ? ` and ${unknown.length - 4} more` : ""} ${unknown.length === 1 ? "is not a platform tag" : "are not platform tags"}, so ${unknown.length === 1 ? "it was kept" : "they were kept"} as ${unknown.length === 1 ? "a hashtag" : "hashtags"} instead.`,
    });
  }
  const hashtags = normalizeHashtags(value.hashtags, unknown);

  // The model's own reading of the material, plus the tags it chose. Either is
  // enough to call the result adult; neither can make it adult on its own when
  // the material contradicts it below.
  const ageWarnings = list(value.ageWarnings ?? value.ageConflicts ?? value.safetyFlags, 400, 6);
  const declaredAdult = boolish(value.adult ?? value.nsfw ?? value.explicit);
  const adultByTag = adultTagsIn(platformTagsChosen).length > 0;

  const ageConflict = ageWarnings.length > 0;
  const tags = ageConflict ? platformTagsChosen.filter((tag) => !isAdultTag(tag)) : platformTagsChosen;
  const nsfwEnabled = ageConflict ? false : Boolean(options.nsfwEnabled || declaredAdult || adultByTag);

  if (ageConflict) {
    notices.push({
      kind: "age_conflict",
      message: `This source describes a participant who may be under 18, so adult mode is off, adult tags were removed and the creation stays private. Nothing in your text was rewritten. ${ageWarnings.slice(0, 2).join(" ")}`.trim(),
    });
  } else if (nsfwEnabled && !options.nsfwEnabled) {
    notices.push({
      kind: "adult_enabled",
      message: "Adult mode was switched on because this material is explicitly adult. Turn it off on the Publish step if that is wrong.",
    });
  }

  const rawAccent = text(value.accent ?? value.color, 20);
  const accent = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(rawAccent) ? rawAccent : "#e879a9";
  const rawAvatar = text(value.avatarUrl ?? value.avatar ?? value.imageUrl ?? value.image, 1500);
  const avatarUrl = /^https?:\/\//i.test(rawAvatar) ? rawAvatar : "";

  const world = normalizeWorld(value.world ?? value.worldDocument, title);
  // Lore that arrived as loose text rather than as a world document still
  // belongs in world material, not inside a character's backstory.
  const looseLore = text(value.lorebook ?? value.worldInfo ?? value.worldCanon, 50000);
  const lorebook = world ? "" : looseLore;
  if (world) {
    notices.push({ kind: "world", message: `World material was separated into “${world.name}”. It becomes a reusable World when you save, and you can edit or remove it first.` });
  }

  const suppliedUserRole = text(value.userRole ?? value.playerRole ?? value.yourRole, 4000);
  // What a removed reader entry said about the reader is not lost; it lands in
  // the field the writer prompt already reads the reader's role from.
  const userRole = suppliedUserRole || text(readerEntries.join("\n\n"), 4000);

  /*
   * Openings, kept.
   *
   * "The greeting disappeared" had three separate causes and all three are
   * handled here rather than hoped away:
   *
   *   THE PRIMARY WAS EMPTY WHILE ALTERNATES EXISTED. A model that returns
   *   `greeting: ""` and three `alternateGreetings` was giving three openings,
   *   not none. The first is promoted rather than the creation opening on
   *   silence.
   *
   *   MORE THAN THE LIMIT ARRIVED. The schema accepts twelve; a card with
   *   fifteen used to lose three without a word. They are still capped — the
   *   product limit is real — but the creator is told how many and can keep
   *   the ones they want.
   *
   *   THE RESPONSE STOPPED MID-ARRAY. That is reported by `parsed.repair`
   *   above, and the openings block is now written EARLY in the output
   *   contract so a truncated response loses prose rather than openings.
   */
  const suppliedOpenings = list(value.alternateGreetings ?? value.alternativeGreetings ?? value.initialMessages ?? value.openings, 8000, 64);
  const primary = text(value.greeting ?? value.firstMessage ?? value.initialMessage ?? value.opening, 8000);
  const greeting = primary || suppliedOpenings[0] || "";
  const remaining = suppliedOpenings.filter((opening) => opening !== greeting);
  const alternateGreetings = remaining.slice(0, maxAlternateGreetings);
  if (remaining.length > alternateGreetings.length) {
    notices.push({
      kind: "structure",
      message: `${remaining.length + 1} openings were found and Afterglow keeps ${maxAlternateGreetings + 1}, so the last ${remaining.length - alternateGreetings.length} ${remaining.length - alternateGreetings.length === 1 ? "was" : "were"} not imported. The rest are on the Opening step.`,
    });
  }

  const draft = characterSchema.parse({
    name,
    title,
    creationType,
    profileType,
    tagline: text(value.tagline ?? value.hook ?? value.summary, 300),
    description: text(value.description ?? value.publicDescription ?? value.premise, 6000),
    userRole,
    avatarUrl,
    avatarPath: "",
    accent,
    backstory: text(value.backstory ?? value.history ?? value.bio, 30000),
    cast,
    lorebook,
    personality: text(value.personality ?? value.persona ?? value.mannerisms ?? value.tone, 12000),
    scenario: text(value.scenario ?? value.openingScenario ?? value.setting, 12000),
    greeting,
    alternateGreetings,
    exampleDialogue: text(value.exampleDialogue ?? value.dialogueExamples ?? value.exampleMessages, 12000),
    responseDirective: text(value.responseDirective ?? value.systemPrompt ?? value.instructions ?? value.narratorRole, 8000),
    boundaries: text(value.boundaries ?? value.limits ?? value.contentRules, 5000),
    sourceMaterial: options.sourceMaterial ?? "",
    worldIds: [],
    tags,
    hashtags,
    quickFacts: normalizeQuickFacts(value.quickFacts ?? value.facts),
    // AI-assisted creation never publishes. The creator reviews everything and
    // chooses the visibility themselves on the Publish step.
    visibility: "private",
    nsfwEnabled,
  });

  const organizedCharacters = [
    draft.backstory, draft.personality, draft.scenario, draft.exampleDialogue,
    draft.responseDirective, draft.boundaries, draft.lorebook, draft.description,
    draft.userRole, draft.greeting, ...draft.alternateGreetings,
    ...draft.cast.map((member) => `${member.name}${member.role}${member.description}`),
  ].reduce((total, part) => total + part.length, 0);

  return {
    draft,
    world,
    notices,
    stats: {
      sourceCharacters: options.sourceMaterial?.length ?? 0,
      organizedCharacters,
      castMembers: draft.cast.length,
      openings: draft.alternateGreetings.length + (draft.greeting ? 1 : 0),
      tags: draft.tags.length,
      hashtags: draft.hashtags.length,
      unknownTags: unknown,
      worldCharacters: world ? world.content.length : draft.lorebook.length,
      audited: Boolean(options.audited),
      repair: parsed.repair,
    },
  };
}
