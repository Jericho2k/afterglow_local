export type CharacterCastMember = {
  name: string;
  role: string;
  description: string;
};

export type CharacterVisibility = "private" | "unlisted" | "public";

export type Character = {
  id: string;
  name: string;
  profileType: "single" | "ensemble";
  tagline: string;
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
  visibility: CharacterVisibility;
  nsfwEnabled: boolean;
  likeCount?: number;
  likedByViewer?: boolean;
  creator?: { id: string; username: string; displayName: string; avatarPath: string } | null;
  /** False when the caller is chatting with a character somebody else published. */
  ownedByViewer: boolean;
  createdAt: string;
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

export type World = {
  id: string;
  name: string;
  description: string;
  content: string;
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
  createdAt: string;
};

export type MemoryArc = {
  id: string;
  conversationId: string;
  summary: string;
  keywords: string[];
  startMessageCount: number;
  endMessageCount: number;
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
