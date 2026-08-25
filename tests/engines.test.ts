import { describe, expect, it } from "vitest";
import { engineContract, engineContracts, engineDefinitions, enginePrompt } from "@/lib/engines";
import { roleplayPrompt } from "@/lib/prompts";
import type { Character, RoleplayEngineId } from "@/lib/types";

/**
 * Do the engines actually differ, and do they stay in their lane?
 *
 * Before this rework an engine was ONE descriptive sentence competing with
 * fifteen RULES lines that contradicted it, so choosing one barely changed
 * anything. The obvious over-correction is an engine strong enough to replace
 * the creation — Slow Burn that makes every character coy, Direct that makes
 * every conversation sexual, Story Driven that writes purple prose over a quiet
 * moment. Both failures are asserted against here.
 *
 * The differential below is STRUCTURAL: how many of the eight dials two engines
 * disagree on, and how many requirements they do not share. A live behavioural
 * A/B needs provider access, which this environment does not have; what it can
 * establish is that the briefs are materially different rather than differently
 * worded, which is the thing the old engines failed.
 */

const ids: RoleplayEngineId[] = ["immersive", "slow_burn", "cinematic", "raw", "deliberate", "multi_clarity", "kink_aware"];

const character = {
  id: "c", name: "Maya", creationType: "character", title: "Maya", profileType: "single",
  tagline: "", description: "", descriptionRich: [], userRole: "",
  avatarUrl: "", avatarPath: "", accent: "#fff", backstory: "A cartographer.", cast: [],
  lorebook: "", personality: "Blunt, impatient, funny.", scenario: "A quiet evening.",
  greeting: "", greetingRich: [], alternateGreetings: [], alternateGreetingsRich: [],
  exampleDialogue: "", responseDirective: "", boundaries: "", sourceMaterial: "",
  worldIds: [], tags: [], hashtags: [], quickFacts: [], gallery: [],
  publicStats: { messages: null, saves: null, chats: null, rank: null, rankCategory: null },
  visibility: "public", nsfwEnabled: true, saveCount: 0, savedByViewer: false, creator: null, ownedByViewer: true,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
} as unknown as Character;

const dialNames = ["escalation", "pacing", "initiative", "conflict", "proseDensity", "relationshipProgression", "castClarity", "causalDiscipline"] as const;

describe("the engines are understandable", () => {
  it("names an experience rather than an implementation", () => {
    const labels = engineDefinitions().map((engine) => engine.label);
    expect(labels).toEqual(["Balanced", "Slow Burn", "Story Driven", "Direct", "Complex & Strategic", "Group & Cast", "Power & Kink"]);
    // "Multi-Clarity" and "Immersive" were names of ideas. These are names of
    // what a reader gets.
    for (const label of labels) expect(label).not.toMatch(/Afterglow|Clarity|Unbound|Deliberate/);
  });

  it("describes what changes, in one sentence, without jargon", () => {
    for (const engine of engineDefinitions()) {
      expect(engine.description.length).toBeGreaterThan(40);
      expect(engine.description.length).toBeLessThan(190);
      expect(engine.description).not.toContain("preset");
    }
  });

  it("keeps every stored engine id working", () => {
    // A conversation stores the engine it was started with. Renaming an id
    // would silently move every existing story to a different brief.
    for (const id of ids) expect(engineContract(id).id).toBe(id);
    expect(engineContracts()).toHaveLength(ids.length);
  });

  it("falls back to Balanced rather than to nothing", () => {
    expect(engineContract("not-an-engine" as RoleplayEngineId).id).toBe("immersive");
  });
});

describe("the engines differ materially", () => {
  it("sets a different combination of dials for every engine", () => {
    const fingerprints = ids.map((id) => dialNames.map((dial) => engineContract(id).dials[dial]).join("/"));
    expect(new Set(fingerprints).size).toBe(ids.length);
  });

  it("reports how far apart each pair of engines actually is", () => {
    const rows: string[] = [];
    let smallest = 8;
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const a = engineContract(ids[left]);
        const b = engineContract(ids[right]);
        const differing = dialNames.filter((dial) => a.dials[dial] !== b.dials[dial]).length;
        const shared = a.requirements.filter((item) => b.requirements.includes(item)).length;
        smallest = Math.min(smallest, differing);
        rows.push(`${a.label.padEnd(20)} vs ${b.label.padEnd(20)} ${differing}/8 dials differ, ${shared} shared requirements`);
      }
    }
    console.log(`\n${rows.join("\n")}\nclosest pair differs on ${smallest} of 8 dials`);
    // No two engines are a rewording of each other. This is the assertion the
    // old set could not have passed: Immersive, Cinematic and Raw were three
    // sentences describing overlapping moods.
    expect(smallest).toBeGreaterThanOrEqual(2);
  });

  it("gives every engine its own requirements", () => {
    const seen = new Map<string, string>();
    for (const contract of engineContracts()) {
      for (const requirement of contract.requirements) {
        expect(seen.has(requirement), `"${requirement.slice(0, 40)}…" is shared with ${seen.get(requirement)}`).toBe(false);
        seen.set(requirement, contract.label);
      }
    }
  });

  it("changes the writer prompt measurably when the engine changes", () => {
    const prompts = ids.map((id) => roleplayPrompt(character, "", [], [], { ownerName: "You", ownerProfile: "", roleplayPreset: id }));
    expect(new Set(prompts).size).toBe(ids.length);
    // And the difference is instruction, not decoration: each engine block
    // carries eight named dials and its own requirements.
    for (const id of ids) {
      const block = enginePrompt(id);
      for (const dial of ["Escalation", "Pacing", "Initiative", "Conflict", "Prose density", "Relationship progression", "Cast clarity", "Causal and spatial discipline"]) {
        expect(block).toContain(dial);
      }
    }
  });
});

describe("an engine guides the creation, it does not replace it", () => {
  it("says so in every engine's own text", () => {
    for (const id of ids) {
      expect(enginePrompt(id)).toContain("The creation's own personality, voice, history and boundaries always outrank it");
    }
  });

  it("lets every engine leave a scene it has entered", () => {
    // The reported failure: a story that can enter a sexual scene and never
    // come out of it. This belongs to every engine, not to one.
    for (const id of ids) {
      const block = enginePrompt(id);
      expect(block).toContain("A scene that has ended has ended");
      expect(block).toContain("the next morning");
    }
  });

  it("stops Slow Burn from making every character coy", () => {
    const block = enginePrompt("slow_burn");
    expect(block).toContain("Slow is not coy, and it is not passive");
    expect(block).toContain("what changes is how quickly the RELATIONSHIP moves, never who the character is");
    // And it may not be used to refuse a moment the story has arrived at.
    expect(block).toContain("Delaying something already earned is a different failure");
  });

  it("stops Direct from making every conversation sexual", () => {
    const block = enginePrompt("raw");
    expect(block).toContain("Directness is a manner, not a subject");
    expect(block).toContain("does not make a conversation sexual");
  });

  it("stops Story Driven from writing purple prose over a quiet moment", () => {
    const block = enginePrompt("cinematic");
    expect(block).toContain("Density is for what matters");
    expect(block).toContain("ornament in place of substance");
  });

  it("stops Group & Cast from turning a scene into a roll call", () => {
    expect(enginePrompt("multi_clarity")).toContain("Not everyone has to speak");
  });

  it("stops Complex & Strategic from writing analysis instead of a scene", () => {
    expect(enginePrompt("deliberate")).toContain("The reply is a scene, never an analysis");
  });

  it("stops Power & Kink from inventing a dynamic that is not there", () => {
    const block = enginePrompt("kink_aware");
    expect(block).toContain("A dynamic that does not exist between these characters is not introduced by this engine");
    expect(block).toContain("hard stop");
  });

  it("never writes for the user, whichever engine is chosen", () => {
    for (const id of ids) expect(enginePrompt(id)).toContain("Never write the user's dialogue");
  });

  it("leaves adult content to the creation rather than to the engine", () => {
    // No engine turns Adult Mode on. Choosing Direct on an SFW creation must
    // change the manner and nothing else.
    const sfw = roleplayPrompt({ ...character, nsfwEnabled: false } as Character, "", [], [], { ownerName: "You", ownerProfile: "", roleplayPreset: "raw" });
    expect(sfw).toContain("SFW MODE");
    expect(sfw).not.toContain("ADULT MODE:");
  });
});

describe("engine cost", () => {
  it("stays a small share of a real prompt", () => {
    // A contract is longer than a sentence. It must not become a document: an
    // engine that costs more than the creation it is guiding is the wrong shape.
    const withEngine = roleplayPrompt(character, "", [], [], { ownerName: "You", ownerProfile: "", roleplayPreset: "deliberate" });
    const blockChars = enginePrompt("deliberate").length;
    expect(blockChars / withEngine.length).toBeLessThan(0.35);
    expect(blockChars).toBeLessThan(4_200);
  });
});
