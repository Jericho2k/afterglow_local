import { describe, expect, it } from "vitest";
import { roleplayPrompt } from "@/lib/prompts";
import type { Character } from "@/lib/types";

const character: Character = {
  id: "1", name: "Mara", tagline: "Art thief", avatarUrl: "", accent: "#e879a9",
  backstory: "Mara is 31.", personality: "Dry wit.", scenario: "Paris.", greeting: "Hello.",
  exampleDialogue: "A sample.", responseDirective: "Be vivid.", boundaries: "Respect stop words.",
  nsfwEnabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

describe("roleplay prompt", () => {
  it("includes continuity and adult-only safety boundaries", () => {
    const prompt = roleplayPrompt(character, "They made a promise.", []);
    expect(prompt).toContain("They made a promise.");
    expect(prompt).toContain("fictional adults aged 18 or older");
    expect(prompt).toContain("Never write the user's dialogue");
  });
});
