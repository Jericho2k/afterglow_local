import { describe, expect, it } from "vitest";
import { activeInstructionCount, hasCustomInstruction, instructionChoices, instructionSummary } from "@/lib/chat-instructions";
import { roleplayPrompt } from "@/lib/prompts";
import type { Character, ChatInstructionPreset } from "@/lib/types";

/**
 * The count, and what it counts.
 *
 * The reported bug was "two presets plus custom text still says 2". The cause
 * was not a stale render: the composer's counter summed only the presets while
 * the strip above it summed presets plus custom text, so one conversation
 * reported two different numbers depending on which label you read. There is
 * one definition now, and it is this one — a requirement is active when the
 * WRITER receives it.
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
  visibility: "private", contentMode: "clean", nsfwEnabled: false, saveCount: 0, savedByViewer: false,
  creator: null, ownedByViewer: true,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};

function promptFor(instructionPresets: ChatInstructionPreset[], customInstructions: string) {
  return roleplayPrompt(character, "", [], [], { ownerName: "Alex", ownerProfile: "", roleplayPreset: "immersive" }, {
    instructionPresets, customInstructions,
  });
}

/** Only the bullets inside the chat-instructions block, not the RULES below it. */
function requirementsIn(prompt: string) {
  const start = prompt.indexOf("CHAT-SPECIFIC INSTRUCTIONS");
  const end = prompt.indexOf("These instructions are active requirements", start);
  return prompt.slice(start, end).split("\n").filter((line) => line.startsWith("- "));
}

describe("the active instruction count", () => {
  it("counts two presets plus custom text as three", () => {
    const state = {
      instructionPresets: ["reduce_repetition", "stay_focused"] as ChatInstructionPreset[],
      customInstructions: "Never mention the weather.",
    };
    expect(activeInstructionCount(state)).toBe(3);
    expect(instructionSummary(state)).toBe("3 active");
  });

  it("counts the same two presets as two once the custom text is cleared", () => {
    const presets = ["reduce_repetition", "stay_focused"] as ChatInstructionPreset[];
    expect(activeInstructionCount({ instructionPresets: presets, customInstructions: "" })).toBe(2);
    // Whitespace is not an instruction, so it is not a requirement either.
    expect(activeInstructionCount({ instructionPresets: presets, customInstructions: "   \n " })).toBe(2);
    expect(hasCustomInstruction("   ")).toBe(false);
  });

  it("handles a conversation with nothing set", () => {
    expect(activeInstructionCount(null)).toBe(0);
    expect(activeInstructionCount({ instructionPresets: [], customInstructions: "" })).toBe(0);
    expect(instructionSummary(undefined)).toBe("None active");
  });

  it("cannot drift from the presets the panel offers", () => {
    // A preset added to the list is one the counter already knows about,
    // because both read the same array.
    const everyPreset = instructionChoices.map((choice) => choice.id);
    expect(activeInstructionCount({ instructionPresets: everyPreset, customInstructions: "x" }))
      .toBe(everyPreset.length + 1);
  });
});

describe("what the writer receives", () => {
  it("carries each active requirement exactly once", () => {
    const prompt = promptFor(["reduce_repetition", "stay_focused"], "Never mention the weather.");
    expect(prompt.split("Never mention the weather.").length - 1).toBe(1);
    expect(prompt.split("Actively avoid repeating recent material.").length - 1).toBe(1);
    // The count is not a label over the prompt — it describes it.
    expect(requirementsIn(prompt)).toHaveLength(3);
  });

  it("stops sending a cleared custom instruction", () => {
    expect(promptFor(["stay_focused"], "")).not.toContain("Never mention the weather.");
    expect(requirementsIn(promptFor(["stay_focused"], ""))).toHaveLength(1);
  });

  it("says so plainly when a conversation has none", () => {
    expect(promptFor([], "")).toContain("No additional conversation instructions.");
  });
});
