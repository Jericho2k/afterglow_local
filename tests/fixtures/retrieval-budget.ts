import type { Memory } from "@/lib/types";
import type { StoryPosition } from "@/lib/memory-scoring";

/**
 * ONE ARCHIVE, DELIBERATELY HOSTILE, FOR ANSWERING "HOW BIG SHOULD THE MEMORY
 * BUDGET BE".
 *
 * The temptation is to raise the budget because models support 200K contexts.
 * That is the wrong reason twice over. Continuity sits in the DYNAMIC section of
 * the writer prompt — it changes whenever retrieval changes — so every extra
 * memory token is plausibly a cache MISS on every writer turn, at fresh-input
 * rates, forever. And a bigger budget does not only add the evidence a turn
 * needs; it adds everything ranked just below it, which is where the noise, the
 * near-duplicates and the superseded facts live.
 *
 * So the question is empirical: at 6K, 8K and 10K, does required evidence
 * actually arrive, does forbidden material arrive with it, and what does the
 * difference cost. This file is the archive those measurements run against, and
 * every case in it is a shape that has produced a real complaint.
 *
 * The story is one long roleplay. `storyNow` is where it has reached, and the
 * memories are spread back across it so that story distance — the thing aging
 * is now measured in — is meaningful rather than uniform.
 */

const day = (value: number) => new Date(Date.UTC(2026, 0, Math.max(1, Math.min(28, value)))).toISOString();

export const storyNow: StoryPosition = { messageCount: 900, storyDay: 40, now: Date.parse("2026-08-30T12:00:00Z") };

function mem(input: {
  id: string; content: string; kind?: Memory["kind"]; importance?: number;
  keywords?: string[]; pinned?: boolean; status?: Memory["status"]; resolution?: string;
  at: number; storyDay?: number; lastRelevance?: number;
}): Memory {
  return {
    id: input.id, characterId: "character", conversationId: "chat",
    content: input.content, kind: input.kind ?? "event", importance: input.importance ?? 3,
    keywords: input.keywords ?? [], pinned: input.pinned ?? false,
    status: input.status ?? "active", resolution: input.resolution ?? "",
    resolvedAt: input.status === "resolved" ? day(20) : null,
    lastRecalledAt: null, recallCount: 0,
    sourceMessageCount: input.at,
    lastRelevanceMatchCount: input.lastRelevance ?? 0,
    scene: typeof input.storyDay === "number"
      ? { storyDay: input.storyDay, timeOfDay: "", location: "", present: [] } as Memory["scene"]
      : null,
    createdAt: day(28 - Math.floor(input.at / 40)),
  };
}

/** Padding that is plausible, plentiful, and never the answer to anything. */
function filler(count: number): Memory[] {
  const subjects = ["the kettle", "the tram", "a paperback", "the window box", "the corner shop", "a playlist", "the radiator", "a crossword"];
  return Array.from({ length: count }, (_, index) => mem({
    id: `filler-${index}`,
    at: 40 + index * 5,
    storyDay: 2 + Math.floor(index / 4),
    importance: 2,
    content: `They spent a little while on ${subjects[index % subjects.length]}, and nothing much came of it (note ${index}).`,
  }));
}

export type RetrievalCase = {
  id: string;
  /** What the reader's turn is about. */
  query: string;
  /** Memory ids the writer MUST be handed for this turn to be answerable. */
  required: string[];
  /**
   * Memory ids that must NOT arrive: superseded facts, resolved commitments
   * presented as open, and lexical decoys. Retrieving these is worse than
   * retrieving nothing, because the writer will use them.
   */
  forbidden: string[];
  note: string;
};

/**
 * THE ARCHIVE. Roughly a long story's worth: fourteen deliberate shapes plus
 * enough ordinary noise that ranking has to actually work.
 */
export const archive: Memory[] = [
  // --- far-back identity: recorded early, still true, never mentioned since ---
  mem({ id: "identity-name", at: 12, storyDay: 1, kind: "identity", importance: 5,
    content: "Her younger sister is called Junia, and she is the only family she still speaks to.",
    keywords: ["Junia", "sister"] }),

  // --- stable preference ---
  mem({ id: "preference-coffee", at: 30, storyDay: 1, kind: "preference", importance: 3,
    content: "She takes coffee black and cannot stand it sweetened.", keywords: ["coffee"] }),

  // --- boundary: must survive everything ---
  mem({ id: "boundary-dawn", at: 55, storyDay: 2, kind: "boundary", importance: 5,
    content: "He asked never to be woken before dawn, and meant it.", keywords: ["woken", "dawn"] }),

  // --- unresolved promise, made long ago, never returned to ---
  mem({ id: "promise-lighthouse", at: 80, storyDay: 3, kind: "promise", importance: 4,
    content: "She promised to take him out to the lighthouse before the season ended.",
    keywords: ["lighthouse"] }),

  // --- resolved promise: must never be offered as still open ---
  mem({ id: "promise-letter", at: 120, storyDay: 5, kind: "promise", importance: 4, status: "resolved",
    resolution: "She posted it the next morning.",
    content: "She promised to write to her sister.", keywords: ["letter", "write", "sister"] }),

  // --- stale open loop: alive, but the story has run a long way past it ---
  mem({ id: "loop-attic", at: 140, storyDay: 6, kind: "open_loop", importance: 3,
    content: "They meant to clear out the attic together at some point.", keywords: ["attic"] }),

  // --- relationship evolution: the later fact supersedes the earlier one ---
  mem({ id: "relationship-early", at: 160, storyDay: 7, kind: "relationship", importance: 4, status: "superseded",
    content: "They were still being careful with each other, and neither had said anything.",
    keywords: ["careful"] }),
  mem({ id: "relationship-now", at: 700, storyDay: 34, kind: "relationship", importance: 5,
    content: "They have been together since the night of the storm, and neither of them pretends otherwise.",
    keywords: ["together", "storm"] }),

  // --- repeated locations: three near-identical facts about one place ---
  mem({ id: "place-pier-1", at: 200, storyDay: 9, content: "They walked out to the end of the pier.", keywords: ["pier"] }),
  mem({ id: "place-pier-2", at: 320, storyDay: 15, content: "They walked the pier again, in the rain this time.", keywords: ["pier"] }),
  mem({ id: "place-pier-3", at: 640, storyDay: 31, importance: 4, content: "The pier is where she told him about Junia.", keywords: ["pier", "Junia"] }),

  // --- similar events: distinguishable only by detail ---
  mem({ id: "event-key-brass", at: 400, storyDay: 20, importance: 4,
    content: "She gave him the brass key to her workshop.", keywords: ["brass key", "workshop"] }),
  mem({ id: "event-key-iron", at: 410, storyDay: 20,
    content: "He found an old iron key in the drawer and neither of them knew what it opened.",
    keywords: ["iron key", "drawer"] }),

  // --- semantic match with weak lexical overlap ---
  mem({ id: "semantic-fear", at: 480, storyDay: 24, kind: "identity", importance: 4,
    content: "Deep water frightens her, though she will not say so out loud.", keywords: [] }),

  // --- lexical false friend: shares words, means something else entirely ---
  mem({ id: "decoy-key", at: 500, storyDay: 25,
    content: "The key change in the song they danced to was what made her laugh.",
    keywords: ["key", "song"] }),

  // --- superseded older fact ---
  mem({ id: "superseded-address", at: 210, storyDay: 10, kind: "identity", status: "superseded",
    content: "She lives above the bakery on Almond Row.", keywords: ["lives", "bakery"] }),
  mem({ id: "current-address", at: 660, storyDay: 32, kind: "identity", importance: 4,
    content: "She moved into the flat over the boatyard in the spring.", keywords: ["lives", "boatyard", "flat"] }),

  // --- pinned memory: the reader's own instruction ---
  mem({ id: "pinned-nickname", at: 300, storyDay: 14, pinned: true, kind: "preference", importance: 4,
    content: "Never call her Junie. Only her sister was allowed that.", keywords: ["Junie"] }),

  // --- many protected memories, competing for the same guaranteed tier ---
  ...Array.from({ length: 9 }, (_, index) => mem({
    id: `protected-${index}`,
    at: 180 + index * 40,
    storyDay: 8 + index * 2,
    kind: index % 2 === 0 ? "promise" : "open_loop",
    importance: 3,
    content: `They still mean to ${["repaint the shed", "find the missing record", "visit his brother", "fix the back gate", "learn the tide tables", "return the borrowed coat", "settle the argument about the map", "plant the border", "call the landlord"][index]} one of these days.`,
  })),

  ...filler(40),
];

/**
 * The turns the budget is judged on.
 *
 * `required` is the evidence without which the turn cannot be written truthfully.
 * `forbidden` is material whose ARRIVAL is the failure — a superseded address, a
 * kept promise offered as open, a decoy that shares words and nothing else.
 */
export const cases: RetrievalCase[] = [
  { id: "far-back-identity", query: "Tell me about your sister again — Junia, wasn't it?",
    required: ["identity-name"], forbidden: [],
    note: "Recorded at message 12 of 900 and never mentioned since. The oldest thing in the archive that is still true." },

  { id: "stable-preference", query: "I made you a coffee. Sugar?",
    required: ["preference-coffee"], forbidden: [],
    note: "Small, dull, and the exact kind of fact whose absence reads as the character not knowing itself." },

  { id: "boundary", query: "I could wake you early tomorrow if you like.",
    required: ["boundary-dawn"], forbidden: [],
    note: "A stated limit. Missing it is the worst failure mode in the set." },

  { id: "unresolved-promise", query: "Is there anywhere you still want to take me?",
    required: ["promise-lighthouse"], forbidden: ["promise-letter"],
    note: "The open promise must arrive; the kept one must not be offered as still owed." },

  { id: "resolved-promise", query: "Did you ever write to your sister?",
    required: ["promise-letter"], forbidden: [],
    note: "Resolved, and the resolution is the answer. It must arrive WITH its resolution." },

  { id: "relationship-evolution", query: "What are we, exactly?",
    required: ["relationship-now"], forbidden: ["relationship-early"],
    note: "The superseded version is the more cautious one, and using it undoes months of story." },

  { id: "repeated-locations", query: "Do you remember the pier?",
    required: ["place-pier-3"], forbidden: [],
    note: "Three near-identical memories about one place. The one that carries meaning should win." },

  { id: "similar-events", query: "Where's the brass key?",
    required: ["event-key-brass"], forbidden: ["decoy-key"],
    note: "Two keys and a song. Lexical overlap is high on all three." },

  { id: "semantic-weak-lexical", query: "Shall we swim out past the rocks?",
    required: ["semantic-fear"], forbidden: [],
    note: "Nothing in the query shares a word with the memory. Pure semantic recall." },

  { id: "superseded-fact", query: "I'll walk you home.",
    required: ["current-address"], forbidden: ["superseded-address"],
    note: "The old address is superseded. Retrieving it puts her in a flat she left." },

  { id: "pinned", query: "Morning, you.",
    required: ["pinned-nickname"], forbidden: [],
    note: "A pinned instruction should arrive on a turn with no lexical hook at all." },

  { id: "protected-crowd", query: "Where's the brass key?",
    required: ["event-key-brass"], forbidden: ["decoy-key"],
    note: "Same question as similar-events, judged on whether nine protected commitments crowd the answer out." },
];
