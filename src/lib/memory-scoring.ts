import type { Memory, MemoryKind } from "./types";

/**
 * HOW A MEMORY AGES IN A STORY, WHICH IS NOT HOW IT AGES ON A CALENDAR.
 *
 * The previous version answered "is this old" with wall-clock days since the
 * memory was written. That is the wrong clock, and the product truth it misses
 * is not an edge case:
 *
 *   A ROLEPLAY CAN SIT UNTOUCHED FOR THREE REAL MONTHS WHILE FIVE FICTIONAL
 *   MINUTES PASS.
 *
 * On the calendar clock, a reader who comes back after a summer away finds
 * every promise stale, every open loop demoted out of its guaranteed slot, and
 * every event faded — in a scene that, inside the fiction, has not moved at
 * all. The character forgets the conversation it is currently having. Nothing
 * about that is a memory-quality problem; it is the clock.
 *
 * So distance is measured in the story's own units.
 *
 *   MESSAGE DISTANCE is how many turns have happened since the memory was
 *   recorded. Always available, monotonic, and unaffected by how long the
 *   reader was away.
 *
 *   STORY-DAY DISTANCE is how much time has passed INSIDE the fiction, from
 *   the scene stamp on the memory. Available only when Scene State observed a
 *   day for it, and the more meaningful of the two when it is: a promise made
 *   "yesterday" in the story is fresh however many turns it took to tell.
 *
 * Whichever ages the memory more wins, because either is sufficient evidence
 * that the story has moved on. Real-world age survives only as a weak
 * tiebreaker between memories the story clock cannot separate.
 */

/** Everything the aging rules read off a memory. */
export type AgingInputs = Pick<Memory, "kind" | "status" | "pinned" | "sourceMessageCount" | "scene"> & {
  lastRelevanceMatchCount?: number;
};

/** Where the story is now, in its own units. */
export type StoryPosition = {
  /** Accepted messages in the conversation so far. */
  messageCount: number;
  /** The current in-fiction day, when Scene State has observed one. */
  storyDay?: number | null;
  /** Wall clock, used only to break ties. */
  now?: number;
};

/**
 * Turns after which a memory of this kind has half-faded.
 *
 * Same ordering as the old day-based curve — a name outlasts an errand — but in
 * the unit that actually tracks the story. At the default consolidation
 * interval an ordinary session is tens of messages, so an event fading over a
 * few hundred turns is roughly "a few sessions ago".
 */
export const recencyHalfLifeMessages: Record<MemoryKind, number> = {
  identity: 4_000,
  boundary: 4_000,
  relationship: 1_200,
  preference: 1_200,
  promise: 600,
  open_loop: 400,
  event: 300,
};

/** The same curve in fictional days, for memories Scene State stamped. */
export const recencyHalfLifeStoryDays: Record<MemoryKind, number> = {
  identity: 3_650,
  boundary: 3_650,
  relationship: 365,
  preference: 365,
  promise: 120,
  open_loop: 60,
  event: 45,
};

/**
 * HOW MUCH RECENCY IS ALLOWED TO MATTER.
 *
 * The old component was worth at most 2 points against a semantic term worth 45
 * and a pinned bonus worth 35 — about 1.7% of the achievable score, which
 * cannot reorder anything except an exact tie. It was decorative, and a
 * decorative weight is worse than none because it reads as a decision.
 *
 * Six is a deliberate size: enough to separate two memories the query matches
 * equally well, in favour of the one the story is nearer to; not enough to lift
 * an irrelevant recent memory over a relevant older one, which would be the
 * failure in the other direction. Semantic relevance still decides.
 */
export const recencyWeight = 6;

export function ageInDays(iso: string, now = Date.now()) {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, (now - at) / 86_400_000);
}

/**
 * How far the story has travelled since a memory was recorded, as a fraction of
 * that kind's half-life. Zero is "just now"; one is "half-faded".
 */
export function storyDistance(memory: Pick<Memory, "kind" | "sourceMessageCount" | "scene">, at: StoryPosition) {
  const messagesSince = Math.max(0, at.messageCount - (memory.sourceMessageCount || 0));
  const byMessages = messagesSince / (recencyHalfLifeMessages[memory.kind] ?? recencyHalfLifeMessages.event);

  const memoryDay = memory.scene?.storyDay;
  const byStoryDays = typeof memoryDay === "number" && typeof at.storyDay === "number"
    ? Math.max(0, at.storyDay - memoryDay) / (recencyHalfLifeStoryDays[memory.kind] ?? recencyHalfLifeStoryDays.event)
    : 0;

  // Either clock is sufficient evidence that the story has moved on, so the
  // one that ages it more decides.
  return Math.max(byMessages, byStoryDays);
}

/**
 * The recency component.
 *
 * A weak real-world term is kept as a TIEBREAKER only, worth at most a tenth of
 * the story term. Two memories at the same point in the story, one written
 * today and one a year ago, are not equally likely to be what the reader means
 * — but the difference is a nudge, not a ranking signal.
 */
export function recencyScore(memory: Pick<Memory, "kind" | "sourceMessageCount" | "scene" | "createdAt">, at: StoryPosition) {
  const story = 1 / (1 + storyDistance(memory, at));
  const wallClock = 1 / (1 + ageInDays(memory.createdAt, at.now ?? Date.now()) / 365);
  return recencyWeight * (story * 0.9 + wallClock * 0.1);
}

/**
 * How far the story may travel past a commitment before it stops being
 * guaranteed a slot.
 *
 * Generous on both clocks, because the cost of demoting a live promise too
 * early is much higher than the cost of carrying a dead one a little longer.
 * Either firing is enough: six hundred turns is a long way even inside one
 * intense fictional night, and ninety fictional days is a long way even if the
 * telling took twenty messages.
 */
export function staleCommitmentMessages() {
  const configured = Number(process.env.MEMORY_STALE_COMMITMENT_MESSAGES);
  return Number.isFinite(configured) && configured > 0 ? configured : 600;
}

export function staleCommitmentStoryDays() {
  const configured = Number(process.env.MEMORY_STALE_COMMITMENT_STORY_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : 90;
}

/**
 * Whether an active commitment has gone quiet for long enough to give up its
 * guaranteed slot.
 *
 * THE SELF-REFRESHING LOOP THIS AVOIDS. The obvious signal is "when was this
 * last recalled", and it is unusable: the protected tier recalls its own
 * members on every single turn, so a commitment nobody has thought about in
 * three hundred messages keeps producing fresh evidence that it is relevant.
 * `recall_count` and `last_recalled_at` are downstream of the guarantee and can
 * never be used to justify it.
 *
 * `lastRelevanceMatchCount` is the signal that is NOT downstream of it. It is
 * written only when a commitment wins on its own merits — semantic, lexical or
 * scene relevance — and never when it was merely handed a guaranteed slot. A
 * promise the current scene is genuinely about keeps refreshing it; one that is
 * only ever included because it is protected does not.
 *
 * Boundaries are excluded on purpose: a limit somebody stated is not a task
 * that can go stale, and dropping it is precisely the failure the tier exists
 * to prevent. A pinned memory is a deliberate instruction and is never stale.
 */
export function isStaleCommitment(
  memory: AgingInputs,
  at: StoryPosition,
) {
  if (memory.pinned || memory.status !== "active") return false;
  if (memory.kind !== "promise" && memory.kind !== "open_loop") return false;

  // The later of "when it was made" and "when it last mattered on its own".
  const anchor = Math.max(Number(memory.sourceMessageCount) || 0, Number(memory.lastRelevanceMatchCount) || 0);
  if (at.messageCount - anchor >= staleCommitmentMessages()) return true;

  const memoryDay = memory.scene?.storyDay;
  if (typeof memoryDay === "number" && typeof at.storyDay === "number") {
    return at.storyDay - memoryDay >= staleCommitmentStoryDays();
  }
  return false;
}

/**
 * THE THREE RESERVES, AND WHY NONE OF THEM MAY TAKE EVERYTHING.
 *
 * A guarantee that can consume the whole episodic budget is not a guarantee,
 * it is a takeover: the reader gets every old errand and nothing about the
 * scene in front of them. Pinned memories used to be exactly that — added
 * before any budget rule, with no ceiling of their own, so a reader who pinned
 * a dozen long memories left retrieval nothing to work with and then reported
 * that the character had stopped noticing what was happening.
 *
 * So each tier has a share and relevance keeps the rest. Pinned is deliberately
 * the largest single reserve — it is the reader's own explicit instruction —
 * but it is a reserve rather than a blank cheque, and a pinned memory beyond it
 * still competes for a dynamic slot carrying a +35 bonus, which it usually wins.
 */
export const pinnedBudgetShare = 0.3;
export const protectedBudgetShare = 0.35;
/** Hard caps on entries, whatever the token budget allows. */
export const pinnedTierLimit = 8;
export const protectedTierLimit = 10;

export function pinnedTierBudget(tokenBudget: number) {
  return Math.max(300, Math.floor(tokenBudget * pinnedBudgetShare));
}

export function protectedTierBudget(tokenBudget: number) {
  return Math.max(400, Math.floor(tokenBudget * protectedBudgetShare));
}

/** What is left for memories that must earn their place on relevance. */
export function dynamicBudgetShare() {
  return Math.max(0, 1 - pinnedBudgetShare - protectedBudgetShare);
}

/**
 * Splits active commitments into the ones that keep a guaranteed slot and the
 * ones that must now earn one. Exported for the retrieval fixtures.
 */
export function partitionCommitments<T extends AgingInputs>(memories: T[], at: StoryPosition) {
  const guaranteed: T[] = []; const stale: T[] = [];
  for (const memory of memories) (isStaleCommitment(memory, at) ? stale : guaranteed).push(memory);
  return { guaranteed, stale };
}

/**
 * Where the story is, worked out from the memories themselves.
 *
 * A fallback for callers that have no conversation row in hand — the archive's
 * newest `sourceMessageCount` is the last point the story is known to have
 * reached. It under-estimates rather than over-estimates, which is the safe
 * direction: under-estimating makes everything look slightly fresher, and
 * carrying a memory too long is a far smaller failure than forgetting one.
 */
export function storyPositionFrom(memories: Array<Pick<Memory, "sourceMessageCount" | "scene">>, now = Date.now()): StoryPosition {
  let messageCount = 0;
  let storyDay: number | null = null;
  for (const memory of memories) {
    messageCount = Math.max(messageCount, Number(memory.sourceMessageCount) || 0);
    const day = memory.scene?.storyDay;
    if (typeof day === "number") storyDay = storyDay === null ? day : Math.max(storyDay, day);
  }
  return { messageCount, storyDay, now };
}
