import { describe, expect, it } from "vitest";
import { responseLengthBudget, responseLengthInstruction, responseLengthPlan } from "@/lib/response-length";
import { roleplayPrompt } from "@/lib/prompts";
import { responseLengths, type Character } from "@/lib/types";

/**
 * Response Length has to be real.
 *
 * The complaint that started this work was that Concise did nothing, and the
 * reason was that it only ever changed prose. So these tests check the two
 * halves that make it observable: the directive that reaches the writer, and
 * the output budget that reaches the provider. A test that only compared two
 * strings would have passed against the broken implementation too.
 */

const character: Character = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Mara", creationType: "character", title: "Mara", profileType: "single",
  tagline: "", description: "", descriptionRich: [], userRole: "",
  avatarUrl: "", avatarPath: "", accent: "#e879a9",
  backstory: "", cast: [], lorebook: "", personality: "", scenario: "",
  greeting: "", greetingRich: [], alternateGreetings: [], alternateGreetingsRich: [],
  exampleDialogue: "", responseDirective: "", boundaries: "", sourceMaterial: "",
  worldIds: [], tags: [], hashtags: [], quickFacts: [], gallery: [],
  publicStats: { messages: null, saves: null, chats: null, rank: null, rankCategory: null },
  visibility: "private", nsfwEnabled: false, saveCount: 0, savedByViewer: false,
  creator: null, ownedByViewer: true,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};

describe("response length", () => {
  it("gives each mode a different output budget from one account baseline", () => {
    const base = 1800;
    const concise = responseLengthBudget("concise", base);
    const natural = responseLengthBudget("natural", base);
    const detailed = responseLengthBudget("detailed", base);

    expect(concise).toBeLessThan(natural);
    expect(natural).toBeLessThan(detailed);
    // Natural must remain byte-for-byte the behaviour every existing
    // conversation is calibrated to: same budget, same prompt.
    expect(natural).toBe(base);
    expect(responseLengthInstruction("natural")).toBe("");
  });

  it("keeps every ceiling far above the words its own directive asks for", () => {
    // The budget is an envelope, not a target. ~1.4 tokens per word of prose
    // is a generous estimate; even at that rate each mode has multiples of
    // headroom, so a reply that lands where it was asked to land finishes.
    for (const length of responseLengths) {
      const plan = responseLengthPlan(length, 1800);
      if (!plan.targetWords) continue;
      const tokensForTarget = plan.targetWords.high * 1.4;
      expect(plan.maxTokens).toBeGreaterThan(tokensForTarget * 2);
    }
  });

  it("scales with the deployment ceiling instead of hard-coding numbers", () => {
    expect(responseLengthBudget("concise", 4000)).toBeGreaterThan(responseLengthBudget("concise", 1800));
    expect(responseLengthBudget("detailed", 4000)).toBeGreaterThan(responseLengthBudget("detailed", 1800));
    // And never collapses to something that could truncate a paragraph.
    expect(responseLengthBudget("concise", 200)).toBeGreaterThanOrEqual(420);
    // Nor runs away when an operator sets something extreme.
    expect(responseLengthBudget("detailed", 99_000)).toBeLessThanOrEqual(6000);
  });

  it("reaches the writer as a distinct instruction for each choice", () => {
    const prompts = responseLengths.map((responseLength) =>
      roleplayPrompt(character, "", [], [], { ownerName: "Alex", ownerProfile: "", roleplayPreset: "immersive", responseLength }));
    const [concise, natural, detailed] = [prompts[0], prompts[1], prompts[2]];

    expect(concise).toContain("CONCISE (ACTIVE REQUIREMENT)");
    expect(detailed).toContain("DETAILED (ACTIVE REQUIREMENT)");
    expect(natural).not.toContain("ACTIVE REQUIREMENT");
    expect(new Set(prompts).size).toBe(3);
  });

  it("never instructs the writer to stop mid-sentence", () => {
    for (const length of responseLengths) {
      const instruction = responseLengthInstruction(length);
      if (!instruction) continue;
      expect(instruction.toLowerCase()).toContain("whole sentence");
      expect(instruction.toLowerCase()).not.toContain("cut off");
    }
  });
});
