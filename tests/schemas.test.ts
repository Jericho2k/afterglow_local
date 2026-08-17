import { describe, expect, it } from "vitest";
import { backupSchema, characterSchema, chatSchema, generateCharacterSchema, messageUpdateSchema, settingsSchema } from "@/lib/schemas";

describe("character validation", () => {
  it("applies safe defaults", () => {
    const character = characterSchema.parse({ name: "Mara" });
    expect(character.nsfwEnabled).toBe(false);
    expect(character.accent).toBe("#e879a9");
  });

  it("rejects invalid avatar protocols and colors", () => {
    expect(characterSchema.safeParse({ name: "Mara", avatarUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(characterSchema.safeParse({ name: "Mara", accent: "pink" }).success).toBe(false);
  });

  it("requires a meaningful generation concept", () => {
    expect(generateCharacterSchema.safeParse({ idea: "elf" }).success).toBe(false);
  });

  it("accepts a large unstructured character dump", () => {
    const parsed = generateCharacterSchema.parse({ idea: "Name: Mara\n" + "Detailed lore. ".repeat(1000), mode: "dump" });
    expect(parsed.mode).toBe("dump");
    expect(parsed.idea.length).toBeGreaterThan(10000);
  });
});

describe("instance settings and backups", () => {
  it("accepts current DeepSeek model controls within bounded ranges", () => {
    const settings = settingsSchema.parse({ ownerName: "Alex", model: "deepseek-v4-pro", roleplayPreset:"raw", temperature: 1.1, maxTokens: 2400 });
    expect(settings.model).toBe("deepseek-v4-pro");
    expect(settings.roleplayPreset).toBe("raw");
    expect(settings.contextMessages).toBe(30);
  });

  it("rejects unsafe model identifiers and oversized context controls", () => {
    expect(settingsSchema.safeParse({ ownerName: "Alex", model: "https://evil.test/model" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ownerName: "Alex", roleplayPreset:"anything-goes" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ownerName: "Alex", contextMessages: 1000 }).success).toBe(false);
  });

  it("validates a portable versioned backup", () => {
    const parsed = backupSchema.safeParse({ version: 1, characters: [], conversations: [], messages: [], memories: [] });
    expect(parsed.success).toBe(true);
  });

  it("preserves generated reply variants in backups", () => {
    const parsed = backupSchema.parse({
      version: 1, characters: [], conversations: [], memories: [],
      messages: [{ conversationId: "conversation", role: "assistant", content: "Second", variants: ["First", "Second"], selectedVariant: 1 }],
    });
    expect(parsed.messages[0].variants).toEqual(["First", "Second"]);
    expect(parsed.messages[0].selectedVariant).toBe(1);
  });
});

describe("message updates", () => {
  it("accepts either inline edits or response-option selection", () => {
    expect(messageUpdateSchema.safeParse({ content: "Edited in place" }).success).toBe(true);
    expect(messageUpdateSchema.safeParse({ variantIndex: 2 }).success).toBe(true);
    expect(messageUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a continuation request without message content", () => {
    const parsed = chatSchema.parse({ conversationId: crypto.randomUUID(), action: "continue" });
    expect(parsed.action).toBe("continue");
    expect(parsed.content).toBe("");
  });
});
