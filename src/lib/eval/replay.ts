import type { Memory, MemoryArc, Message } from "../types";
import type { EvidenceClaim } from "./evidence";

/**
 * Replaying real conversations.
 *
 * The deterministic fixtures answer "can the prompt be assembled correctly for
 * a situation we invented". This answers the question that actually decides
 * the roadmap: "on the stories people really played, where does it break".
 *
 * Two rules the plan set, and why they matter here.
 *
 * THE ORIGINAL REPLY IS NOT GROUND TRUTH. It was produced by the same system
 * under evaluation, so scoring against it would mostly measure reproducibility.
 * What the checkpoint carries instead is the set of continuity facts that were
 * ESTABLISHED BY THAT POINT — derived from the archive as it stood, or supplied
 * by hand in a label file — and the judge is asked whether a fresh generation
 * contradicts them.
 *
 * NOTHING PRIVATE LEAVES THE HARNESS. The replay reads a backup export from
 * disk, works offline, and the attribution record it emits carries identifiers,
 * counts and verdicts — never transcripts.
 */

export type BackupFile = {
  version: number;
  characters: Array<{ id: string; data: Record<string, unknown> }>;
  conversations: Array<Record<string, unknown>>;
  messages: Message[];
  memories?: Memory[];
  arcs?: MemoryArc[];
};

export type Checkpoint = {
  conversationId: string;
  /** Index into the conversation's message list of the user turn being replayed. */
  index: number;
  /** How many messages precede it. The archive is reconstructed as of this point. */
  priorMessageCount: number;
  userTurn: string;
  /** The reply that originally followed, kept only for side-by-side inspection. */
  originalReply: string;
};

/**
 * Which turns to replay.
 *
 * Deliberately biased late. Continuity failures are a function of accumulated
 * history, so the first twenty exchanges of a conversation are close to
 * useless as evidence — the transcript still carries everything and retrieval
 * is barely load-bearing. `minPriorMessages` is what stops the sample being
 * dominated by turns that could not have failed.
 */
export function selectCheckpoints(
  conversationId: string,
  messages: Message[],
  options: { every?: number; minPriorMessages?: number; max?: number } = {},
): Checkpoint[] {
  const every = Math.max(1, options.every ?? 12);
  const minPrior = Math.max(0, options.minPriorMessages ?? 40);
  const max = Math.max(1, options.max ?? 20);

  const checkpoints: Checkpoint[] = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (index < minPrior) continue;
    if ((index - minPrior) % every !== 0) continue;
    const next = messages[index + 1];
    if (!next || next.role !== "assistant") continue;
    checkpoints.push({
      conversationId,
      index,
      priorMessageCount: index,
      userTurn: message.content,
      originalReply: next.content,
    });
    if (checkpoints.length >= max) break;
  }
  return checkpoints;
}

/**
 * The archive as it stood at a checkpoint.
 *
 * `sourceMessageCount` and `endMessageCount` are the lineage stamps the
 * consolidation path already writes, which is what makes an honest replay
 * possible at all: a memory derived from turn 300 must not be visible when
 * replaying turn 120, or the harness would be testing a system with foresight.
 */
export function archiveAsOf(
  memories: Memory[],
  arcs: MemoryArc[],
  priorMessageCount: number,
) {
  return {
    memories: memories.filter((memory) => memory.sourceMessageCount <= priorMessageCount),
    arcs: arcs.filter((arc) => arc.endMessageCount <= priorMessageCount),
  };
}

/**
 * The facts a replayed turn is expected to honour.
 *
 * Derived rather than guessed: a fact counts as established at this checkpoint
 * when it is a durable memory of a kind that constrains future turns —
 * identity, relationship, boundary, and unresolved commitments — and when it
 * predates the checkpoint. Ordinary events are excluded because a reply is not
 * obliged to reference every thing that ever happened.
 *
 * A label file may add or replace claims for specific checkpoints; hand
 * labelling is strictly better evidence and this is where it enters.
 */
const constrainingKinds = new Set(["identity", "relationship", "boundary", "promise", "open_loop"]);

export function establishedFacts(memories: Memory[], priorMessageCount: number, limit = 12) {
  return memories
    .filter((memory) => memory.sourceMessageCount <= priorMessageCount)
    .filter((memory) => memory.status === "active" && constrainingKinds.has(memory.kind))
    .sort((left, right) => right.importance - left.importance || left.createdAt.localeCompare(right.createdAt))
    .slice(0, limit);
}

/** Facts that are no longer true and must not be treated as current. */
export function obsoleteFacts(memories: Memory[], priorMessageCount: number, limit = 8) {
  return memories
    .filter((memory) => memory.sourceMessageCount <= priorMessageCount)
    .filter((memory) => memory.status === "resolved" || memory.status === "superseded")
    .slice(0, limit);
}

export function claimsFromMemories(memories: Memory[]): EvidenceClaim[] {
  return memories.map((memory) => ({
    id: memory.id,
    description: `${memory.kind} established by message ${memory.sourceMessageCount}`,
    anyOf: [memory.content],
  }));
}

export type CheckpointLabels = Record<string, {
  /** Replaces the derived facts entirely when present. */
  facts?: string[];
  obsolete?: string[];
  note?: string;
}>;

/** `conversationId:index` — the key a label file uses. */
export function labelKey(checkpoint: Checkpoint) {
  return `${checkpoint.conversationId}:${checkpoint.index}`;
}
