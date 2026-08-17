export type Character = {
  id: string;
  name: string;
  tagline: string;
  avatarUrl: string;
  accent: string;
  backstory: string;
  personality: string;
  scenario: string;
  greeting: string;
  exampleDialogue: string;
  responseDirective: string;
  boundaries: string;
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
  createdAt: string;
};

export type MemoryKind = "identity" | "relationship" | "event" | "promise" | "preference" | "boundary" | "open_loop";

export type Memory = {
  id: string;
  characterId: string;
  conversationId: string | null;
  content: string;
  kind: MemoryKind;
  importance: number;
  keywords: string[];
  pinned: boolean;
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
};

export type UsageSummary = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  requests: number;
};
