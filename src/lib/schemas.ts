import { z } from "zod";
import { creationTypes, responseLengths, roleplayEngineIds } from "./types";
import { canonicalTag, maxHashtags, maxTags, normalizeHashtag } from "./tags";

const text = (max: number, min = 0) => z.preprocess(
  (value) => value == null ? "" : typeof value === "string" ? value : String(value),
  z.string().trim().min(min).max(max),
);

const accent = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(normalized)) {
    return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`;
  }
  return normalized;
}, z.string().regex(/^#[0-9a-fA-F]{6}$/)).default("#e879a9");

const imageSource = z.union([
  z.literal(""),
  z.string().url().max(1500).refine((value) => value.startsWith("https://") || value.startsWith("http://"), "Image URL must use HTTP or HTTPS"),
  z.string().max(3_500_000).regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, "Unsupported image data"),
]).default("");

// Supabase Storage object key. Paths are always scoped by account UUID, and
// the leading segment is fixed so a crafted key cannot escape the folder the
// storage policies grant this user.
const storagePath = z.union([
  z.literal(""),
  z.string().max(400).regex(/^users\/[0-9a-fA-F-]{36}\/[A-Za-z0-9._\-/]+$/, "Unsupported storage path")
    .refine((value) => !value.includes(".."), "Unsupported storage path"),
]).default("");

const visibility = z.enum(["private", "unlisted", "public"]).default("private");

export const characterCastMemberSchema = z.object({
  name: text(120, 1),
  role: text(240).default(""),
  /** The AI definition. Never rendered publicly. */
  description: text(8000).default(""),
  /** A short public blurb for the cast card. */
  tagline: text(240).default(""),
  avatarPath: storagePath,
  avatarUrl: imageSource,
});

const characterFields = z.object({
  // A creation still needs an internal name, but a scenario is allowed to
  // reuse its title for it: only `title` is presented.
  name: text(120, 1),
  // Optional on the wire so a payload written before creations existed — a
  // backup file, an older client — is inferred from profileType rather than
  // silently downgraded to a plain character.
  creationType: z.enum(creationTypes).optional(),
  title: text(120).default(""),
  profileType: z.enum(["single", "ensemble"]).default("single"),
  tagline: text(300).default(""),
  /** Public premise. Kept apart from the hidden definition on purpose. */
  description: text(6000).default(""),
  /** Who {{user}} plays. Optional for every creation type. */
  userRole: text(4000).default(""),
  avatarUrl: imageSource,
  avatarPath: storagePath,
  accent,
  backstory: text(30000).default(""),
  cast: z.preprocess((value) => value == null ? [] : value, z.array(characterCastMemberSchema).max(50)).default([]),
  lorebook: text(50000).default(""),
  personality: text(12000).default(""),
  scenario: text(12000).default(""),
  greeting: text(8000).default(""),
  alternateGreetings: z.preprocess((value) => value == null ? [] : value, z.array(text(8000, 1)).max(12)).default([]),
  exampleDialogue: text(12000).default(""),
  responseDirective: text(8000).default(""),
  boundaries: text(5000).default(""),
  sourceMaterial: text(100000).default(""),
  worldIds: z.preprocess((value) => value == null ? [] : value, z.array(z.string().uuid()).max(50)).default([]),
  // Canonical public tags. The hero chips and the Tags section read the same
  // array, so there is never a second tag dataset to drift out of sync.
  tags: z.preprocess(
    (value) => Array.isArray(value) ? value : [],
    z.array(z.string().trim().min(1).max(40)).max(maxTags),
  ).transform((tags) => Array.from(new Set(tags.map((tag) => canonicalTag(tag)).filter(Boolean))).slice(0, maxTags)).default([]),
  // Generic label/value pairs, capped at six. The labels the design shows are
  // a starting set rather than a fixed schema.
  quickFacts: z.preprocess(
    (value) => Array.isArray(value) ? value : [],
    z.array(z.object({ label: text(40, 1), value: text(120, 1) })).max(6),
  ).default([]),
  // Creator-defined discovery hashtags. Stored normalised and without the
  // leading "#", and never merged with the platform tag taxonomy above.
  hashtags: z.preprocess(
    (value) => Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [],
    z.array(z.string()).max(60),
  ).transform((hashtags) => Array.from(new Set(hashtags.map((tag) => normalizeHashtag(String(tag))).filter(Boolean))).slice(0, maxHashtags)).default([]),
  visibility,
  nsfwEnabled: z.boolean().default(false),
});

/**
 * The creation type and the legacy profile type describe the same thing, so
 * one is derived from the other rather than being allowed to disagree. An
 * older payload that only knows about profileType still resolves correctly.
 */
export const characterSchema = characterFields.transform((value) => {
  const resolved = value.creationType ?? (value.profileType === "ensemble" ? "cast" : "character");
  return { ...value, creationType: resolved, profileType: resolved === "character" ? "single" as const : "ensemble" as const };
});

export function characterValidationMessage(error: z.ZodError) {
  const issue = error.issues[0];
  if (!issue) return "Invalid character";
  const field = issue.path.length ? issue.path.join(" → ") : "Character";
  return `${field}: ${issue.message}`;
}

export const generateCharacterSchema = z.object({
  idea: text(100000, 8),
  mode: z.enum(["idea", "dump"]).default("idea"),
  tone: z.enum(["romantic", "dramatic", "playful", "adventurous", "comforting", "custom"]).default("dramatic"),
  nsfwEnabled: z.boolean().default(false),
});

export const chatSchema = z.object({
  conversationId: z.string().uuid(),
  content: text(12000).default(""),
  action: z.enum(["send", "regenerate", "continue"]).default("send"),
  userMessageId: z.string().uuid().nullable().optional(),
  assistantMessageId: z.string().uuid().optional(),
});

export const memorySchema = z.object({
  characterId: z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
  content: text(3000, 1),
  kind: z.enum(["identity", "relationship", "event", "promise", "preference", "boundary", "open_loop"]).default("event"),
  importance: z.number().int().min(1).max(5).default(3),
  keywords: z.array(text(80)).max(12).default([]),
  pinned: z.boolean().default(false),
  status: z.enum(["active", "resolved", "superseded"]).default("active"),
  resolution: text(1000).default(""),
});

export const memoryUpdateSchema = z.object({
  content: text(3000, 1),
  kind: z.enum(["identity", "relationship", "event", "promise", "preference", "boundary", "open_loop"]),
  importance: z.number().int().min(1).max(5),
  keywords: z.array(text(80)).max(12),
  pinned: z.boolean(),
  status: z.enum(["active", "resolved", "superseded"]).default("active"),
  resolution: text(1000).default(""),
});

export const messageUpdateSchema = z.object({
  content: text(12000, 1).optional(),
  truncateAfter: z.boolean().default(false),
  variantIndex: z.number().int().min(0).optional(),
  messageId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  messagePosition: z.number().int().min(1).optional(),
}).refine((value) => typeof value.content === "string" || value.variantIndex !== undefined, "Provide edited content or a variant index");

export const conversationUpdateSchema = z.object({
  title: text(120, 1).optional(),
  personaId: z.string().uuid().nullable().optional(),
  providerId: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).optional(),
  modelId: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).optional(),
  rpEngineId: z.enum(roleplayEngineIds).optional(),
  instructionPresets: z.array(z.enum(["reduce_repetition", "stay_focused", "advance_plot"])).max(3).optional(),
  customInstructions: text(3000).optional(),
  responseLength: z.enum(responseLengths).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), "Provide a conversation change");

export const personaSchema = z.object({
  name: text(100, 1),
  description: text(6000).default(""),
  avatarUrl: imageSource,
  avatarPath: storagePath,
  accent,
  isDefault: z.boolean().default(false),
});

export const profileSchema = z.object({
  username: z.union([
    z.literal(""),
    z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,29}$/, "Usernames are 3-30 characters: letters, numbers, dashes and underscores"),
  ]).default(""),
  displayName: text(80, 1),
  bio: text(2000).default(""),
  avatarPath: storagePath,
});

export const characterLikeSchema = z.object({ characterId: z.string().uuid() });

export const characterReportSchema = z.object({
  characterId: z.string().uuid(),
  reason: z.enum(["underage", "nonconsensual", "real_person", "stolen", "harassment", "other"]),
  details: text(3000).default(""),
});

export const worldSchema = z.object({
  name: text(120, 1),
  description: text(500).default(""),
  content: text(100000, 1),
  coverPath: storagePath,
  coverUrl: imageSource,
  visibility,
});

export const commentSchema = z.object({
  characterId: z.string().uuid(),
  body: text(2000, 1),
  parentId: z.string().uuid().nullable().optional(),
});

export const gallerySchema = z.object({
  characterId: z.string().uuid(),
  images: z.array(z.object({
    storagePath: storagePath,
    externalUrl: imageSource,
    caption: text(200).default(""),
  })).max(12).default([]),
});

export const settingsSchema = z.object({
  ownerName: text(80, 1).default("You"),
  ownerProfile: text(5000).default(""),
  providerId: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).default("deepseek"),
  model: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).default("deepseek-v4-flash"),
  roleplayPreset: z.enum(roleplayEngineIds).default("immersive"),
  responseLength: z.enum(responseLengths).default("natural"),
  temperature: z.number().min(0).max(2).default(0.95),
  maxTokens: z.number().int().min(256).max(8000).default(1800),
  contextMessages: z.number().int().min(8).max(100).default(30),
  contextTokenBudget: z.number().int().min(4000).max(100000).default(12000),
  consolidationInterval: z.number().int().min(6).max(50).default(10),
  memoryLimit: z.number().int().min(1).max(20).default(8),
  memoryTokenBudget: z.number().int().min(1000).max(30000).default(6000),
});

export const backupSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema.optional(),
  personas: z.array(z.object({ id: z.string().min(1), data: personaSchema })).max(1000).default([]),
  worlds: z.array(z.object({ id: z.string().min(1), data: worldSchema })).max(5000).default([]),
  characters: z.array(z.object({ id: z.string().min(1), data: characterSchema })).max(1000),
  conversations: z.array(z.object({
    id: z.string().min(1), characterId: z.string().min(1), title: text(120, 1), summary: text(12000).default(""), personaId: z.string().nullable().optional(),
    providerId: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).default("deepseek"), modelId: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).default("deepseek-v4-flash"),
    rpEngineId: z.enum(roleplayEngineIds).default("immersive"),
    instructionPresets: z.array(z.enum(["reduce_repetition", "stay_focused", "advance_plot"])).max(3).default([]), customInstructions: text(3000).default(""),
    responseLength: z.enum(responseLengths).nullable().default(null), temperature: z.number().min(0).max(2).nullable().default(null),
  })).max(5000),
  messages: z.array(z.object({
    conversationId: z.string().min(1), role: z.enum(["user", "assistant"]), content: text(12000, 1),
    variants: z.array(text(12000, 1)).max(1000).default([]), selectedVariant: z.number().int().min(0).default(0), createdAt: z.string().datetime().optional(),
  })).max(100000),
  memories: z.array(z.object({
    characterId: z.string().min(1), conversationId: z.string().nullable().optional(), content: text(3000, 1),
    kind: z.enum(["identity", "relationship", "event", "promise", "preference", "boundary", "open_loop"]).default("event"),
    importance: z.number().int().min(1).max(5).default(3), keywords: z.array(text(80)).max(12).default([]), pinned: z.boolean().default(false),
    status: z.enum(["active", "resolved", "superseded"]).default("active"), resolution: text(1000).default(""),
    sourceMessageCount: z.number().int().min(0).default(0),
  })).max(20000),
  arcs: z.array(z.object({
    conversationId: z.string().min(1), summary: text(4000, 1), keywords: z.array(text(80)).max(12).default([]),
    startMessageCount: z.number().int().min(0).default(0), endMessageCount: z.number().int().min(0).default(0),
  })).max(20000).default([]),
});
