export type CharacterCastMember = {
  name: string;
  role: string;
  description: string;
};

export type Character = {
  id: string;
  name: string;
  profileType: "single" | "ensemble";
  tagline: string;
  avatarUrl: string;
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
  nsfwEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  characterId: string;
  title: string;
  summary: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

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
