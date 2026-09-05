import { describe, expect, it } from "vitest";
import { lengthAwareWriterRules, responseLengthBudget, responseLengthInstruction, responseLengthPlan, responseLengthReminder } from "@/lib/response-length";
import { buildWriterPrompt, continuityPlacementFor, roleplayPrompt, writerMessages } from "@/lib/prompts";
import { estimateTokens } from "@/lib/context";
import { modelVerbosity } from "@/lib/provider";
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
  visibility: "private", contentMode: "clean", nsfwEnabled: false, saveCount: 0, savedByViewer: false,
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

/**
 * Why Concise still wrote six paragraphs.
 *
 * The first version of Response Length made the preference real — a written
 * directive, a word target and a per-mode output budget — and MiMo went on
 * producing a full scene anyway. Reading the request rather than the code
 * showed three reasons, and every one of them is a property of the REQUEST, so
 * every one of them can be measured here without spending a penny at a
 * provider:
 *
 *   THE PROMPT CONTRADICTED ITSELF. Two general rules told the writer to let a
 *   moment develop rather than compress it, and not to force every reply into
 *   the same short template. Both are stated as requirements, both are about
 *   size, and both were present while Concise was active.
 *
 *   THE DIRECTIVE WAS FAR FROM THE GENERATION POINT. On a caching model the
 *   stable head is deliberately reused, which is exactly what puts it tens of
 *   thousands of tokens before the turn being answered.
 *
 *   THE ENVELOPE PERMITTED IT. 810 tokens is around 600 words, which is six
 *   paragraphs with room to spare, so nothing downstream ever said no either.
 *
 * The live half of this question — what the models actually write — is
 * scripts/response-length-benchmark.mjs, which needs an API key and network
 * egress and therefore cannot run in CI.
 */
describe("nothing in the prompt argues against the chosen length", () => {
  /** The two rules whose wording is about SIZE rather than about craft. */
  function sizeRules(length: Parameters<typeof lengthAwareWriterRules>[0]) {
    return lengthAwareWriterRules(length).join(" ").toLowerCase();
  }

  it("drops the two rules that told Concise to expand", () => {
    const concise = sizeRules("concise");
    expect(concise).not.toContain("instead of compressing it into a summary");
    expect(concise).not.toContain("a major beat can breathe");
    // And says the opposite, as a requirement rather than a preference.
    expect(concise).toContain("keep every reply short");
    expect(concise).toContain("a long reply is wrong even when the scene is a big one");
  });

  it("leaves Natural's rules byte-identical to the pre-preference baseline", () => {
    expect(lengthAwareWriterRules("natural")).toEqual([
      "Respond to every meaningful part of the user's turn. For a substantial emotional, sexual, conflict, or action beat, let the moment develop through specific action, dialogue, sensory detail, subtext, and consequence instead of compressing it into a summary.",
      "Vary response length, paragraph shape, sentence rhythm, and dialogue/action balance with the scene. A sharp exchange can be short; a major beat can breathe. Do not force every reply into the same 2-5 paragraph template.",
    ]);
  });

  it("keeps Detailed's rules pulling the same way its directive does", () => {
    const detailed = sizeRules("detailed");
    expect(detailed).toContain("let the moment develop");
    expect(detailed).toContain("length stays substantial");
  });

  it("puts no contradictory size instruction anywhere in a concise prompt", () => {
    const prompt = roleplayPrompt(character, "", [], [], { ownerName: "Alex", ownerProfile: "", roleplayPreset: "immersive", responseLength: "concise" });
    expect(prompt).not.toContain("Do not force every reply into the same 2-5 paragraph template");
    expect(prompt).not.toContain("instead of compressing it into a summary");
    expect(prompt).toContain("CONCISE (ACTIVE REQUIREMENT)");
  });
});

describe("the length is restated where the writer acts on it", () => {
  const settings = { ownerName: "Alex", ownerProfile: "", roleplayPreset: "immersive" as const };

  it("ends the per-turn continuity block with the reminder", () => {
    const prompt = buildWriterPrompt(character, "", [], [], { ...settings, responseLength: "concise" });
    expect(prompt.continuity.endsWith(responseLengthReminder("concise"))).toBe(true);
    expect(prompt.continuity).toContain("one to two short paragraphs");
  });

  it("places that block immediately before the turn being answered", () => {
    // Tail placement is what a caching model gets, and it is also what puts the
    // reminder within a few tokens of the generation point.
    const prompt = buildWriterPrompt(character, "", [], [], { ...settings, responseLength: "concise" });
    const conversation = [
      { role: "assistant" as const, content: "She waits." },
      { role: "user" as const, content: "I sit down beside her." },
    ];
    const messages = writerMessages(prompt, conversation, "tail");
    expect(messages[messages.length - 2].content).toContain("Reply length for this turn: CONCISE");
    expect(messages[messages.length - 1].content).toBe("I sit down beside her.");
  });

  it("costs almost nothing to say twice", () => {
    // A second directive would be a second thing to keep in step and a real
    // per-turn cost. One line is neither.
    for (const length of ["concise", "detailed"] as const) {
      expect(estimateTokens(responseLengthReminder(length))).toBeLessThan(45);
    }
  });

  it("adds nothing at all on Natural", () => {
    const prompt = buildWriterPrompt(character, "", [], [], { ...settings, responseLength: "natural" });
    expect(responseLengthReminder("natural")).toBe("");
    expect(prompt.continuity).not.toContain("Reply length for this turn");
  });

  it("keeps the reminder in the cache-friendly half of the request", () => {
    // The reminder is in the CHANGING block, which is already re-read every
    // turn, so it cannot cost a cache hit on the stable head.
    const prompt = buildWriterPrompt(character, "", [], [], { ...settings, responseLength: "concise" });
    expect(prompt.head).toContain("CONCISE (ACTIVE REQUIREMENT)");
    expect(prompt.head).not.toContain("Reply length for this turn");
    expect(continuityPlacementFor(true)).toBe("tail");
  });
});

describe("a writer that runs long is told the ceiling rather than the target", () => {
  it("declares MiMo expansive, and says so as model metadata", () => {
    // Declared beside the model, so nothing has to compare a model name at the
    // point where a prompt is built.
    expect(modelVerbosity("openrouter", "mimo-v2.5")).toBe("expansive");
    expect(modelVerbosity("openrouter", "mimo-v2.5-pro")).toBe("expansive");
    expect(modelVerbosity("openrouter", "glm-4.7")).toBe("normal");
    expect(modelVerbosity("deepseek", "deepseek-v4-flash")).toBe("normal");
    // An unknown deployment-configured model gets the cautious default.
    expect(modelVerbosity("deepseek", "something-nobody-measured")).toBe("normal");
  });

  it("adds one hard paragraph limit for such a writer, and only on Concise", () => {
    expect(responseLengthInstruction("concise", "expansive")).toContain("HARD LIMIT: never write more than two paragraphs");
    expect(responseLengthInstruction("concise", "normal")).not.toContain("HARD LIMIT");
    expect(responseLengthInstruction("detailed", "expansive")).toBe(responseLengthInstruction("detailed", "normal"));
    expect(responseLengthInstruction("natural", "expansive")).toBe("");
  });

  it("changes nothing else about the request", () => {
    // Not the budget, not the target, not Natural or Detailed. Verbosity is
    // one sentence of wording, not a second set of behaviour to maintain.
    const expansive = responseLengthPlan("concise", 1800, "expansive");
    const normal = responseLengthPlan("concise", 1800, "normal");
    expect(expansive.maxTokens).toBe(normal.maxTokens);
    expect(expansive.targetWords).toEqual(normal.targetWords);
    expect(expansive.reminder).toBe(normal.reminder);
  });

  it("still promises a finished sentence", () => {
    expect(responseLengthInstruction("concise", "expansive").toLowerCase()).toContain("whole sentence");
  });
});

describe("the concise envelope is tight enough to matter and loose enough to finish", () => {
  it("no longer leaves room for the six-paragraph reply", () => {
    // 810 tokens — the previous ceiling — is roughly 600 words, which is the
    // reply this mode exists to prevent. The ceiling is not the mechanism, but
    // it must not be quietly permitting the failure either.
    const budget = responseLengthBudget("concise", 1800);
    expect(budget).toBeLessThan(700);
    // ~170 words of prose is about 240 tokens; there is still well over twice
    // that, so a reply that lands where it was asked to land finishes.
    expect(budget).toBeGreaterThan(240 * 2);
  });

  it("keeps Natural and Detailed exactly where they were", () => {
    expect(responseLengthBudget("natural", 1800)).toBe(1800);
    expect(responseLengthBudget("detailed", 1800)).toBe(2880);
  });
});
