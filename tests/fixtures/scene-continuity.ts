import type { Character, Memory, MemoryArc } from "@/lib/types";
import type { SceneStateFields } from "@/lib/scene-state";

/**
 * A small synthetic continuity benchmark.
 *
 * Each case is a situation where a correctly retrieved memory has historically
 * been able to contaminate the current scene: the same furniture in another
 * house, the same character in another city, yesterday against today. The
 * suite renders the writer prompt with Scene State off and on and asserts that
 * the grounding the writer needs is present in one and absent in the other.
 *
 * It deliberately checks what reaches the writer rather than judging prose:
 * the repository has no LLM-as-judge infrastructure, and the failure this
 * feature exists to fix is a missing distinction in the prompt.
 */

export const benchmarkCharacter: Character = {
  id: "character", name: "Uki", creationType: "character", title: "Uki", profileType: "single", tagline: "",
  description: "", descriptionRich: [], greetingRich: [], alternateGreetingsRich: [], userRole: "", avatarUrl: "", avatarPath: "", accent: "#e879a9",
  backstory: "", cast: [], lorebook: "", personality: "", scenario: "A quiet evening together.", greeting: "", alternateGreetings: [],
  exampleDialogue: "", responseDirective: "", boundaries: "", sourceMaterial: "", worldIds: [], tags: [], hashtags: [],
  quickFacts: [], gallery: [],
  publicStats: { messages: null, saves: null, chats: null, rank: null, rankCategory: null },
  visibility: "private", ownedByViewer: true, nsfwEnabled: false,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

export const scenarioCreation: Character = {
  ...benchmarkCharacter,
  id: "scenario", name: "The Long Night", creationType: "scenario", title: "The Long Night",
  profileType: "ensemble", userRole: "A courier with no clearance.", scenario: "A blockade city after curfew.",
};

export function memory(content: string, scene: Memory["scene"] = null, extra: Partial<Memory> = {}): Memory {
  return {
    id: content.slice(0, 12), characterId: "character", conversationId: "chat", content,
    kind: "event", importance: 4, keywords: [], pinned: false, status: "active", resolution: "",
    resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 0, scene,
    createdAt: new Date().toISOString(), ...extra,
  };
}

export function arc(summary: string, extra: Partial<MemoryArc> = {}): MemoryArc {
  return {
    id: summary.slice(0, 12), conversationId: "chat", summary, keywords: [],
    startMessageCount: 0, endMessageCount: 0, createdAt: new Date().toISOString(), ...extra,
  };
}

export function scene(fields: Partial<SceneStateFields> = {}): SceneStateFields {
  return {
    storyDay: 1, dateKind: "unknown", dateText: "", timeOfDay: "", timeText: "",
    location: { place: "", sub: "", confidence: "unknown" },
    presentCharacters: [], activeSituation: [], ...fields,
  };
}

export type BenchmarkCase = {
  name: string;
  character?: Character;
  sceneState: SceneStateFields;
  memories: Memory[];
  arcs?: MemoryArc[];
  /** Grounding that must reach the writer once Scene State is on. */
  grounded: string[];
};

export const continuityBenchmark: BenchmarkCase[] = [
  {
    name: "same furniture, different houses",
    sceneState: scene({ storyDay: 12, timeOfDay: "late evening", location: { place: "Uki's apartment", sub: "couch", confidence: "stated" }, presentCharacters: ["Uki", "Alex"] }),
    memories: [memory("Uki told Alex about the inheritance.", { storyDay: 11, timeOfDay: "afternoon", location: "Uki's mother's house — couch", present: ["Uki", "Alex"] })],
    grounded: ["Uki's apartment — couch", "Uki's mother's house — couch", "Day 11", "Story day: 12"],
  },
  {
    name: "same character, different locations",
    sceneState: scene({ storyDay: 6, location: { place: "the university library", sub: "third floor", confidence: "stated" }, presentCharacters: ["Maya", "Alex"] }),
    memories: [memory("Maya admitted she had hidden the letter.", { storyDay: 4, timeOfDay: "afternoon", location: "university courtyard", present: ["Maya", "Alex"] })],
    grounded: ["the university library — third floor", "university courtyard"],
  },
  {
    name: "yesterday against today",
    sceneState: scene({ storyDay: 8, timeOfDay: "morning", location: { place: "the bakery", sub: "", confidence: "stated" }, presentCharacters: ["Alex"] }),
    memories: [memory("They argued about the move.", { storyDay: 7, timeOfDay: "night", location: "the bakery", present: ["Maya", "Alex"] })],
    grounded: ["Story day: 8", "Day 7", "night", "morning"],
  },
  {
    name: "next morning",
    sceneState: scene({ storyDay: 3, timeOfDay: "morning", location: { place: "Maya's apartment", sub: "kitchen", confidence: "stated" }, presentCharacters: ["Maya", "Alex"] }),
    memories: [memory("Maya fell asleep before the film ended.", { storyDay: 2, timeOfDay: "late evening", location: "Maya's apartment — living room", present: ["Maya", "Alex"] })],
    grounded: ["Maya's apartment — kitchen", "Maya's apartment — living room"],
  },
  {
    name: "several-day time skip",
    sceneState: scene({ storyDay: 15, timeOfDay: "afternoon", location: { place: "the coast road", sub: "", confidence: "inferred" }, presentCharacters: ["Alex"] }),
    memories: [memory("Alex promised to call Maya once he arrived.", { storyDay: 12, timeOfDay: "evening", location: "the station", present: ["Maya", "Alex"] }, { kind: "promise" })],
    grounded: ["Story day: 15", "Day 12", "the coast road"],
  },
  {
    name: "planned activity interrupted",
    sceneState: scene({
      storyDay: 12, timeOfDay: "late evening", location: { place: "Maya's apartment", sub: "bedroom", confidence: "stated" },
      presentCharacters: ["Maya", "Alex"],
      activeSituation: ["They returned from the party.", "Maya is struggling to stay awake.", "The film they planned has not been started."],
    }),
    memories: [memory("Maya and Alex kissed for the first time.", { storyDay: 11, timeOfDay: "night", location: "the rooftop party", present: ["Maya", "Alex"] })],
    grounded: ["Active situation", "The film they planned has not been started.", "the rooftop party"],
  },
  {
    name: "character leaves then returns",
    sceneState: scene({ storyDay: 5, location: { place: "the workshop", sub: "", confidence: "stated" }, presentCharacters: ["Sera", "Alex"] }),
    memories: [memory("Sera walked out after the argument.", { storyDay: 5, timeOfDay: "afternoon", location: "the workshop", present: ["Alex"] })],
    grounded: ["Present: Sera, Alex"],
  },
  {
    name: "flashback retrieved during a current scene",
    sceneState: scene({ storyDay: 30, timeOfDay: "night", location: { place: "the hospital", sub: "waiting room", confidence: "stated" }, presentCharacters: ["Alex"] }),
    memories: [memory("Alex swore he would never go back to the hospital.", { storyDay: 3, timeOfDay: "morning", location: "the old flat", present: ["Alex", "Maya"] }, { kind: "promise" })],
    arcs: [arc("The first hospital visit and everything it cost them.", { storyDayStart: 2, storyDayEnd: 4, locations: ["the old flat", "the hospital"] })],
    grounded: ["Story day: 30", "Days 2–4", "the hospital — waiting room"],
  },
  {
    name: "multiple cast members",
    sceneState: scene({ storyDay: 9, timeOfDay: "evening", location: { place: "the safehouse", sub: "kitchen", confidence: "stated" }, presentCharacters: ["Sera", "Kit", "Alex"] }),
    memories: [memory("Kit refused to hand over the ledger.", { storyDay: 6, timeOfDay: "night", location: "the docks", present: ["Kit", "Sera"] })],
    grounded: ["Present: Sera, Kit, Alex", "the docks"],
  },
  {
    name: "scenario narrator with contextual NPCs",
    character: scenarioCreation,
    sceneState: scene({ storyDay: 2, timeOfDay: "night", location: { place: "the checkpoint", sub: "east gate", confidence: "stated" }, presentCharacters: ["a conscript sergeant", "two customs officers", "Alex"] }),
    memories: [memory("The sergeant let a courier through without a stamp.", { storyDay: 1, timeOfDay: "evening", location: "the checkpoint — west gate", present: ["a conscript sergeant"] })],
    grounded: ["the checkpoint — east gate", "the checkpoint — west gate", "a conscript sergeant"],
  },
];
