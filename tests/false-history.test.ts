import { describe, expect, it } from "vitest";
import { buildWriterPrompt, continuityPlacementFor, roleplayPrompt, writerMessages } from "@/lib/prompts";
import { attributionOf, categoryLabels } from "@/lib/eval/taxonomy";
import { evalCharacter, mem } from "./fixtures/continuity-cases";

/**
 * New fiction yes, invented history no.
 *
 * The failure being guarded against is a specific one: the character asserts a
 * shared past that never happened — a prior kiss, a promise made, a milestone,
 * a place they have supposedly been together — and then reasons from it. It is
 * not a retrieval failure, because no ranker can supply a fact that was never
 * true, and it is not fixed by making the character cautious: a passive
 * character is a worse product than an occasionally over-confident one.
 *
 * These are prompt-shape assertions rather than prose judgements. Whether a
 * given generation invents a past is what the replay judge answers; whether the
 * writer was ever TOLD not to is what a pure test can answer, and it is the
 * part that silently regresses when the prompt is edited.
 */

const character = { ...evalCharacter, name: "Maya" };
const memories = [mem({ id: "m1", content: "Maya is a locksmith in Prague.", kind: "identity", importance: 4 })];

function prompt() {
  return roleplayPrompt(character, "They have spoken twice.", memories, [], { ownerName: "You", ownerProfile: "", roleplayPreset: "immersive" });
}

describe("the grounding rule reaches the writer", () => {
  it("names the shared-past claims that must be established rather than invented", () => {
    const text = prompt().toLowerCase();
    for (const claim of ["kiss", "promise", "milestone", "confession"]) {
      expect(text).toContain(claim);
    }
    expect(text).toContain("invent forward, never backward");
  });

  it("tells the writer to act now rather than to hold back", () => {
    const text = prompt();
    // The rule must not read as "be careful"; it must read as "do it now".
    expect(text).toContain("do the thing NOW instead of remembering it");
    expect(text).toContain("Uncertainty is not a reason to be passive");
  });

  it("keeps the reminder at the generation point under tail placement", () => {
    const built = buildWriterPrompt(character, "", memories, [], { ownerName: "You", ownerProfile: "", roleplayPreset: "immersive" });
    expect(built.continuity).toContain("has NOT happened yet");
    // Under tail placement the continuity block is the last thing before the
    // reader's own message, which is the whole point of putting it there.
    const messages = writerMessages(built, [
      { role: "user", content: "I sit down opposite her." },
      { role: "assistant", content: "She looks up." },
      { role: "user", content: "Do you remember last summer?" },
    ], "tail");
    expect(messages.at(-2)?.content).toContain("has NOT happened yet");
    expect(messages.at(-1)?.content).toBe("Do you remember last summer?");
  });

  it("is present under system placement too, so a non-caching model is not left without it", () => {
    const built = buildWriterPrompt(character, "", memories, [], { ownerName: "You", ownerProfile: "", roleplayPreset: "immersive" });
    const messages = writerMessages(built, [{ role: "user", content: "Hello." }], "system");
    expect(messages[0].content).toContain("has NOT happened yet");
    expect(messages[0].content).toContain("Invent forward, never backward");
    expect(continuityPlacementFor(false)).toBe("system");
  });

  it("does not forbid new fiction or new action", () => {
    const text = prompt();
    // The existing forward-motion rules must survive: a rule against inventing
    // a past is worthless if it also stops the character from doing anything.
    expect(text).toContain("Advance the scene through character action");
    expect(text).toContain("Do not wait passively for instructions");
    expect(text).toContain("New events, actions, places, feelings and complications are yours to create freely");
  });
});

describe("the failure taxonomy can name it", () => {
  it("attributes invented history to the writer, not to retrieval", () => {
    expect(attributionOf("invented_history")).toBe("writer");
    expect(categoryLabels.invented_history).toBe("Invented past history");
  });
});
