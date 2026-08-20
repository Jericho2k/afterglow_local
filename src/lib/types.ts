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
  instructionPresets: ChatInstructionPreset[];
  customInstructions: string;
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

export type AppSettings = {
  ownerName: string;
  ownerProfile: string;
  model: string;
  roleplayPreset: "immersive" | "raw" | "cinematic" | "deliberate";
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
  byModel: UsageBreakdown[];
  byType: UsageBreakdown[];
  pricingAsOf: string;
};
