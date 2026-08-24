export type CharacterCastMember = {
  name: string;
  role: string;
  /** The full definition. Hidden: it feeds the prompt, never the public page. */
  description: string;
  /** A short public blurb. Safe to render on the creation page. */
  tagline: string;
  /** Supabase Storage object path for this member's portrait. */
  avatarPath: string;
  /** External portrait URL, used when no storage object exists. */
  avatarUrl: string;
};

export type CharacterVisibility = "private" | "unlisted" | "public";

/**
 * How a creation is authored.
 *
 * "character" is one primary character, "cast" is several defined characters
 * sharing one premise, and "scenario" is world/narrator-driven roleplay that
 * may define no primary character at all. All three publish into the same
 * feed, chat and discovery surfaces; the type only decides which authoring
 * fields matter and how the public page presents them.
 */
export type CreationType = "character" | "cast" | "scenario";
export const creationTypes = ["character", "cast", "scenario"] as const;

export type Character = {
  id: string;
  /**
   * The character's own name. For a scenario this is frequently empty of
   * product meaning and only `title` is shown, so nothing may assume that
   * this is what a card or a page should be titled with.
   */
  name: string;
  /**
   * The authoring structure. Derived from `profileType` for records created
   * before creations existed, so an old ensemble card reads as a cast.
   */
  creationType: CreationType;
  /**
   * Public display title. Empty means the creation predates the title field
   * and `name` stands in — see `creationTitle`.
   */
  title: string;
  /** Kept in sync with `creationType`; still read by prompts and snapshots. */
  profileType: "single" | "ensemble";
  tagline: string;
  /** Public premise/description. Never the hidden AI definition. */
  description: string;
  /** Who {{user}} plays. Optional, and mostly used by cast and scenario. */
  userRole: string;
  /** An imported card's external image URL, or a legacy inline data URI. */
  avatarUrl: string;
  /** Supabase Storage object path. Takes precedence over avatarUrl when set. */
  avatarPath: string;
  accent: string;
  backstory: string;
  cast: CharacterCastMember[];
  lorebook: string;
  personality: string;
  scenario: string;
  greeting: string;
  alternateGreetings: string[];
  exampleDialogue: string;
  responseDirective: string;
  boundaries: string;
  sourceMaterial: string;
  worldIds: string[];
  /**
   * Platform taxonomy tags. A controlled vocabulary used for filtering and
   * recommendations; see `src/lib/tags.ts`. Values outside the taxonomy are
   * still accepted so tags entered before it existed keep rendering.
   */
  tags: string[];
  /**
   * Creator-defined discovery hashtags, stored without the leading "#".
   * A separate system from `tags` on purpose: freeform, never a taxonomy.
   */
  hashtags: string[];
  /** Up to six creator-configured public facts, ordered. */
  quickFacts: CharacterQuickFact[];
  gallery: CharacterGalleryImage[];
  /** Public totals across every account, not the viewer's own activity. */
  publicStats: CharacterPublicStats;
  visibility: CharacterVisibility;
  nsfwEnabled: boolean;
  /** Global saves. Same number as `publicStats.saves`, kept for card code. */
  saveCount?: number;
  /** Whether the caller has this in their saved library. Never anybody else's. */
  savedByViewer?: boolean;
  creator?: { id: string; username: string; displayName: string; avatarPath: string } | null;
  /** False when the caller is chatting with a character somebody else published. */
  ownedByViewer: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * The public summary a discovery surface needs, and nothing else.
 *
 * Deliberately not a `Character`: the feed must never receive greetings,
 * personality, response directives, boundaries, cast definitions, world lore
 * or import source material, so those fields are not merely blanked out for
 * visitors here — they are never selected. The fields that do appear are the
 * ones a card renders plus the ones `src/lib/creation.ts` needs to decide a
 * title, which is why `name`, `title`, `creationType` and `profileType` all
 * travel together.
 */
export type CreationSummary = {
  id: string;
  name: string;
  title: string;
  creationType: CreationType;
  profileType: "single" | "ensemble";
  tagline: string;
  avatarUrl: string;
  avatarPath: string;
  accent: string;
  /** Platform taxonomy. Never merged with `hashtags`. */
  tags: string[];
  /** Creator vocabulary, stored without the leading "#". */
  hashtags: string[];
  nsfwEnabled: boolean;
  /** Global totals across every account. */
  messageCount: number;
  chatCount: number;
  saveCount: number;
  /** The caller's own save state. Other accounts' libraries are never exposed. */
  savedByViewer: boolean;
  creator: { id: string; username: string; displayName: string; avatarPath: string } | null;
  ownedByViewer: boolean;
  publishedAt: string | null;
  createdAt: string;
};

/**
 * A creation as its owner manages it.
 *
 * The management list is the same lean shape discovery uses plus the two
 * things only an owner needs — what its visibility is, and when it last
 * changed — and deliberately nothing else. A creator's own list is exactly
 * where it would be easiest to select the whole row out of habit and ship
 * every hidden definition to the browser for a page of cards; this type
 * exists so that is a compile error rather than a judgement call.
 */
export type OwnedCreationSummary = CreationSummary & {
  visibility: CharacterVisibility;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  characterId: string;
  title: string;
  summary: string;
  personaId: string | null;
  /** The inference writer for this story. Continuity remains owned by Afterglow. */
  providerId: string;
  modelId: string;
  rpEngineId: RoleplayEngineId;
  instructionPresets: ChatInstructionPreset[];
  customInstructions: string;
  /** Null means inherit the account default. */
  responseLength: ResponseLength | null;
  /** Null means inherit the account default. */
  temperature: number | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type Persona = {
  id: string;
  name: string;
  description: string;
  avatarUrl: string;
  avatarPath: string;
  accent: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A generic label/value pair so the six shown labels are a set, not a schema. */
export type CharacterQuickFact = { label: string; value: string };

export type CharacterGalleryImage = {
  id: string;
  storagePath: string;
  externalUrl: string;
  caption: string;
  position: number;
};

/**
 * Public character metrics. Every field is nullable because a metric that the
 * backend cannot answer yet must read as unavailable rather than as zero.
 */
export type CharacterPublicStats = {
  messages: number | null;
  /**
   * Global saves. This is the product's affinity metric; it is stored in the
   * `characters.like_count` column and the `character_likes` table, which
   * predate the rename and are deliberately left in place.
   */
  saves: number | null;
  chats: number | null;
  rank: number | null;
  rankCategory: string | null;
};

export type CharacterComment = {
  id: string;
  characterId: string;
  parentId: string | null;
  body: string;
  likeCount: number;
  createdAt: string;
  author: { id: string; username: string; displayName: string; avatarPath: string } | null;
  authoredByViewer: boolean;
};

export type World = {
  id: string;
  name: string;
  description: string;
  content: string;
  coverPath: string;
  coverUrl: string;
  visibility: CharacterVisibility;
  createdAt: string;
  updatedAt: string;
};

export type ChatInstructionPreset = "reduce_repetition" | "stay_focused" | "advance_plot";
export const responseLengths = ["concise", "natural", "detailed"] as const;
export type ResponseLength = typeof responseLengths[number];

export type Message = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  variants: string[];
  selectedVariant: number;
  memoryIds: string[];
  arcIds: string[];
  createdAt: string;
};

export type MemoryKind = "identity" | "relationship" | "event" | "promise" | "preference" | "boundary" | "open_loop";
export type MemoryStatus = "active" | "resolved" | "superseded";

export type Memory = {
  id: string;
  characterId: string;
  conversationId: string | null;
  content: string;
  kind: MemoryKind;
  importance: number;
  keywords: string[];
  pinned: boolean;
  status: MemoryStatus;
  resolution: string;
  resolvedAt: string | null;
  lastRecalledAt: string | null;
  recallCount: number;
  sourceMessageCount: number;
  /**
   * Lightweight grounding for when/where this happened in the story. Absent on
   * memories written before Scene State existed, which is expected and fine:
   * an un-annotated memory is simply presented without a chronology tag.
   */
  scene?: SceneStamp | null;
  createdAt: string;
};

export type MemoryArc = {
  id: string;
  conversationId: string;
  summary: string;
  keywords: string[];
  startMessageCount: number;
  endMessageCount: number;
  /** Approximate story-day span, when Scene State observed one. */
  storyDayStart?: number | null;
  storyDayEnd?: number | null;
  /** The distinct places the arc passed through, most recent last. */
  locations?: string[];
  createdAt: string;
};

export type CoreCanonStatus = "active" | "superseded" | "demoted";

/**
 * A compact, conversation-owned continuity layer. The complete evidence stays
 * in memories/memory_arcs; canon rows are curated pointers, never the archive.
 */
export type CoreCanonEntry = {
  id: string;
  conversationId: string;
  characterId: string;
  content: string;
  category: MemoryKind;
  importance: number;
  status: CoreCanonStatus;
  sourceMemoryIds: string[];
  sourceArcIds: string[];
  sourceMessageCount: number;
  tokenCount: number;
  curationVersion: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Scene State — where/when/who/what is happening RIGHT NOW.
 *
 * Deliberately separate from Core Canon (permanent facts), the rolling summary
 * (compressed recent narrative) and episodic memories (durable past events).
 * Every field is allowed to be unknown: a story that never named a date must
 * not be given one merely because the schema has a slot for it.
 */
export type SceneDateKind = "exact" | "relative" | "unknown";
export type SceneLocationConfidence = "stated" | "inferred" | "unknown";
export type SceneStateStatus = "ok" | "failed";

export type SceneLocation = {
  /** The containing place: "Maya's apartment", "U.A. dormitory". */
  place: string;
  /** The specific spot inside it: "bedroom", "common room". Optional. */
  sub: string;
  confidence: SceneLocationConfidence;
};

export type SceneState = {
  id: string;
  conversationId: string;
  /** Lineage position, counted exactly like memories.source_message_count. */
  throughMessageCount: number;
  throughMessageId: string | null;
  /**
   * Content fingerprint of the newest message this state was derived through.
   * A provisional row is trusted only while it still matches, so a regenerated
   * or edited reply can never leave its scene behind.
   */
  throughMessageFingerprint: string;
  /** True while the newest assistant reply can still be replaced. */
  provisional: boolean;
  status: SceneStateStatus;
  /** Relative chronology. Null means the story has not established one. */
  storyDay: number | null;
  dateKind: SceneDateKind;
  /** "2026-10-17" for exact, "the day after the festival" for relative. */
  dateText: string;
  /** A broad period: morning, afternoon, late evening. Empty means unknown. */
  timeOfDay: string;
  /** An exact in-story time only when the fiction stated one. */
  timeText: string;
  location: SceneLocation;
  presentCharacters: string[];
  /** A few immediate unresolved beats. Never a second rolling summary. */
  activeSituation: string[];
  /** Which fields the last update actually changed. Diagnostics only. */
  changedFields: string[];
  extractionModel: string;
  extractionProvider: string;
  extractionLatencyMs: number;
  failureReason: string;
  tokenCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** The compact grounding a memory or arc keeps about when/where it happened. */
export type SceneStamp = {
  storyDay: number | null;
  timeOfDay: string;
  location: string;
  present: string[];
};

export type Profile = {
  id: string;
  username: string;
  displayName: string;
  avatarPath: string;
  bio: string;
  plan: "free" | "beta" | "pro";
  createdAt: string;
  updatedAt: string;
};

export type CharacterReportReason = "underage" | "nonconsensual" | "real_person" | "stolen" | "harassment" | "other";

export const roleplayEngineIds = ["immersive", "raw", "kink_aware", "multi_clarity", "slow_burn", "cinematic", "deliberate"] as const;
export type RoleplayEngineId = typeof roleplayEngineIds[number];

export type ProviderDefinition = {
  id: string;
  label: string;
};

export type ModelDefinition = {
  id: string;
  providerId: string;
  label: string;
  description: string;
  supportsThinking: boolean;
};

export type RoleplayEngineDefinition = {
  id: RoleplayEngineId;
  label: string;
  description: string;
  thinking: boolean;
  adult: boolean;
  tags: string[];
};

export type ModelCatalog = {
  providers: ProviderDefinition[];
  models: ModelDefinition[];
  engines: RoleplayEngineDefinition[];
};

export type AppSettings = {
  ownerName: string;
  ownerProfile: string;
  /** Defaults for newly created conversations; existing stories keep theirs. */
  providerId: string;
  model: string;
  roleplayPreset: RoleplayEngineId;
  responseLength: ResponseLength;
  temperature: number;
  maxTokens: number;
  contextMessages: number;
  contextTokenBudget: number;
  consolidationInterval: number;
  memoryLimit: number;
  memoryTokenBudget: number;
};

export type UsageSummary = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  requests: number;
  estimatedCostUsd: number;
};

export type UsageBreakdown = UsageSummary & { key: string };

export type UsageResponse = {
  usage: UsageSummary;
  today?: UsageSummary;
  repliesToday?: number;
  userMessages?: number;
  costPer100UserMessages?: number;
  byModel: UsageBreakdown[];
  byProvider: UsageBreakdown[];
  byEngine: UsageBreakdown[];
  byFunding: UsageBreakdown[];
  byType: UsageBreakdown[];
  pricingAsOf: string;
};
