import { describe, expect, it } from "vitest";
import { analyzePayload, analyzeSystemPrompt, firstDivergentSection, renderBreakdown, sharedPayloadPrefix } from "@/lib/prompt-metrics";
import { anchoredFetchLimit, selectAnchoredMessages } from "@/lib/context";
import { buildWriterPrompt, roleplayPrompt, writerMessages } from "@/lib/prompts";
import type { LLMMessage } from "@/lib/llm";
import type { Character, CoreCanonEntry, Memory, MemoryArc, Message, Persona, World } from "@/lib/types";

/**
 * What a reply costs, and which part of it a provider can reuse.
 *
 * These are measurements, not assertions about taste. They run on the real
 * prompt builder and the real transcript window, so the numbers in the sprint
 * report are the numbers this file prints.
 */

const lorem = (words: number) => Array.from({ length: words }, (_, index) => `lore${index % 97}`).join(" ");

const character = {
  id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Maya", creationType: "character",
  title: "Maya Vance", profileType: "single", tagline: "A cartographer who lost her map",
  description: lorem(60), descriptionRich: [], userRole: "You are the rival she never names.",
  avatarUrl: "", avatarPath: "", accent: "#e879a9",
  backstory: lorem(240), cast: [
    { id: "1", name: "Kel", role: "her brother", description: lorem(60) },
    { id: "2", name: "Ferro", role: "the archivist", description: lorem(60) },
  ],
  lorebook: "", personality: lorem(140), scenario: lorem(90),
  greeting: lorem(80), greetingRich: [], alternateGreetings: [], alternateGreetingsRich: [],
  exampleDialogue: lorem(120), responseDirective: lorem(50), boundaries: lorem(40),
  sourceMaterial: "", worldIds: [], tags: [], hashtags: [], quickFacts: [], gallery: [],
  publicStats: { messages: null, saves: null, chats: null, rank: null, rankCategory: null },
  visibility: "public", nsfwEnabled: true, saveCount: 0, savedByViewer: false, creator: null, ownedByViewer: true,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
} as unknown as Character;

const persona = { id: "p", name: "Ivy", description: lorem(45) } as unknown as Persona;

function world(name: string, words: number): World {
  return { id: `w-${name}`, name, description: "A reusable setting", content: lorem(words) } as unknown as World;
}

const memories = Array.from({ length: 8 }, (_, index) => ({
  id: `m${index}`, content: lorem(45), kind: "event", status: "active", importance: 3, resolution: "", scene: null,
})) as unknown as Memory[];
const arcs = Array.from({ length: 3 }, (_, index) => ({
  id: `a${index}`, summary: lorem(120), storyDayStart: null, storyDayEnd: null, locations: [],
})) as unknown as MemoryArc[];
const canon = Array.from({ length: 6 }, () => ({
  content: lorem(28), category: "event", importance: 4, tokenCount: 40,
})) as unknown as CoreCanonEntry[];
const summary = lorem(420);

function transcript(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index}`, conversationId: "c", role: index % 2 === 0 ? "user" : "assistant",
    content: lorem(index % 2 === 0 ? 45 : 180), variants: [], selectedVariant: 0,
    memoryIds: [], arcIds: [], createdAt: new Date(index * 1000).toISOString(),
  })) as unknown as Message[];
}

const settings = { ownerName: "You", ownerProfile: "", roleplayPreset: "immersive" as const, responseLength: "natural" as const };

function payload(worlds: World[], history: Message[]): LLMMessage[] {
  const system = roleplayPrompt(character, summary, memories, arcs, settings, {
    worlds, persona, coreCanon: canon, sceneState: null, instructionPresets: ["reduce_repetition"], customInstructions: "",
  });
  return [{ role: "system", content: system }, ...history.map((message) => ({ role: message.role, content: message.content }))];
}

const contextMessages = 30;
const contextTokenBudget = 12000;

/** The window the chat route would actually send for a conversation of `total`. */
function windowFor(total: number) {
  const all = transcript(total);
  const available = all.slice(-anchoredFetchLimit(contextMessages));
  return selectAnchoredMessages(available, total, contextMessages, contextTokenBudget);
}

describe("prompt cost by section", () => {
  const cases: Array<[string, World[]]> = [
    ["NO WORLD", []],
    ["SMALL WORLD (~2k chars)", [world("Vale", 320)]],
    ["VERY LARGE WORLD (~100k chars)", [world("Vale", 16_500)]],
  ];

  it("reports a complete breakdown for each World size", () => {
    const lines: string[] = [];
    for (const [label, worlds] of cases) {
      const messages = payload(worlds, windowFor(60));
      const analysis = analyzePayload(messages);
      lines.push(renderBreakdown(label, analysis.system.sections, analysis.tokens));
      lines.push(`${"Transcript".padEnd(24)}  ${String(analysis.transcript.tokens).padStart(7)}  ${((analysis.transcript.tokens / analysis.tokens) * 100).toFixed(1).padStart(5)}%`);
      lines.push("");
      // The partition holds, which is what makes the percentages meaningful.
      expect(analysis.system.sections.reduce((sum, s) => sum + s.chars, 0)).toBe(analysis.system.chars);
    }
    console.log(`\n${lines.join("\n")}`);

    const withoutWorld = analyzePayload(payload([], windowFor(60))).tokens;
    const withLargeWorld = analyzePayload(payload([world("Vale", 16_500)], windowFor(60))).tokens;
    // The measurement this sprint exists to establish: a large World is not a
    // rounding error on a prompt, it is the majority of one.
    expect(withLargeWorld).toBeGreaterThan(withoutWorld * 3);
  });

  it("attributes World lore to the World section rather than to the creation", () => {
    const small = analyzeSystemPrompt(payload([world("Vale", 320)], [])[0].content);
    const large = analyzeSystemPrompt(payload([world("Vale", 16_500)], [])[0].content);
    const worldTokens = (sections: typeof small.sections) => sections.find((s) => s.id === "world")?.tokens ?? 0;
    const creationTokens = (sections: typeof small.sections) => sections.find((s) => s.id === "creation")?.tokens ?? 0;
    expect(worldTokens(large.sections)).toBeGreaterThan(worldTokens(small.sections) * 10);
    expect(creationTokens(large.sections)).toBe(creationTokens(small.sections));
  });
});

describe("prefix cache stability", () => {
  it("names the section where two consecutive turns first diverge", () => {
    const worlds = [world("Vale", 2_000)];
    // Turn N and turn N+1 of the same conversation: two more messages, and a
    // continuity block that moved on, exactly as a real turn does.
    const before = payload(worlds, windowFor(60));
    const after = (() => {
      const system = roleplayPrompt(character, `${summary} And then the storm broke.`, memories, arcs, settings, {
        worlds, persona, coreCanon: canon, sceneState: null, instructionPresets: ["reduce_repetition"], customInstructions: "",
      });
      return [{ role: "system" as const, content: system }, ...windowFor(62).map((m) => ({ role: m.role, content: m.content }))];
    })();

    const shared = sharedPayloadPrefix(before, after);
    const divergesAt = firstDivergentSection(before, after);
    console.log(`\nPrefix reuse turn N → N+1: ${(shared.ratio * 100).toFixed(1)}% of ${shared.previousChars.toLocaleString()} chars; first divergence in "${divergesAt}"`);
    // Today the rolling summary lives inside the system message, ahead of the
    // transcript, so the transcript cannot be reused however stable it is.
    expect(divergesAt).not.toBe("transcript");
  });

  it("keeps the transcript window append-only between anchor steps", () => {
    // Two turns inside one anchor step: the window may only grow at the end.
    const before = windowFor(56);
    const after = windowFor(58);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length).map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it("moves the anchor exactly once per step rather than once per turn", () => {
    // The transcript alone — no system message — so this measures the window
    // and nothing else. Starts must take only `anchorStep`-sized jumps.
    const starts = Array.from({ length: 16 }, (_, index) => windowFor(50 + index)[0].id);
    const distinct = [...new Set(starts)];
    expect(distinct.length).toBeLessThanOrEqual(3);
  });
});

describe("moving the changing half changes what can be reused", () => {
  const worlds = [world("Vale", 2_000)];

  /** One turn's complete request, in either layout. */
  function turn(total: number, summary: string, placement: "system" | "tail"): LLMMessage[] {
    const prompt = buildWriterPrompt(character, summary, memories, arcs, settings, {
      worlds, persona, coreCanon: canon, sceneState: null, instructionPresets: ["reduce_repetition"], customInstructions: "",
    });
    return writerMessages(prompt, windowFor(total).map((message) => ({ role: message.role, content: message.content })), placement) as LLMMessage[];
  }

  it("measures prefix reuse in both layouts", () => {
    const rows: string[] = [];
    const results: Record<string, number> = {};
    const divergence: Record<string, string> = {};
    for (const placement of ["system", "tail"] as const) {
      const before = turn(56, summary, placement);
      const after = turn(58, `${summary} And then the storm broke.`, placement);
      const shared = sharedPayloadPrefix(before, after);
      results[placement] = shared.ratio;
      divergence[placement] = firstDivergentSection(before, after);
      rows.push(`${placement.padEnd(7)} reuse ${(shared.ratio * 100).toFixed(1).padStart(5)}%  first divergence: ${divergence[placement]}`);
    }
    console.log(`\n${rows.join("\n")}`);

    // The measurement the reorder exists for, and the property that matters
    // more than the percentage: with the changing half inside the system
    // message the request stops being reusable at the ROLLING SUMMARY, tens of
    // thousands of tokens early, stranding the whole transcript behind it. With
    // it at the tail the request stops being reusable where genuinely new
    // content begins — the turns that were actually added. The residue is the
    // new content itself, which no layout can make reusable.
    expect(divergence.system).toBe("summary");
    expect(divergence.tail).toBe("transcript");
    expect(results.tail).toBeGreaterThan(results.system);
  });

  it("says exactly the same things in either layout", () => {
    // The reorder must move words, never change them. Anything that appears in
    // one layout appears in the other, exactly once.
    const asSystem = turn(56, summary, "system").filter((message) => message.role === "system").map((m) => m.content).join("\n\n");
    const asTail = turn(56, summary, "tail").filter((message) => message.role === "system").map((m) => m.content).join("\n\n");
    expect(asTail).toBe(asSystem);
  });

  it("never puts anything after the turn being answered", () => {
    // Models weight the final message heavily. Continuity goes before it, not
    // after it, or the reply would be a reply to the wrong thing.
    const messages = turn(56, summary, "tail");
    const conversation = windowFor(56);
    expect(messages.at(-1)!.content).toBe(conversation.at(-1)!.content);
    expect(messages.at(-2)!.role).toBe("system");
  });
});
