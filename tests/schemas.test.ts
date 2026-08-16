import { describe, expect, it } from "vitest";
import { backupSchema, characterSchema, generateCharacterSchema, settingsSchema } from "@/lib/schemas";

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
    const settings = settingsSchema.parse({ ownerName: "Alex", model: "deepseek-v4-pro", temperature: 1.1, maxTokens: 2400 });
    expect(settings.model).toBe("deepseek-v4-pro");
    expect(settings.contextMessages).toBe(30);
  });

  it("rejects unsafe model identifiers and oversized context controls", () => {
    expect(settingsSchema.safeParse({ ownerName: "Alex", model: "https://evil.test/model" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ownerName: "Alex", contextMessages: 1000 }).success).toBe(false);
  });

  it("validates a portable versioned backup", () => {
    const parsed = backupSchema.safeParse({ version: 1, characters: [], conversations: [], messages: [], memories: [] });
    expect(parsed.success).toBe(true);
  });
});
