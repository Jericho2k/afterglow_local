import type { ArtPresentation } from "./art-presentation";
import type { RichBlock } from "./rich-content";

export type CharacterCastMember = {
  /**
   * A stable identifier for this member, used by its own public page.
   *
   * Absent on every member written before cast pages existed, which is why
   * nothing may depend on it directly: `castMemberKey` in `src/lib/cast.ts`
   * resolves an addressable key for a member with or without one. An array
   * index would have been the obvious choice and the wrong one — reordering
   * the cast would silently repoint every link.
   */
  id?: string;
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
 * What a creation's roleplay is about, which is not the same question as what
 * its cover may be shown to, and not the same question as what THIS reader may
 * receive. See `src/lib/content-mode.ts` for all three rules and why they are
 * separate. Authoritative from migration 0036; `nsfwEnabled` is deprecated.
 */
export type ContentMode = "clean" | "adult_capable" | "adult_focused";

/** Re-exported so a consumer of `Character` needs one import, not two. */
import type { ShareMediaStatus } from "./content-mode";
export type { ShareMediaStatus };

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
  /**
   * The description's structured blocks, when the creator placed images in it.
   *
   * Empty means the creation is plain text, which is what every record written
   * before rich content looks like. `description` above always holds the text
   * either way, so nothing that reads it needs to know this field exists —
   * including, deliberately, everything that builds a model prompt.
   */
  descriptionRich: RichBlock[];
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
  /** The opening's blocks, when it contains images. Text stays in `greeting`. */
  greetingRich: RichBlock[];
  alternateGreetings: string[];
  /** Index-aligned with `alternateGreetings`. An empty entry means plain text. */
  alternateGreetingsRich: RichBlock[][];
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
  moderationStatus?: "active" | "removed";
  moderationReason?: string;
  contentMode: ContentMode;
  /**
   * DEPRECATED. `contentMode` is authoritative — see `src/lib/content-mode.ts`.
   * Retained only so records written before 0036 still round-trip.
   */
  nsfwEnabled: boolean;
  /*
   * The outward-facing half, all optional because a record that predates 0036
   * — a fixture, a backup, a snapshot — simply has none of it, and the absence
   * resolves to the conservative answer everywhere: no nominated media, an
   * unreviewed status, and no safe title, which together mean a branded card
   * and neutral copy rather than a guess.
   */
  /** Creator-nominated preview image, used for link previews and nothing else. */
  shareImagePath?: string;
  shareImageUrl?: string;
  /** Platform classification of that media. Only "safe" leaves Afterglow. */
  shareMediaStatus?: ShareMediaStatus;
  /** The outward name and line, written for people who have not chosen this yet. */
  shareTitle?: string;
  shareTagline?: string;
  /**
   * Optional wide artwork for desktop. Absent means the primary artwork is
   * used with its own focal point — see `bannerArt`.
   */
  bannerPath?: string;
  bannerUrl?: string;
  /**
   * How the artwork is framed. Absent or `{}` means the creator has chosen
   * nothing and every surface keeps its stylesheet default — see
   * `src/lib/art-presentation.ts`. Optional for the same reason the share
   * fields are: a fixture, a snapshot or a pre-0037 backup simply has none.
   */
  artPresentation?: ArtPresentation;
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
  /** Wide artwork and framing, so a card crops exactly as the page does. */
  bannerPath?: string;
  bannerUrl?: string;
  artPresentation?: ArtPresentation;
  accent: string;
  /** Platform taxonomy. Never merged with `hashtags`. */
  tags: string[];
  /** Creator vocabulary, stored without the leading "#". */
  hashtags: string[];
  contentMode: ContentMode;
  /** Derived from `contentMode`; true for both adult modes. */
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
  /** The creation this belongs to. Empty for a comment on a world. */
  characterId: string;
  /** The world this belongs to. Empty for a comment on a creation. */
  worldId?: string;
  parentId: string | null;
  body: string;
  likeCount: number;
  createdAt: string;
  author: { id: string; username: string; displayName: string; avatarPath: string } | null;
  authoredByViewer: boolean;
};

/**
 * A reusable world.
 *
 * Worlds are settings, not scenarios: "My Hero Academia" is a world and "The
 * Final War" is a creation set in one. The same world document can back any
 * number of creations, which is why it owns its own page, its own cover, its
 * own saves and its own comments rather than living inside whichever creation
 * happens to reference it.
 */
export type World = {
  id: string;
  name: string;
  description: string;
  /** The lore as text. Always populated, and always what a prompt reads. */
  content: string;
  /** The lore's blocks, when the creator placed images in it. */
  contentRich: RichBlock[];
  coverPath: string;
  coverUrl: string;
  visibility: CharacterVisibility;
  /** Global saves across every account. */
  saveCount: number;
  /** The caller's own save state. Never anybody else's. */
  savedByViewer: boolean;
  ownedByViewer: boolean;
  creator: { id: string; username: string; displayName: string; avatarPath: string } | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A world a viewer is not allowed to open.
 *
 * A public creation may be built on a private world, and hiding the
 * association entirely would misrepresent the creation — the world is part of
 * what it is. So the card is shown and locked: enough identity to read as
 * deliberate, and nothing whatsoever of the lore, the description, the
 * comments or the creator's notes. This type is the exhaustive list of what
 * leaves the server for such a world, which is what makes that reviewable.
 */
export type LockedWorldPreview = {
  id: string;
  name: string;
  coverPath: string;
  coverUrl: string;
  locked: true;
};

/** Either a world the viewer may open, or the locked stand-in for one they may not. */
/**
 * A world as a creation page shows one: a card.
 *
 * Built on `WorldSummary` rather than `World` because the creation page renders
 * a cover, a name and a description and never the lore. It used to carry the
 * whole canon document per attached world — so a creation built on a
 * hundred-thousand-character world downloaded that document on every view, to
 * display none of it. The world's own page is where lore is read.
 */
export type AttachedWorld = (WorldSummary & { locked?: false }) | LockedWorldPreview;

/** The lean row a world card is built from. Never carries lore. */
export type WorldSummary = {
  id: string;
  name: string;
  description: string;
  coverPath: string;
  coverUrl: string;
  visibility: CharacterVisibility;
  saveCount: number;
  savedByViewer: boolean;
  ownedByViewer: boolean;
  /** How many creations use it, where the surface shows that. */
  creationCount: number;
  creator: { id: string; username: string; displayName: string; avatarPath: string } | null;
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
  /**
   * Which revision of this turn's text the row currently holds.
   *
   * Message content is mutable — the inline editor rewrites it, and selecting a
   * different option replaces it — so a generation that recorded "this was the
   * transcript" has to record a version alongside each id or it will end up
   * describing text written after the fact. See src/lib/provenance.ts.
   *
   * Absent on a message the browser has just made optimistically and on test
   * fixtures, which have no server revision yet; absent means 1.
   */
  contentVersion?: number;
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
   * When this memory last earned its place on RELEVANCE ALONE, in messages.
   *
   * Deliberately not `lastRecalledAt`, which the protected tier writes on every
   * turn and which therefore cannot be evidence that a protected memory still
   * matters. See `isStaleCommitment`. Absent means never.
   */
  lastRelevanceMatchCount?: number;
  /**
   * Which revision of the text this row holds; see src/lib/provenance.ts.
   * Absent means 1, the revision a memory has until it is first edited.
   */
  contentVersion?: number;
  /**
   * Who wrote this memory.
   *
   * `consolidation` is the extractor's; `user` is the reader's own; `import`
   * came in with a backup. The distinction is what lets the archive be shown
   * honestly — "Afterglow remembered this" and "you wrote this" are different
   * claims — and it is deliberately not a permission: an owner may edit either.
   */
  origin?: "consolidation" | "user" | "import";
  /** The memory that replaced this one, when it was superseded by an edit. */
  supersededBy?: string | null;
  supersededAt?: string | null;
  /**
   * Lightweight grounding for when/where this happened in the story. Absent on
   * memories written before Scene State existed, which is expected and fine:
   * an un-annotated memory is simply presented without a chronology tag.
   */
  scene?: SceneStamp | null;
  createdAt: string;
  updatedAt?: string;
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

/**
 * HOW PRECISELY THE STORY HAS FIXED THE TIME.
 *
 * One field was never enough and the two it replaced were the wrong two. The
 * ledger used to hold a broad `time_of_day` and an optional exact `time_text`,
 * which can say "evening" and "21:37" and nothing in between — so "around nine"
 * became either a period that lost the hour or a clock reading the story never
 * gave, and "a few minutes later" had nowhere to live at all.
 *
 * So precision is DECLARED, and the rule that follows from declaring it is the
 * one that matters: a value is never promoted to a precision the fiction did
 * not establish. "Late evening" stays a period forever unless somebody looks at
 * a clock.
 *
 *   exact         The fiction stated a clock time: "21:37".
 *   approximate   The fiction placed it near one: "around 9 PM", "just gone six".
 *   period        A named stretch of the day: "late evening", "mid-afternoon".
 *   relative      Measured from the last beat: "a few minutes later".
 *   unknown       Nobody has said, which is a correct and common answer.
 */
export type SceneTimeKind = "exact" | "approximate" | "period" | "relative" | "unknown";

export type SceneTime = {
  kind: SceneTimeKind;
  /** As the story phrased it. Empty exactly when `kind` is "unknown". */
  text: string;
};

/**
 * Somebody in the scene, and roughly where.
 *
 * "Roughly" is the entire specification. This replaced a twelve-field body
 * model — postures, both arms, both hands, both legs, both feet, what bears the
 * weight, a contact graph and a constraint list — that cost a large extraction
 * on every turn to keep a simulation whose detail the writer did not use and
 * whose errors it inherited. What a reply actually needs from the ledger is that
 * Anna is still by the window while the user talks to Maya.
 *
 * `position` is one short phrase — "on the sofa", "beside User", "near the
 * window" — and empty means nobody has said, which is a correct answer and the
 * common one.
 */
export type ScenePresence = {
  name: string;
  position: string;
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
  /** When it is, at whatever precision the story actually established. */
  time: SceneTime;
  location: SceneLocation;
  /**
   * Who is in the scene, and roughly where.
   *
   * The list is maintained by ARRIVAL AND DEPARTURE rather than by restatement,
   * which is the property the whole ledger exists for: three people who walked
   * into the room are still in it thirty messages later while the user talks to
   * one of them, because nothing said any of them left. An extractor that
   * simply did not mention somebody has said nothing about them.
   */
  present: ScenePresence[];
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
  /**
   * The time as the ledger held it, at whatever precision that was: "late
   * evening", "around 9 PM", "21:37". The column name predates the precision
   * model and is kept because it is written into every stored memory.
   */
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
  /**
   * Whether this account has stated it belongs to an adult. Half of
   * `explicitRoleplayAllowed`; the other half is a settings preference.
   */
  adultConfirmed: boolean;
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

/**
 * The shelf a model sits on in the picker.
 *
 * Product language, deliberately. A reader choosing a writer is choosing an
 * experience — "the good one", "the cheap one", "the free one", "the one we are
 * still measuring" — and not an inference vendor, a quantisation or a
 * provider slug. Everything infrastructural about a model stays in
 * `ModelCapabilities`, which never reaches the browser.
 */
export type ModelCategory = "recommended" | "economy" | "free" | "experimental";

export type ModelDefinition = {
  id: string;
  providerId: string;
  label: string;
  description: string;
  supportsThinking: boolean;
  category: ModelCategory;
  /** Costs the reader nothing: a curated `:free` endpoint or the shared pool. */
  free: boolean;
  /**
   * A short, honest note the picker shows beneath a model that needs one —
   * a free route's shared-capacity caveat, or an experimental route's privacy
   * disclosure. Empty when there is nothing a reader needs warning about.
   */
  notice?: string;
  /**
   * How a volatile route is behaving, for the routes where that is a real
   * question.
   *
   * Present only on free routes. A paid model's availability is a provider
   * incident handled by failover, and decorating every row with a status dot
   * would train readers to ignore the one place the dot means something.
   */
  availability?: "available" | "busy" | "unavailable";
  /** The route works but streams slowly enough to be worth choosing last. */
  deprioritized?: boolean;
  /**
   * A route that exists for background inference and is never offered as a
   * writer.
   *
   * The memory A/B needs one model to appear several times — once per upstream
   * host under evaluation — because a host is what the comparison is about. A
   * reader choosing who writes their story is being asked a different question,
   * and three rows with the same name under it is not an answer to it. So these
   * resolve normally everywhere routing happens and are filtered out of the
   * picker's catalogue.
   */
  backgroundOnly?: boolean;
};

export type RoleplayEngineDefinition = {
  id: RoleplayEngineId;
  label: string;
  description: string;
  thinking: boolean;
  adult: boolean;
  tags: string[];
};

/**
 * What the reader has left of the free tier today.
 *
 * A count of THEIR remaining generations and a boolean for whether shared
 * capacity exists at all. The platform's exact remaining figure is deliberately
 * absent: it is a fact about Afterglow's OpenRouter account rather than about
 * the reader, and it invites refreshing until a number goes up. Both sentences
 * the interface needs — "free generations available today" and "today's shared
 * free capacity has been used" — are answerable without it.
 */
export type FreeTierStatusView = {
  enabled: boolean;
  userRemaining: number;
  userCap: number;
  sharedCapacityAvailable: boolean;
  fundedFallbackAvailable: boolean;
  /** UTC midnight, so the interface can say when it comes back. */
  resetsAt: string;
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
  /**
   * Whether this reader has asked for explicit content.
   *
   * Half of the reader's side of `explicitRoleplayAllowed`; the other half is
   * the age confirmation on their profile. Off by default, so an adult-capable
   * story stays clean until somebody says otherwise.
   */
  adultContentEnabled: boolean;
  /**
   * Admin-only, per-model OpenRouter upstream pins used for provider/cache
   * experiments. Ordinary accounts never receive or influence this field.
   */
  adminWriterUpstreamOverrides?: Record<string, string>;
};

export type UsageSummary = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens: number;
  /** cacheHitTokens / promptTokens, or null when the bucket has no prompt tokens. */
  cachedRatio: number | null;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
  requests: number;
  /** Total provider-reported/estimated inference value, regardless of payer. */
  estimatedCostUsd: number;
  /** Actual platform expense; explicitly excludes BYOK rows. */
  afterglowCostUsd: number;
  /** Informational value paid through users' OpenRouter credentials. */
  byokCostUsd: number;
};

export type UsageBreakdown = UsageSummary & { key: string };

export type UsageRangeSummary = { id: string; label: string; from: string | null; to: string | null };

export type AdminWriterRoutingEndpoint = {
  tag: string;
  name: string;
  providerName: string;
  promptUsdPerMillion: number | null;
  cachedUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  quantization: string | null;
  status: string | null;
  cacheCapable: boolean;
  withinCostGuard: boolean;
};

export type AdminWriterRoutingResponse = {
  modelId: string;
  selected: string | null;
  shippedDefault: string;
  endpoints: AdminWriterRoutingEndpoint[];
  note: string;
};

export type WriterCacheProbeSample = {
  createdAt: string;
  action: string;
  model: string;
  upstreamProvider: string | null;
  upstreamOverride: string | null;
  promptTokens: number;
  cachedTokens: number;
  actualRatio: number | null;
  structuralPrefixTokens: number;
  structuralRatio: number | null;
  gapTokens: number;
  anchorMoved: boolean | null;
  sharedMessages: number;
  totalMessages: number;
  placement: string | null;
};

export type WriterCacheProbeResponse = {
  samples: WriterCacheProbeSample[];
  summary: {
    samples: number;
    promptTokens: number;
    cachedTokens: number;
    structuralPrefixTokens: number;
    actualRatio: number | null;
    structuralRatio: number | null;
    gapTokens: number;
  };
};

export type UsageResponse = {
  /** The window every figure below describes. */
  range?: UsageRangeSummary;
  usage: UsageSummary;
  /**
   * Paid writer calls in range: Reply + Regenerate + Continue, counted from the
   * usage ledger. Never from assistant message rows — branching copies those.
   */
  writerGenerations?: number;
  /** Distinct accepted user turns that started a generation. */
  userMessages?: number;
  costPer100UserMessages?: number;
  costPer100WriterGenerations?: number;
  byModel: UsageBreakdown[];
  byProvider: UsageBreakdown[];
  byEngine: UsageBreakdown[];
  byFunding: UsageBreakdown[];
  byType: UsageBreakdown[];
  byUpstreamProvider?: UsageBreakdown[];
  pricingAsOf: string;
};

/**
 * The routing diagnostic, which answers a question Usage & Cost cannot.
 *
 * That report sums across every conversation at once, so it looks identical
 * whether one story bounced between four upstream hosts or four stories each
 * settled on one. This shape is per CONVERSATION, in time order, so "is
 * anything actually drifting" has an answer rather than an impression.
 */
export type RoutingProviderEconomics = {
  provider: string;
  slug: string | null;
  generations: number;
  conversations: number;
  promptTokens: number;
  cachedTokens: number;
  freshTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRatio: number | null;
  costUsd: number | null;
  costPerGeneration: number | null;
  costPer100Generations: number | null;
  /** Derived by subtracting the output half at list rates; null when unknown. */
  effectiveInputUsdPerMillion: number | null;
  effectiveInputBasis: "derived" | "unknown_endpoint_pricing";
  listOutputUsdPerMillion: number | null;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
};

export type RoutingConversationAffinity = {
  conversationId: string;
  model: string;
  generations: number;
  providerSwitches: number;
  firstProvider: string | null;
  latestProvider: string | null;
  providers: Array<{ provider: string; slug: string | null; generations: number }>;
  promptTokens: number;
  cachedTokens: number;
  freshTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  costPerGeneration: number | null;
  cacheRatio: number | null;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
};

export type RoutingDiagnosticResponse = {
  range?: UsageRangeSummary;
  model: string | null;
  routing: {
    mode: string;
    /** Whether the last-attempt escape hatch above the price ceiling is armed. */
    emergencyExpensiveFallback?: boolean;
    /**
     * What is actually guarding each model, read back from the server rather
     * than remembered. A guard nobody can inspect is a guard nobody can trust,
     * and three weeks later nobody remembers whether the ceiling was on.
     */
    guards?: Array<{
      modelId: string;
      free: boolean;
      approvedProviders: string[];
      maxPrice: { prompt: number; completion: number } | null;
      enforcedPool: string[] | null;
      dataPolicy: { dataCollection: "allow" | "deny"; zdr?: boolean } | null;
      fundable: boolean;
    }>;
  };
  truncated: boolean;
  generations: number;
  drift: {
    minimumGenerations: number;
    eligibleConversations: number;
    driftedConversations: number;
    driftedShare: number | null;
    totalSwitches: number;
    switchesPerGeneration: number | null;
    worst: Array<{ conversationId: string; generations: number; providerSwitches: number; cacheRatio: number | null }>;
  };
  byProvider: RoutingProviderEconomics[];
  byConversation: RoutingConversationAffinity[];
};
