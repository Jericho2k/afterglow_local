import type { Character, CoreCanonEntry, Memory, MemoryArc, MemoryKind } from "@/lib/types";
import type { SceneStateFields } from "@/lib/scene-state";
import type { EvidenceClaim } from "@/lib/eval/evidence";

/**
 * Adversarial continuity fixtures.
 *
 * Small, hand-authored, and deliberately nasty. Each one is a situation where
 * the archive contains everything needed and the question is whether the
 * retrieval path actually puts it in front of the writer — or whether it puts
 * something obsolete there instead.
 *
 * These are the CI half of the gate. They need no paid inference: the ranker
 * is a pure function, the prompt builder is a pure function, and the evidence
 * locator reads the result. That means every one of these runs on every push,
 * for free, forever.
 *
 * The cases carry a RECORDED expectation rather than an aspirational one. A
 * case that the current implementation fails is marked `known_failure` with a
 * note saying why. CI asserts observed == recorded, so the suite is green
 * today, turns red the moment behaviour drifts, and turns red again — usefully
 * — when a V2.1b fix makes a known failure start passing.
 */

const day = (value: number) => new Date(Date.UTC(2026, 0, value)).toISOString();

export const evalCharacter: Character = {
  id: "character", name: "Maya", creationType: "character", title: "Maya", profileType: "single",
  tagline: "", description: "", descriptionRich: [], userRole: "", avatarUrl: "", avatarPath: "", accent: "#e879a9",
  backstory: "", cast: [], lorebook: "", personality: "", scenario: "An ongoing story.", greeting: "",
  greetingRich: [], alternateGreetings: [], alternateGreetingsRich: [], exampleDialogue: "",
  responseDirective: "", boundaries: "", sourceMaterial: "", worldIds: [], tags: [], hashtags: [],
  quickFacts: [], gallery: [],
  publicStats: { messages: null, saves: null, chats: null, rank: null, rankCategory: null },
  visibility: "private", ownedByViewer: true, nsfwEnabled: false,
  saveCount: 0, savedByViewer: false, creator: null,
  createdAt: day(1), updatedAt: day(1),
};

export function mem(input: {
  id: string; content: string; kind?: MemoryKind; importance?: number;
  keywords?: string[]; pinned?: boolean; status?: Memory["status"]; resolution?: string;
  ageDays?: number; scene?: Memory["scene"];
}): Memory {
  return {
    id: input.id, characterId: "character", conversationId: "chat",
    content: input.content, kind: input.kind ?? "event", importance: input.importance ?? 3,
    keywords: input.keywords ?? [], pinned: input.pinned ?? false,
    status: input.status ?? "active", resolution: input.resolution ?? "",
    resolvedAt: input.status === "resolved" ? day(20) : null,
    lastRecalledAt: null, recallCount: 0, sourceMessageCount: 0,
    scene: input.scene ?? null,
    createdAt: day(Math.max(1, 28 - (input.ageDays ?? 0))),
  };
}

export function arcOf(id: string, summary: string, keywords: string[] = []): MemoryArc {
  return {
    id, conversationId: "chat", summary, keywords,
    startMessageCount: 0, endMessageCount: 0,
    storyDayStart: null, storyDayEnd: null, locations: [],
    createdAt: day(10),
  };
}

export function canonOf(id: string, content: string, category: MemoryKind = "identity", importance = 5): CoreCanonEntry {
  return {
    id, conversationId: "chat", characterId: "character", content, category, importance,
    status: "active", sourceMemoryIds: [], sourceArcIds: [], sourceMessageCount: 0,
    tokenCount: Math.ceil(content.length / 4) + 10, curationVersion: 1,
    createdAt: day(5), updatedAt: day(5),
  };
}

export function sceneOf(fields: Partial<SceneStateFields>): SceneStateFields {
  return {
    storyDay: null, dateKind: "unknown", dateText: "", timeOfDay: "", timeText: "",
    location: { place: "", sub: "", confidence: "unknown" },
    presentCharacters: [], activeSituation: [],
    // Physical geometry defaults to nothing established, which is what every
    // scene written before it existed genuinely holds.
    physical: { actors: [], contacts: [], constraints: [] }, ...fields,
  };
}

export function claim(id: string, description: string, ...anyOf: string[]): EvidenceClaim {
  return { id, description, anyOf };
}

export type ContinuityCase = {
  name: string;
  /** What this case is trying to catch, in one line. */
  intent: string;
  memories: Memory[];
  arcs?: MemoryArc[];
  canon?: CoreCanonEntry[];
  scene?: SceneStateFields | null;
  summary?: string;
  /** The user's latest turn — what retrieval is given as its query. */
  query: string;
  /** Recent transcript, if the case needs a fact to be visible without retrieval. */
  transcript?: string[];
  /**
   * Simulated embedder output, memory/arc id → similarity. Supplied by hand so
   * the case is deterministic and so semantic quality is held constant while
   * the RANKING policy is what gets tested.
   */
  semantic?: Record<string, number>;
  /** Retrieval budgets. Small on purpose where the case is about crowding. */
  limit?: number;
  episodicBudget?: number;
  /** Facts that must reach the writer. */
  required: EvidenceClaim[];
  /** Material that must not be presented as currently authoritative. */
  forbidden?: EvidenceClaim[];
  /** What the implementation does today. `note` explains a known failure. */
  expected: "pass" | "known_failure";
  note?: string;
};

/** Fourteen unrelated open loops, the shape a long story accumulates. */
const staleOpenLoops: Memory[] = Array.from({ length: 14 }, (_, index) => mem({
  id: `loop-${index}`,
  content: `Unresolved thread ${index}: Maya still means to deal with the ${["greenhouse", "letters", "boat", "debt", "recital", "locksmith", "orchard", "ledger", "auction", "chapel", "kiln", "archive", "quarry", "aviary"][index]} sooner or later.`,
  kind: "open_loop",
  importance: 3,
  ageDays: 20 - index,
}));

export const continuityCases: ContinuityCase[] = [
  {
    name: "relevant memory survives a wall of stale open loops",
    intent: "Protected commitments must not consume the episodic budget and displace the fact the turn is actually about.",
    memories: [
      ...staleOpenLoops,
      mem({
        id: "relevant",
        content: "Maya's mother died in the spring, and Maya has never been able to say it out loud.",
        kind: "relationship", importance: 5, keywords: ["mother", "died"], ageDays: 2,
      }),
    ],
    query: "I ask her gently about her mother.",
    semantic: { relevant: 0.93 },
    limit: 8,
    episodicBudget: 900,
    required: [claim("mother", "the fact the question is about", "Maya's mother died in the spring")],
    expected: "pass",
    note: `MEASURED, and it refutes the hypothesis this case was written to confirm.

      The concern was that Memory V2 dropped the protected-tier token ceiling
      V1 had (55% of the episodic budget) and could therefore let commitments
      crowd out the memory a turn is actually about. Swept across protected
      memories from 120 to 3000 characters at the default episodic budget of
      3600 tokens, the relevant memory survived every single time.

      The reason is that hybridRankMemories checks the budget PER ITEM rather
      than reserving space up front: a protected entry that does not fit is
      skipped and the loop continues, so the tier simply shrinks (12 entries at
      120 chars, 8 at 1600, 4 at 3000) and short relevant memories always find
      room. The missing ceiling is a latent risk, not a live defect.

      Kept as a regression guard: if the per-item check is ever replaced by an
      up-front reservation, this case starts failing.`,
  },
  {
    name: "an obsolete fact is not presented alongside its replacement",
    intent: "A superseded fact and its update both being live is what makes the writer average them together.",
    memories: [
      mem({ id: "prague", content: "Maya lives in Prague, in the flat above the bakery.", kind: "identity", importance: 4, keywords: ["Prague", "flat"], ageDays: 25 }),
      mem({ id: "berlin", content: "Maya moved permanently to Berlin and gave up the Prague flat.", kind: "identity", importance: 5, keywords: ["Berlin", "moved"], ageDays: 1 }),
    ],
    query: "So how is the new place treating you?",
    semantic: { berlin: 0.9, prague: 0.72 },
    required: [claim("berlin", "the current fact", "Maya moved permanently to Berlin")],
    forbidden: [claim("prague-live", "the obsolete fact stated as current", "Maya lives in Prague")],
    expected: "known_failure",
  },
  {
    name: "a lie and the truth both survive",
    intent: "Fiction contradicts itself on purpose. Any future supersession pass must not delete a plot point.",
    memories: [
      mem({ id: "lie", content: "Maya told you she has no siblings.", kind: "event", importance: 4, keywords: ["siblings", "told"], ageDays: 12 }),
      mem({ id: "truth", content: "Maya has a younger brother she has not spoken to in nine years.", kind: "identity", importance: 5, keywords: ["brother", "younger"], ageDays: 3 }),
    ],
    query: "I mention her brother and watch her face.",
    semantic: { truth: 0.9, lie: 0.8 },
    required: [
      claim("truth", "the fact", "Maya has a younger brother"),
      claim("lie", "the lie, which is itself a plot point", "Maya told you she has no siblings"),
    ],
    expected: "pass",
  },
  {
    name: "a past scene is tagged with where and when it happened",
    intent: "Scene State's core job: a correctly recalled memory from another day must not read as the current room.",
    memories: [
      mem({
        id: "past", content: "They argued about the inheritance on the couch until neither of them was angry any more.",
        kind: "event", importance: 4, keywords: ["inheritance", "couch"], ageDays: 8,
        scene: { storyDay: 11, timeOfDay: "afternoon", location: "Maya's mother's house — couch", present: ["Maya", "You"] },
      }),
    ],
    scene: sceneOf({
      storyDay: 12, timeOfDay: "late evening",
      location: { place: "Maya's apartment", sub: "kitchen", confidence: "stated" },
      presentCharacters: ["Maya", "You"], activeSituation: ["The kettle has just boiled."],
    }),
    query: "Do you still think about the inheritance?",
    semantic: { past: 0.88 },
    required: [
      claim("now", "the current scene", "Location: Maya's apartment — kitchen"),
      claim("then", "the past scene, tagged", "Day 11", "Maya's mother's house — couch"),
    ],
    expected: "pass",
  },
  {
    name: "a resolved promise carries its resolution",
    intent: "A fulfilled promise must not read as an outstanding one the character still owes.",
    memories: [
      mem({
        id: "promise", content: "Maya promised to show you the letters her mother left.",
        kind: "promise", importance: 4, status: "resolved", resolution: "She showed you the letters on the night of the storm.",
        keywords: ["letters", "promised"], ageDays: 9,
      }),
    ],
    query: "I ask about the letters again.",
    semantic: { promise: 0.9 },
    required: [
      claim("promise", "the promise", "Maya promised to show you the letters"),
      claim("resolution", "and the fact that it was kept", "She showed you the letters on the night of the storm"),
    ],
    expected: "pass",
  },
  {
    name: "core canon carries a foundational fact the summary has lost",
    intent: "Canon exists to survive summary rewrites. This is the test that it does.",
    memories: [mem({ id: "noise", content: "Maya reorganised the spice shelf.", importance: 1, ageDays: 4 })],
    canon: [canonOf("canon-1", "Maya is the last living member of the Vasek line, and the estate passes to her.", "identity", 5)],
    summary: "CURRENT STATE: they are in the kitchen. MAJOR TIMELINE: a quiet week.",
    query: "What happens to the estate now?",
    semantic: { noise: 0.1 },
    required: [claim("canon", "the foundational fact", "Maya is the last living member of the Vasek line")],
    expected: "pass",
  },
  {
    name: "a fact only the transcript carries is reported as latent",
    intent: "A pass that depends on the transcript window is a failure waiting for the window to move.",
    memories: [mem({ id: "unrelated", content: "Maya dislikes being photographed.", importance: 2, ageDays: 6 })],
    transcript: ["You: Your hands are shaking.", "Maya: *She sets the cup down.* I haven't slept since Tuesday."],
    query: "You should rest.",
    semantic: { unrelated: 0.05 },
    required: [claim("sleep", "the fact the reply must honour", "I haven't slept since Tuesday")],
    expected: "pass",
  },
  {
    name: "irrelevant high-importance history stays out of an unrelated scene",
    intent: "Retrieval false positives drag a quiet scene toward whatever the archive found dramatic.",
    memories: [
      mem({ id: "drama", content: "Maya nearly drowned in the quarry when she was eleven.", kind: "event", importance: 5, keywords: ["quarry", "drowned"], ageDays: 15 }),
      mem({ id: "quiet", content: "Maya takes her coffee with too much sugar and is embarrassed about it.", kind: "preference", importance: 2, keywords: ["coffee", "sugar"], ageDays: 5 }),
    ],
    query: "I pour her a coffee.",
    semantic: { quiet: 0.86, drama: 0.08 },
    limit: 1,
    episodicBudget: 400,
    required: [claim("coffee", "the relevant preference", "too much sugar")],
    forbidden: [claim("quarry", "unrelated drama", "nearly drowned in the quarry")],
    expected: "pass",
  },
];
