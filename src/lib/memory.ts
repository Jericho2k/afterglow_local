import { randomUUID } from "node:crypto";
import { completionWithUsage, parseJson, type LLMMessage } from "./llm";
import { asUser, getUserSettings } from "./db";
import { consolidationInput, consolidationInstructions } from "./prompts";
import type { Memory, MemoryArc, Message } from "./types";
import { memoryArcFromRow, memoryFromRow, messageFromRow } from "./db";
import { recordUsageEvent, type RouteProvenance } from "./usage";
import { estimateTokens } from "./context";
import { backgroundReasoningFor, providerModelId } from "./provider";
import { backgroundCandidate, backgroundRoute, routeProvenance } from "./background-routing";
import { recordBackgroundFailure, recordBackgroundSuccess } from "./background-health";
import { ProviderError, logProviderDiagnostic, type ProviderErrorCategory } from "./provider-errors";
import { inferenceSessionId } from "./inference-session";
import { acquireMemoryJobLease, releaseMemoryJobLease } from "./memory-jobs";
import { memoryRetrievalV2Enabled } from "./memory-flags";
import { isStaleCommitment, protectedTierBudget, protectedTierLimit, recencyScore, storyPositionFrom, type StoryPosition } from "./memory-scoring";
import { consolidationTrigger, maxBatchRows, planConsolidationBatch } from "./consolidation-batch";
import { invalidateSceneStatesAfter, sceneSpanBetween, sceneStampAt } from "./scene-state-store";
import type { PoolClient } from "pg";

const stopWords = new Set(["the", "and", "that", "this", "with", "from", "have", "your", "you", "are", "was", "for", "but", "not", "they", "she", "him", "her", "his", "our"]);
const essentialKinds = new Set<Memory["kind"]>(["relationship", "promise", "boundary", "open_loop"]);
const protectedKinds = new Set<Memory["kind"]>(["promise", "boundary", "open_loop"]);
const activeConsolidations = new Set<string>();

/**
 * WHICH FAILURES THE CONTROL IS ALLOWED TO ANSWER FOR.
 *
 * The line is drawn between "this route could not do the work" and "this
 * deployment is misconfigured", and it is drawn deliberately in favour of
 * letting a misconfiguration be seen.
 *
 * RECOVERED. A host that was busy, unreachable, silent, or that spent the
 * envelope on hidden thinking; and a reply that was paid for and was not the
 * contract. Every one of those is a fact about one route on one afternoon, and
 * a memory window is lost permanently if nobody else answers.
 *
 * NOT RECOVERED, and each for its own reason:
 *
 *   `auth` / `billing`  A wrong key or an empty account. Quietly routing around
 *                       it means the operator discovers it at the worst
 *                       possible moment instead of the first one.
 *   `bad_request`       Afterglow sent something the endpoint rejected — a
 *                       catalogue entry that is wrong, or a pinned host that
 *                       refuses to run this job at all. Falling back would hide
 *                       exactly the signal that says which.
 *   `content_filtered`  A refusal is a decision. Sending the same transcript to
 *                       a different model to get a different answer is routing
 *                       around a safety layer, which is not a thing this
 *                       codebase does by accident.
 *   `timeout`           The caller hung up or the deadline passed. A second
 *                       full consolidation on top of one that already ran long
 *                       is spend with nobody waiting for it; the window keeps
 *                       and the next job reads it.
 */
export function recoverableForFallback(category: ProviderErrorCategory | "malformed_output" | "no_summary" | "unknown") {
  return category === "empty_response"
    || category === "reasoning_budget_exhausted"
    || category === "rate_limited"
    || category === "upstream_unavailable"
    || category === "malformed_output"
    || category === "no_summary";
}

/**
 * The newest assistant reply remains provisional while the user can regenerate
 * or choose another variant. It becomes accepted only when the story advances.
 */
export function acceptedMessageCount(messageCount: number, latestRole?: Message["role"] | null) {
  return Math.max(0,messageCount - (latestRole === "assistant" ? 1 : 0));
}

export async function invalidateDerivedContinuity(client: PoolClient, conversationId: string, validThroughPosition: number, userId?: string) {
  const position = Math.max(0,validThroughPosition);
  const owner = userId ?? null;
  await client.query("DELETE FROM memories WHERE conversation_id=$1 AND source_message_count > $2 AND ($3::uuid IS NULL OR user_id=$3)",[conversationId,position,owner]);
  await client.query("DELETE FROM memory_arcs WHERE conversation_id=$1 AND end_message_count > $2 AND ($3::uuid IS NULL OR user_id=$3)",[conversationId,position,owner]);
  // Scene State shares this lineage: a branch or an edit that discards a future
  // must also discard the location, day, cast and open loops that future
  // established, or the story keeps a room it never moved into.
  await invalidateSceneStatesAfter(client,conversationId,position,owner ?? undefined);
  const v2Enabled=Boolean(userId&&memoryRetrievalV2Enabled(userId));
  if (v2Enabled) {
    // Canon is derived from the permanent archive. A branch/edit supersedes
    // only canon whose evidence came from the discarded future.
    await client.query("UPDATE core_canon_entries SET status='superseded',updated_at=now() WHERE conversation_id=$1 AND source_message_count>$2 AND user_id=$3",[conversationId,position,userId]);
  }
  const countResult = await client.query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1",[conversationId]);
  const messageCount = Number(countResult.rows[0].count);
  /*
   * The intra-message cursor is reset alongside the message count.
   *
   * It is an offset INTO a specific message, and a branch or an edit can change
   * or remove that message. Rewinding the count while leaving the offset would
   * resume reading a long message from a character position that belongs to
   * text that no longer exists there.
   */
  if (v2Enabled) await client.query(
    "UPDATE conversations SET message_count=$1,summary='',last_consolidated_count=$2,last_consolidated_offset=0,last_curated_message_count=LEAST(last_curated_message_count,$5),canon_version=canon_version+1,updated_at=now() WHERE id=$3 AND user_id=$4",
    [messageCount,Math.max(0,messageCount - 50),conversationId,userId,position],
  );
  else await client.query(
    "UPDATE conversations SET message_count=$1,summary='',last_consolidated_count=$2,last_consolidated_offset=0,updated_at=now() WHERE id=$3 AND ($4::uuid IS NULL OR user_id=$4)",
    [messageCount,Math.max(0,messageCount - 50),conversationId,owner],
  );
}

function terms(value: string) {
  const words = value.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [];
  return new Set(words.filter((word) => !stopWords.has(word)).map((word) => {
    if (word.length > 6 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 5 && word.endsWith("ed")) return word.slice(0, -2);
    if (word.length > 5 && word.endsWith("es")) return word.slice(0, -2);
    if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
    return word;
  }));
}

function memoryCost(memory: Memory) {
  return estimateTokens(`${memory.content} ${memory.resolution}`) + 16;
}

/**
 * `at` is where the story has reached, in the story's own units.
 *
 * It replaces the wall clock this ranker used to age memories by. When a caller
 * cannot supply it, the archive's own newest position stands in; see
 * `storyPositionFrom` for why that errs on the side of remembering.
 */
export function rankMemories(memories: Memory[], input: string, limit = 8, tokenBudget = 6000, at?: StoryPosition) {
  const position = at ?? storyPositionFrom(memories);
  const inputTerms = terms(input);
  const ranked = memories
    .map((memory) => {
      const memoryTerms = terms(`${memory.content} ${memory.keywords.join(" ")}`);
      let overlap = 0;
      inputTerms.forEach((term) => { if (memoryTerms.has(term)) overlap += 1; });
      const phraseHits = memory.keywords.filter((key) => input.toLowerCase().includes(key.toLowerCase())).length;
      // Staleness and decay are shared with the V2 ranker so the two paths
      // cannot disagree about how a memory ages; see src/lib/memory-scoring.ts.
      const stale = isStaleCommitment(memory, position);
      const activeBoost = memory.status === "active" && protectedKinds.has(memory.kind) && !stale ? 18 : 0;
      const kindBoost = essentialKinds.has(memory.kind) ? 7 : memory.kind === "event" ? 2 : 0;
      const score = phraseHits * 24 + overlap * 5 + memory.importance * 3 + activeBoost + kindBoost + recencyScore(memory, position);
      return { memory, score, overlap, phraseHits, stale };
    })
    .filter(({ memory }) => memory.status !== "superseded")
    .sort((a, b) => b.score - a.score);

  const selected: Memory[] = [];
  const selectedIds = new Set<string>();
  let usedTokens = 0;
  const addWithinBudget = (memory: Memory) => {
    if (selectedIds.has(memory.id)) return false;
    const cost = memoryCost(memory);
    if (selected.length > 0 && usedTokens + cost > tokenBudget) return false;
    selected.push(memory); selectedIds.add(memory.id); usedTokens += cost; return true;
  };

  // Pinned journal entries are deliberate guarantees. Active promises,
  // boundaries, and open loops receive their own protected tier and do not
  // consume the ordinary relevant-event slot count.
  ranked.filter(({ memory }) => memory.pinned).forEach(({ memory }) => addWithinBudget(memory));
  const protectedTokenLimit = protectedTierBudget(tokenBudget);
  let protectedTokens = 0;
  let protectedCount = 0;
  ranked
    // A commitment nobody has returned to keeps its place in the archive and
    // loses only its guarantee: it still competes for a dynamic slot below.
    .filter(({ memory, stale }) => !memory.pinned && memory.status === "active" && protectedKinds.has(memory.kind) && !stale)
    .forEach(({ memory }) => {
      const cost = memoryCost(memory);
      if (protectedCount >= protectedTierLimit || (protectedCount > 0 && protectedTokens + cost > protectedTokenLimit)) return;
      if (addWithinBudget(memory)) { protectedCount += 1; protectedTokens += cost; }
    });
  const dynamic = ranked
    .filter(({ memory, overlap, phraseHits }) => !selectedIds.has(memory.id) && (
      memory.status === "active"
        ? phraseHits > 0 || overlap > 0 || memory.importance >= 4 || essentialKinds.has(memory.kind)
        : phraseHits > 0 || overlap > 0
    ));
  let dynamicCount = 0;
  for (const { memory } of dynamic) {
    if (dynamicCount >= limit) break;
    if (addWithinBudget(memory)) dynamicCount += 1;
  }
  return selected;
}


/**
 * The commitments a consolidation pass may mark resolved.
 *
 * This is NOT the writer's retrieval question and must not reuse its answer.
 * The writer asks "what is relevant to this moment", which is a relevance
 * ranking against the reader's latest turn. The consolidator asks "did anything
 * in this window close one of these", and relevance to the window is exactly
 * the wrong filter: a promise the transcript never mentions by name is the one
 * most likely to have been quietly fulfilled, and ranking it out means it can
 * never be resolved and stays open forever. Reusing `rankMemories` here is how
 * the archive accumulated permanently-open commitments.
 *
 * So the selection is deterministic and chronological rather than lexical:
 * every open commitment, oldest first, bounded by a count and a token budget so
 * the prompt cannot grow without limit. Oldest first is deliberate — the
 * commitments most in need of a resolution decision are the ones that have been
 * open longest.
 */
export const commitmentCandidateLimit = 24;

export function commitmentResolutionCandidates(memories: Memory[], limit = commitmentCandidateLimit, tokenBudget = 2000) {
  const open = memories
    .filter((memory) => memory.status === "active" && (memory.kind === "promise" || memory.kind === "open_loop" || memory.kind === "boundary"))
    .sort((a, b) => {
      // Pinned first, then oldest first, then by id so the order is total.
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const byAge = a.createdAt.localeCompare(b.createdAt);
      return byAge !== 0 ? byAge : a.id.localeCompare(b.id);
    });
  const selected: Memory[] = [];
  let used = 0;
  for (const memory of open) {
    if (selected.length >= limit) break;
    const cost = estimateTokens(memory.content) + 16;
    if (selected.length > 0 && used + cost > tokenBudget) continue;
    selected.push(memory); used += cost;
  }
  return selected;
}

export function rankArcs(arcs: MemoryArc[], input: string, limit = 4, tokenBudget = 1800) {
  const inputTerms = terms(input);
  const ranked = arcs.map((arc) => {
    const arcTerms = terms(`${arc.summary} ${arc.keywords.join(" ")}`);
    let overlap = 0; inputTerms.forEach((term) => { if (arcTerms.has(term)) overlap += 1; });
    const phraseHits = arc.keywords.filter((key) => input.toLowerCase().includes(key.toLowerCase())).length;
    const ageDays = Math.max(0, (Date.now() - new Date(arc.createdAt).getTime()) / 86_400_000);
    return { arc, score: phraseHits * 24 + overlap * 5 + 2 / (1 + ageDays / 90), overlap, phraseHits };
  }).filter(({ overlap, phraseHits }) => overlap > 0 || phraseHits > 0).sort((a,b) => b.score - a.score);
  const selected: MemoryArc[] = []; let used = 0;
  for (const { arc } of ranked) {
    const cost = estimateTokens(arc.summary) + 12;
    if (selected.length > 0 && used + cost > tokenBudget) continue;
    selected.push(arc); used += cost;
    if (selected.length >= limit) break;
  }
  return selected;
}

/**
 * Durable memories this account holds for a character.
 *
 * The `conversation_id IS NULL` arm is what makes a memory apply across every
 * chat with the same character. Without the account predicate it would also
 * apply across every *account* chatting with a shared public character, which
 * is why the owner filter is not optional here.
 */
export async function relevantMemories(client: PoolClient, userId: string, characterId: string, conversationId: string, input: string, limit = 8, tokenBudget = 6000, at?: StoryPosition) {
  const result = await client.query(
    "SELECT * FROM memories WHERE user_id = $3 AND character_id = $1 AND (conversation_id = $2 OR conversation_id IS NULL) ORDER BY pinned DESC, created_at DESC",
    [characterId,conversationId,userId],
  );
  return rankMemories(result.rows.map(memoryFromRow), input, limit, tokenBudget, at);
}

export async function relevantContinuity(client: PoolClient, userId: string, characterId: string, conversationId: string, input: string, limit = 8, tokenBudget = 6000) {
  const arcBudget = Math.min(2000, Math.max(500, Math.floor(tokenBudget * 0.25)));
  const [memories, arcResult] = await Promise.all([
    relevantMemories(client,userId,characterId,conversationId,input,limit,Math.max(500,tokenBudget - arcBudget)),
    client.query("SELECT * FROM memory_arcs WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC",[conversationId,userId]),
  ]);
  const arcs = rankArcs(arcResult.rows.map(memoryArcFromRow),input,4,arcBudget);
  if (memories.length) await client.query(
    "UPDATE memories SET last_recalled_at=now(),recall_count=recall_count+1 WHERE id=ANY($1::uuid[]) AND user_id=$2",
    [memories.map((memory) => memory.id),userId],
  );
  return { memories, arcs };
}

type Consolidation = {
  summary?: string;
  arcSummary?: string;
  arcKeywords?: string[];
  memories?: Array<{ content?: string; kind?: Memory["kind"]; importance?: number; keywords?: string[] }>;
  memoryUpdates?: Array<{ id?: string; status?: "active" | "resolved"; resolution?: string }>;
};

function similarity(left: string, right: string) {
  const a = terms(left); const b = terms(right);
  if (!a.size || !b.size) return 0;
  let shared = 0; a.forEach((term) => { if (b.has(term)) shared += 1; });
  return shared / (a.size + b.size - shared);
}

/**
 * Condenses recent turns into the rolling summary, an episodic arc, and new
 * durable memories.
 *
 * Every statement runs as the owning account. The model call deliberately sits
 * between short transactions rather than inside one: a consolidation can take
 * several seconds and holding a pooled connection (and its locks) open across
 * a network round trip to the provider would stall other requests.
 */
export async function maybeConsolidate(userId: string, conversationId: string, force = false) {
  const lockKey = `${userId}:${conversationId}`;
  if (activeConsolidations.has(lockKey)) return false;
  activeConsolidations.add(lockKey);
  let databaseLease: string | null = null;
  try {
    if (memoryRetrievalV2Enabled(userId)) {
      databaseLease = await acquireMemoryJobLease(userId,conversationId,"consolidation",480);
      if (!databaseLease) return false;
    }
    const prepared = await asUser(userId, async (client) => {
      const settings = await getUserSettings(client, userId);
      const conversationResult = await client.query("SELECT * FROM conversations WHERE id = $1 AND user_id = $2", [conversationId, userId]);
      const conversation = conversationResult.rows[0];
      if (!conversation) return null;
      const messageCount = Number(conversation.message_count || 0);
      const latestResult = await client.query(
        "SELECT role FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
        [conversationId,userId],
      );
      const eligibleMessageCount = acceptedMessageCount(messageCount,latestResult.rows[0]?.role as Message["role"] | undefined);
      const previousCount = Number(conversation.last_consolidated_count || 0);
      const delta = eligibleMessageCount - previousCount;
      if (delta <= 0 || eligibleMessageCount < 2) return null;

      // The cheap gate first: below the interval there is nothing to weigh.
      if (!force && delta < settings.consolidationInterval) return null;

      /*
       * The next unseen window, read once and then weighed.
       *
       * `pendingTokens` is measured in JS rather than in SQL because the test
       * database has no `length()`, and a query shape that cannot be tested is
       * worse than one extra pass over rows this function is about to read
       * anyway. It is bounded by the row ceiling, and under-counting can only
       * happen when more rows are pending than the ceiling — which is already
       * far past `maxPendingMessages`, so the backlog trigger has fired.
       */
      const candidateRows = await client.query(
        "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC,id ASC OFFSET $3 LIMIT $4",
        [conversationId,userId,previousCount,Math.min(maxBatchRows(),Math.max(1,delta))],
      );
      const candidates = candidateRows.rows.map(messageFromRow) as Message[];
      const pendingTokens = candidates.reduce((sum,message) => sum + estimateTokens(message.content) + 8, 0);
      /*
       * Whether this window is worth a call, measured in transcript rather than
       * in message count. Ten one-line messages no longer buy their own
       * ~8K-token call; they wait for the story to accumulate, or for the
       * pending-message ceiling.
       */
      const trigger = consolidationTrigger({
        delta, interval: settings.consolidationInterval, pendingTokens, force,
        // The rails that keep an accepted message from falling out of the
        // writer's transcript before it has been consolidated are derived from
        // that transcript, so the trigger has to be told how wide it is.
        contextMessages: settings.contextMessages, contextTokenBudget: settings.contextTokenBudget,
      });
      if (!trigger.due) return null;

      // The batch is a chronological PREFIX of what is unseen, so if
      // maintenance ever falls behind no older accepted turn is skipped and the
      // position pointer advances by exactly the number of rows read.
      const startOffset = Number(conversation.last_consolidated_offset || 0);
      const batch = planConsolidationBatch(candidates, { startOffset });
      if (!batch.messages.length) {
        if (batch.size) {
          // An offset that has already consumed its message: step past the row
          // rather than looping on an empty tail.
          await client.query(
            "UPDATE conversations SET last_consolidated_count=GREATEST(last_consolidated_count,$1),last_consolidated_offset=0,updated_at=now() WHERE id=$2 AND user_id=$3",
            [previousCount + batch.size, conversationId, userId],
          );
        }
        return null;
      }
      const messages = batch.messages;
      const batchEnd = previousCount + batch.size;
      const activeResult = await client.query(
        "SELECT * FROM memories WHERE user_id=$3 AND character_id=$1 AND (conversation_id=$2 OR conversation_id IS NULL) AND status='active' AND kind IN ('promise','open_loop','boundary') ORDER BY pinned DESC,importance DESC,created_at ASC",
        [conversation.character_id, conversationId, userId],
      );
      /*
       * Which commitments this call may close.
       *
       * Deliberately NOT the writer's relevance ranking, which is what this
       * used to reuse with a 5,000-token budget. See
       * `commitmentResolutionCandidates`: ranking by similarity to the window
       * hides exactly the commitments most likely to have been quietly
       * fulfilled, and the block was a large fixed cost on every call.
       */
      const activeCommitments = commitmentResolutionCandidates(activeResult.rows.map(memoryFromRow));
      return { settings, conversation, batchEnd, messages, activeCommitments, batch, trigger };
    });
    if (!prepared) return false;
    const { settings, conversation, batchEnd, messages, activeCommitments, batch } = prepared;
    const previousCount = Number(conversation.last_consolidated_count || 0);
    if (batch.chunk) console.info("[memory] reading one oversized message in chunks", JSON.stringify({ conversationId, ...batch.chunk }));

    /*
     * Which model extracts this window, and who decided.
     *
     * The conversation's own override is read from the row the transaction
     * above already had open; it is null for every conversation nobody is
     * running an experiment on, which is all of them. See
     * src/lib/background-routing.ts for the four layers underneath it.
     */
    const route = await backgroundRoute("memory_consolidation", { overrideCandidateId: conversation.memory_model_override as string | null });
    // Consolidation has no "disabled" candidate — a story that stops extracting
    // memories stops having a past — so a null selection here would be a bug in
    // the candidate table rather than a configuration. Refuse loudly.
    if (!route.selection) throw new Error("memory_consolidation resolved to no model");
    const rpEngineId = String(conversation.rp_engine_id || settings.roleplayPreset);
    const request: LLMMessage[] = [
      /*
       * Stable prefix first, changing material second.
       *
       * The system message is byte-identical on every consolidation call this
       * deployment ever makes, so it is the part a provider prompt cache can
       * actually reuse. See `consolidationInstructions`. It also asks for JSON
       * IN WORDS, which is what makes the request survive a model whose
       * endpoint does not implement `response_format`.
       */
      { role: "system", content: `You are a precise continuity editor and episodic-memory curator. Output JSON only.\n\n${consolidationInstructions()}` },
      { role: "user", content: consolidationInput(String(conversation.summary), messages, settings.ownerName, activeCommitments) },
    ];

    /** One route's attempt at this window, with its cost recorded either way. */
    const attemptConsolidation = async (
      selection: { providerId: string; modelId: string },
      provenance: RouteProvenance,
    ): Promise<{ ok: true; data: Consolidation } | { ok: false; reason: string; recoverable: boolean }> => {
      const { providerId, modelId } = selection;
      const record = (usage: NonNullable<Awaited<ReturnType<typeof completionWithUsage>>["usage"]>) => recordUsageEvent({
        userId, conversationId, providerId, model: modelId,
        actualModel: providerModelId(providerId, modelId) ?? modelId,
        rpEngineId, kind: "memory_consolidation", taskRoute: "memory_consolidation",
        routing: provenance, usage,
      }).catch((error) => console.error("Memory usage accounting failed", error));
      try {
        const response = await completionWithUsage({ providerId, modelId }, request, {
          json: true, maxTokens: 3600, temperature: 0.2,
          /*
           * `modelId` is the CATALOGUE id, and passing it is what applies this
           * model's routing policy — the price ceiling, the privacy floor, the
           * dedicated-host pin the evaluation routes depend on, and now whether
           * the endpoint is sent `response_format` at all.
           */
          modelId,
          /*
           * NO HIDDEN THINKING IN A 3,600-TOKEN ENVELOPE.
           *
           * Reasoning tokens are billed and counted as completion tokens, so a
           * reasoning-capable model given no instruction can spend the whole
           * envelope thinking and return `content: null` — which is what
           * DeepSeek V4 Flash 0731 did in production. Direct DeepSeek's own
           * adapter has always disabled thinking on this path; this is the
           * OpenRouter path agreeing with it. See `backgroundReasoningFor`.
           */
          thinking: backgroundReasoningFor(modelId),
          /*
           * And if an endpoint refuses to be told that, it is incompatible with
           * this job rather than something to negotiate around: dropping the
           * parameter hands back the endpoint's own default, which is MORE
           * thinking inside the same small envelope.
           */
          strictReasoning: true,
          // One stable session per conversation, in the consolidation namespace
          // and no other. See src/lib/inference-session.ts.
          sessionId: inferenceSessionId("memory_consolidation", conversationId),
        });
        if (response.usage) await record(response.usage);
        try {
          const data = parseJson<Consolidation>(response.content);
          if (!data.summary) return { ok: false, reason: "no_summary", recoverable: true };
          return { ok: true, data };
        } catch {
          /*
           * The model answered, was paid for, and produced something that is not
           * the contract. Recoverable — and deliberately WITHOUT a same-model
           * retry first.
           *
           * A consolidation is the most expensive background call there is, and
           * a model that has just produced malformed JSON is the least likely
           * thing to produce valid JSON on an identical second ask. One extra
           * attempt is the budget; spending it on the control is strictly
           * better than spending it on the model that failed. (The Scene Ledger
           * retries in place because its call costs a fraction of a cent and
           * its model is chosen for being cheap rather than for being reliable.)
           */
          return { ok: false, reason: "malformed_output", recoverable: true };
        }
      } catch (error) {
        const category = error instanceof ProviderError ? error.category : "unknown";
        logProviderDiagnostic("memory consolidation failed", error instanceof ProviderError
          ? error.withDiagnostic({ conversationId, model: modelId, provider: providerId })
          : error);
        return { ok: false, reason: category, recoverable: recoverableForFallback(category) };
      }
    };

    let attempt = await attemptConsolidation(route.selection, routeProvenance(route));
    let usedFallback = false;
    let attemptedModel = route.selection.modelId;
    const failureReason = attempt.ok ? "" : attempt.reason;

    /*
     * THE ONE FALLBACK, AND WHY LONG-TERM MEMORY GETS ONE AT ALL.
     *
     * A reader chatted normally for a week and discovered later that the
     * conversation had no memories: every consolidation on an experimental
     * route had failed, invisibly, because background work is deliberately not
     * coupled to the reply. An experiment that can be wrong about cost is fine.
     * An experiment that quietly turns memory OFF is not, because the loss is
     * permanent — the window it failed on is consolidated-past once the story
     * moves on, and no later job goes back for it.
     *
     * So exactly one retry, on the trusted control, and only when all three
     * hold:
     *
     *   THE ROUTE WAS NOT ALREADY THE CONTROL. Falling DeepSeek back to
     *   DeepSeek is a second identical failure and a second bill.
     *   THE FAILURE IS RECOVERABLE. See `recoverableForFallback`: a busy host
     *   or a garbled reply, never a credential or a request we got wrong.
     *   IT IS ONE ATTEMPT. Not a loop and not a cascade through the candidate
     *   list, which would turn one bad afternoon into unbounded spend at the
     *   hour nobody is watching.
     *
     * The Scene Ledger deliberately has NO equivalent: its previous state
     * simply stands, which is a correct answer, and paying a dearer model to
     * re-derive "where are we" is not worth it.
     */
    const controlSelection = backgroundCandidate("direct_deepseek")!.selection!;
    const isControl = route.selection.providerId === controlSelection.providerId && route.selection.modelId === controlSelection.modelId;
    if (!attempt.ok && attempt.recoverable && !isControl) {
      console.warn("[memory] falling back to the control after a failed consolidation", JSON.stringify({
        conversationId, requested: route.candidateId, reason: attempt.reason,
      }));
      usedFallback = true;
      attemptedModel = controlSelection.modelId;
      attempt = await attemptConsolidation(controlSelection, {
        task: "memory_consolidation",
        candidate: "direct_deepseek",
        source: route.source,
        fallback: true,
        requestedCandidate: route.candidateId,
        failureReason,
      });
    }

    if (!attempt.ok) {
      /*
       * Both routes are spent. The window stays unconsolidated — the position
       * pointer is only advanced by a successful pass — so a later job can
       * still read it, and the operator is told rather than left to find out
       * from a story with no memories in it.
       */
      await recordBackgroundFailure(userId, conversationId, {
        task: "memory_consolidation", model: attemptedModel,
        candidateId: usedFallback ? "direct_deepseek" : route.candidateId,
        reason: usedFallback ? `${failureReason} → ${attempt.reason}` : attempt.reason,
      });
      return false;
    }
    await recordBackgroundSuccess(userId, conversationId, {
      task: "memory_consolidation", model: attemptedModel,
      candidateId: usedFallback ? "direct_deepseek" : route.candidateId,
      usedFallback,
      /*
       * What the control rescued, recorded even though this attempt succeeded.
       *
       * Otherwise a run of `deepseek_0731_relace` producing malformed JSON and
       * being quietly saved reads, in the drawer, as a perfectly healthy job on
       * DeepSeek — and the candidate under evaluation is never once named as
       * the thing that keeps failing.
       */
      ...(usedFallback ? { rescuedFrom: { model: route.selection.modelId, candidateId: route.candidateId, reason: failureReason } } : {}),
    });
    const data = attempt.data;
    if (!data.summary) return false;

    const createdRecords = await asUser(userId, async (client) => {
      const records: Array<{type:"memory"|"arc";id:string;content:string}> = [];
      /*
       * The position pointer and the intra-message cursor move together.
       *
       * A pass that read a whole number of messages advances the count and
       * clears the offset. A pass that read one chunk of an oversized message
       * advances ONLY the offset — its `size` is zero, so `batchEnd` is
       * unchanged — and the row stays unconsolidated until its final chunk has
       * been read. Persisting both in the same statement is what makes a crash
       * between chunks resume rather than skip.
       */
      await client.query(
        "UPDATE conversations SET summary = $1, last_consolidated_count = GREATEST(last_consolidated_count,$2), last_consolidated_offset = $5, updated_at = now() WHERE id = $3 AND user_id = $4",
        [data.summary!.slice(0, 12000), batchEnd, conversationId, userId, batch.nextOffset],
      );
      // Whatever Scene State observed across this window is stamped onto the
      // derived rows, so a recalled event can later be presented with the day
      // and place it happened rather than as something happening now. Nothing
      // is inferred here: an unobserved window simply stamps nothing.
      const arcSpan = await sceneSpanBetween(client,userId,conversationId,previousCount,batchEnd);
      const stamp = await sceneStampAt(client,userId,conversationId,batchEnd);
      if (data.arcSummary?.trim()) {
        const arcId=randomUUID(); const arcContent=data.arcSummary.trim().slice(0,4000);
        await client.query(
          "INSERT INTO memory_arcs (id,conversation_id,user_id,summary,keywords,start_message_count,end_message_count,story_day_start,story_day_end,scene_locations) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [arcId,conversationId,userId,arcContent,(data.arcKeywords ?? []).slice(0,12),previousCount + 1,batchEnd,arcSpan.storyDayStart,arcSpan.storyDayEnd,arcSpan.locations],
        );
        records.push({type:"arc",id:arcId,content:arcContent});
      }
      const updateableIds = new Set(activeCommitments.filter((memory) => memory.kind === "promise" || memory.kind === "open_loop").map((memory) => memory.id));
      for (const update of (data.memoryUpdates ?? []).slice(0,20)) {
        if (!update.id || !updateableIds.has(update.id) || !["active","resolved"].includes(String(update.status))) continue;
        const status = update.status as "active" | "resolved";
        const resolution = status === "resolved" ? String(update.resolution || "Resolved in the story.").slice(0,1000) : "";
        await client.query(
          "UPDATE memories SET status=$1,resolution=$2,resolved_at=CASE WHEN $1='resolved' THEN now() ELSE NULL END,updated_at=now() WHERE id=$3 AND user_id=$4",
          [status,resolution,update.id,userId],
        );
      }
      const existingResult = await client.query(
        "SELECT * FROM memories WHERE user_id=$3 AND character_id = $1 AND (conversation_id = $2 OR conversation_id IS NULL) ORDER BY created_at DESC",
        [conversation.character_id,conversationId,userId],
      );
      const existing = existingResult.rows.map(memoryFromRow);
      const seenContent = existing.filter((memory) => !(memory.status === "resolved" && (memory.kind === "promise" || memory.kind === "open_loop"))).map((memory) => memory.content);
      const kinds: Memory["kind"][] = ["identity","relationship","event","promise","preference","boundary","open_loop"];
      for (const item of (data.memories ?? []).slice(0, 10)) {
        const content = item.content?.trim();
        if (!content || seenContent.some((stored) => similarity(stored, content) >= 0.72)) continue;
        const kind = kinds.includes(item.kind as Memory["kind"]) ? item.kind : "event";
        seenContent.push(content);
        const memoryId=randomUUID();
        await client.query(
          `INSERT INTO memories (id, character_id, conversation_id, user_id, content, kind, importance, keywords, source_message_count,
             scene_story_day, scene_time_of_day, scene_location, scene_present)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [memoryId, conversation.character_id, conversationId, userId, content.slice(0, 3000), kind, Math.min(5, Math.max(1, Number(item.importance) || 3)), (item.keywords ?? []).slice(0, 12), batchEnd,
            stamp?.storyDay ?? null, stamp?.timeOfDay ?? "", stamp?.location ?? "", stamp?.present ?? []],
        );
        records.push({type:"memory",id:memoryId,content:content.slice(0,3000)});
      }
      return records;
    });
    if (createdRecords.length) await import("./memory-v2").then(({embedContinuityRecords}) => embedContinuityRecords(userId,conversationId,createdRecords)).catch((error) => { console.error("New memory embedding failed",error); return false; });
    return true;
  } finally {
    if (databaseLease) await releaseMemoryJobLease(userId,conversationId,databaseLease).catch(() => undefined);
    activeConsolidations.delete(lockKey);
  }
}
