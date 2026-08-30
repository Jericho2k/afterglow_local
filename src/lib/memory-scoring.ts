import type { Memory, MemoryKind } from "./types";

/**
 * How a memory ages, and when a commitment stops earning a guaranteed slot.
 *
 * Both rankers used to answer these two questions with one constant each: every
 * memory decayed on a 45-day half-life, and every active promise, boundary or
 * open loop held a protected slot forever. Neither is true of stories.
 *
 * A NAME DOES NOT GO STALE. Identity and a stated boundary are as true in month
 * six as on the day they were recorded; a passing event usually is not. Giving
 * them the same decay curve means either events linger or identity fades, and
 * the file had picked "identity fades".
 *
 * A COMMITMENT CAN OUTLIVE ITS STORY. The protected tier exists so an active
 * promise is never crowded out — which is right, and which is also how a
 * conversation accumulates a dozen open loops nobody will ever return to, each
 * holding a guaranteed slot against the memories the current scene is actually
 * about. `lastRecalledAt` cannot be the staleness signal, because the protected
 * tier itself refreshes it on every single turn: the tier keeps manufacturing
 * its own evidence of relevance. Age since the commitment was RECORDED is the
 * one signal retrieval does not write to.
 *
 * A stale commitment is not discarded and not resolved — nothing here decides
 * that a promise was kept. It loses only its GUARANTEE, and competes for a
 * dynamic slot on relevance like everything else. A commitment the current
 * scene is about still wins one.
 */

/** Days after which an active promise or open loop stops being guaranteed. */
export function zombieCommitmentDays() {
  const configured = Number(process.env.MEMORY_STALE_COMMITMENT_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : 45;
}

/** Recency half-life in days, by what the memory is. */
export const recencyHalfLifeDays: Record<MemoryKind, number> = {
  identity: 365,
  boundary: 365,
  relationship: 180,
  preference: 180,
  promise: 90,
  open_loop: 60,
  event: 45,
};

export function ageInDays(iso: string, now = Date.now()) {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, (now - at) / 86_400_000);
}

/**
 * The recency component, on the kind's own curve.
 *
 * Same shape and same maximum as the single-constant version it replaces, so a
 * freshly written memory of any kind scores exactly what it scored before. Only
 * the rate of decay differs.
 */
export function recencyScore(memory: Pick<Memory, "kind" | "createdAt">, now = Date.now()) {
  const halfLife = recencyHalfLifeDays[memory.kind] ?? recencyHalfLifeDays.event;
  return 2 / (1 + ageInDays(memory.createdAt, now) / halfLife);
}

/**
 * Whether an active commitment has gone quiet for long enough to give up its
 * guaranteed slot.
 *
 * Boundaries are excluded on purpose: a limit somebody stated is not a task
 * that can go stale, and dropping it from the guaranteed tier is precisely the
 * failure the tier was built to prevent. A pinned memory is a deliberate
 * instruction from the reader and is never treated as stale.
 */
export function isStaleCommitment(memory: Pick<Memory, "kind" | "status" | "pinned" | "createdAt">, now = Date.now()) {
  if (memory.pinned || memory.status !== "active") return false;
  if (memory.kind !== "promise" && memory.kind !== "open_loop") return false;
  return ageInDays(memory.createdAt, now) >= zombieCommitmentDays();
}

/**
 * The share of the episodic budget the guaranteed tier may take.
 *
 * The rest is RESERVED for relevance. Without a reserve a story with many open
 * commitments spends its whole budget on them and retrieves nothing about the
 * scene in front of the reader, which reads as the character remembering every
 * old errand and none of tonight.
 */
export const protectedBudgetShare = 0.5;
/** Hard cap on guaranteed non-pinned entries, whatever the budget allows. */
export const protectedTierLimit = 10;

export function protectedTierBudget(tokenBudget: number) {
  return Math.max(400, Math.floor(tokenBudget * protectedBudgetShare));
}

/**
 * Splits active commitments into the ones that keep a guaranteed slot and the
 * ones that must now earn one. Exported for the retrieval fixtures.
 */
export function partitionCommitments<T extends Pick<Memory, "kind" | "status" | "pinned" | "createdAt">>(memories: T[], now = Date.now()) {
  const guaranteed: T[] = []; const stale: T[] = [];
  for (const memory of memories) (isStaleCommitment(memory, now) ? stale : guaranteed).push(memory);
  return { guaranteed, stale };
}
