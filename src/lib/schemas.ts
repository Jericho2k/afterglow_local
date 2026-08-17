import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);

export const characterSchema = z.object({
  name: text(80).min(1),
  tagline: text(180).default(""),
  avatarUrl: z.union([
    z.literal(""),
    z.string().url().max(1500).refine((value) => value.startsWith("https://") || value.startsWith("http://"), "Avatar URL must use HTTP or HTTPS"),
  ]).default(""),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#e879a9"),
  backstory: text(12000).default(""),
  personality: text(5000).default(""),
  scenario: text(5000).default(""),
  greeting: text(4000).default(""),
  exampleDialogue: text(6000).default(""),
  responseDirective: text(3000).default(""),
  boundaries: text(3000).default(""),
  nsfwEnabled: z.boolean().default(false),
});

export const generateCharacterSchema = z.object({
  idea: text(50000).min(8),
  mode: z.enum(["idea", "dump"]).default("idea"),
  tone: z.enum(["romantic", "dramatic", "playful", "adventurous", "comforting", "custom"]).default("dramatic"),
  nsfwEnabled: z.boolean().default(false),
});

export const chatSchema = z.object({
  conversationId: z.string().uuid(),
  content: text(12000).default(""),
  action: z.enum(["send", "regenerate", "continue"]).default("send"),
});

export const memorySchema = z.object({
  characterId: z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
  content: text(3000).min(1),
  importance: z.number().int().min(1).max(5).default(3),
  keywords: z.array(text(80)).max(12).default([]),
  pinned: z.boolean().default(false),
});

export const memoryUpdateSchema = z.object({
  content: text(3000).min(1),
  importance: z.number().int().min(1).max(5),
  keywords: z.array(text(80)).max(12),
  pinned: z.boolean(),
});

export const messageUpdateSchema = z.object({
  content: text(12000).min(1).optional(),
  truncateAfter: z.boolean().default(false),
  variantIndex: z.number().int().min(0).optional(),
}).refine((value) => typeof value.content === "string" || value.variantIndex !== undefined, "Provide edited content or a variant index");

export const conversationUpdateSchema = z.object({
  title: text(120).min(1),
});

export const settingsSchema = z.object({
  ownerName: text(80).min(1).default("You"),
  ownerProfile: text(5000).default(""),
  model: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).default("deepseek-v4-flash"),
  temperature: z.number().min(0).max(2).default(0.95),
  maxTokens: z.number().int().min(256).max(8000).default(1800),
  contextMessages: z.number().int().min(8).max(100).default(30),
  consolidationInterval: z.number().int().min(6).max(50).default(10),
  memoryLimit: z.number().int().min(1).max(20).default(8),
});

export const backupSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema.optional(),
  characters: z.array(z.object({ id: z.string().min(1), data: characterSchema })).max(1000),
  conversations: z.array(z.object({
    id: z.string().min(1), characterId: z.string().min(1), title: text(120).min(1), summary: text(12000).default(""),
  })).max(5000),
  messages: z.array(z.object({
    conversationId: z.string().min(1), role: z.enum(["user", "assistant"]), content: text(12000).min(1),
    variants: z.array(text(12000).min(1)).max(1000).default([]), selectedVariant: z.number().int().min(0).default(0), createdAt: z.string().datetime().optional(),
  })).max(100000),
  memories: z.array(z.object({
    characterId: z.string().min(1), conversationId: z.string().nullable().optional(), content: text(3000).min(1),
    importance: z.number().int().min(1).max(5).default(3), keywords: z.array(text(80)).max(12).default([]), pinned: z.boolean().default(false),
  })).max(20000),
});
