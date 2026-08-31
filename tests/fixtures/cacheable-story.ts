import { anchoredFetchLimit, selectAnchoredMessages } from "@/lib/context";
import { buildWriterPrompt, writerMessages } from "@/lib/prompts";
import type { LLMMessage } from "@/lib/llm";
import type { Character, CoreCanonEntry, Memory, MemoryArc, Message, Persona, World } from "@/lib/types";

/**
 * A long story, assembled by the REAL prompt builder.
 *
 * The point of this fixture is that nothing here re-implements how a request is
 * put together. `turnPayload` calls `buildWriterPrompt` and `writerMessages` —
 * the same two functions the chat route calls — over the same anchored
 * transcript window the route selects. A second assembler would be a second
 * thing to keep in step, and the first time the two disagreed the measurement
 * would be the one that lied.
 *
 * What IS synthetic is the story's dynamics: how the summary, the memories and
 * the scene change from turn to turn. Those are modelled deliberately
 * pessimistically — the summary is rewritten every single turn and the recalled
 * memory set rotates — because a cache figure measured against a prompt whose
 * dynamic half never moves would be measuring nothing.
 */

const lorem = (words: number, seed = 0) =>
  Array.from({ length: words }, (_, index) => `lore${(index + seed) % 97}`).join(" ");

export const character = {
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

export const persona = { id: "p", name: "Ivy", description: lorem(45) } as unknown as Persona;

export function world(words: number): World {
  return { id: "w-vale", name: "Vale", description: "A reusable setting", content: lorem(words) } as unknown as World;
}

export const arcs = Array.from({ length: 3 }, (_, index) => ({
  id: `a${index}`, summary: lorem(120, index), storyDayStart: null, storyDayEnd: null, locations: [],
})) as unknown as MemoryArc[];

export const canon = Array.from({ length: 6 }, (_, index) => ({
  content: lorem(28, index), category: "event", importance: 4, tokenCount: 40,
})) as unknown as CoreCanonEntry[];

export const settings = {
  ownerName: "You", ownerProfile: "",
  roleplayPreset: "immersive" as const, responseLength: "natural" as const,
};

/** The conversation's messages, oldest first, for a story of `total` messages. */
export function transcript(total: number): Message[] {
  return Array.from({ length: total }, (_, index) => ({
    id: `t${index}`, conversationId: "c", role: index % 2 === 0 ? "user" : "assistant",
    content: lorem(index % 2 === 0 ? 45 : 180, index), variants: [], selectedVariant: 0,
    memoryIds: [], arcIds: [], createdAt: new Date(index * 1000).toISOString(),
  })) as unknown as Message[];
}

export const contextMessages = 30;
export const contextTokenBudget = 12_000;

/** Exactly the window the chat route would send at this point in the story. */
export function windowFor(total: number) {
  const all = transcript(total);
  const available = all.slice(-anchoredFetchLimit(contextMessages));
  return selectAnchoredMessages(available, total, contextMessages, contextTokenBudget);
}

/**
 * The story's dynamic material at turn `turn`.
 *
 * Rewritten every turn on purpose. A rolling summary that only changed
 * occasionally would flatter the measurement, and the whole question is what
 * survives when the dynamic half moves.
 */
function dynamics(turn: number) {
  return {
    summary: `${lorem(420, turn)} Beat ${turn}.`,
    // Retrieval returns a different set as the scene moves, which is exactly
    // why this block must not sit ahead of the transcript.
    memories: Array.from({ length: 8 }, (_, index) => ({
      id: `m${turn}-${index}`, content: lorem(45, turn + index), kind: "event",
      status: "active", importance: 3, resolution: "", scene: null,
    })) as unknown as Memory[],
  };
}

/**
 * One complete request, exactly as the writer would receive it.
 *
 * `total` is the conversation's length in messages at this turn; `placement` is
 * the layout the model's capabilities select — `tail` for a caching model,
 * `system` for one that gains nothing from the reorder.
 */
export function turnPayload(total: number, turn: number, placement: "system" | "tail", worlds: World[]): LLMMessage[] {
  const { summary, memories } = dynamics(turn);
  const prompt = buildWriterPrompt(character, summary, memories, arcs, settings, {
    worlds, persona, coreCanon: canon, sceneState: null,
    instructionPresets: ["reduce_repetition"], customInstructions: "",
  });
  const conversation = windowFor(total).map((message) => ({ role: message.role, content: message.content }));
  return writerMessages(prompt, conversation, placement) as LLMMessage[];
}
