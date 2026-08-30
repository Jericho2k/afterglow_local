import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asUser, coreCanonFromRow, memoryArcFromRow, memoryFromRow } from "./db";
import { estimateTokens } from "./context";
import { completionWithUsage, embeddingWithUsage, parseJson } from "./llm";
import { acceptedMessageCount, rankArcs, rankMemories } from "./memory";
import { providerModelId, taskModelSelection } from "./provider";
import { recordUsageEvent } from "./usage";
import { acquireMemoryJobLease, releaseMemoryJobLease } from "./memory-jobs";
import { memoryRetrievalV2Enabled, memorySemanticEnabled } from "./memory-flags";
import { isStaleCommitment, protectedTierBudget, protectedTierLimit, recencyScore } from "./memory-scoring";
import type { CoreCanonEntry, Memory, MemoryArc, Message, MemoryKind } from "./types";

const stopWords = new Set(["the","and","that","this","with","from","have","your","you","are","was","for","but","not","they","she","him","her","his","our"]);
const protectedKinds = new Set<MemoryKind>(["promise","boundary","open_loop"]);
const essentialKinds = new Set<MemoryKind>(["identity","relationship","promise","boundary","open_loop"]);

export type RetrievalScoreDetail = {
  type: "memory" | "arc";
  id: string;
  /** What the candidate is. Absent for an arc, which has no kind. */
  kind?: MemoryKind;
  /** Its lifecycle at ranking time, which changes several components below. */
  status?: Memory["status"];
  semantic: number;
  lexical: number;
  importance: number;
  kindStatus: number;
  protectedPinned: number;
  recency: number;
  final: number;
  selected: boolean;
  reason: string[];
  /** Why an unselected candidate did not make it. Empty when it was selected. */
  rejection?: string;
};

export type RetrievalV2Result = {
  coreCanon: CoreCanonEntry[];
  memories: Memory[];
  arcs: MemoryArc[];
  diagnostics: {
    /** The stored `memory_retrieval_runs` row, for admin diagnostics. */
    runId: string;
    semanticAvailable: boolean;
    fallbackReason: string;
    totalStoredMemories: number;
    coreCanonTokens: number;
    episodicTokens: number;
    arcTokens: number;
    scores: RetrievalScoreDetail[];
  };
};

export { memoryRetrievalV2Enabled } from "./memory-flags";

function terms(value: string) {
  const words = value.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [];
  return new Set(words.filter((word) => !stopWords.has(word)).map((word) => {
    if (word.length > 6 && word.endsWith("ing")) return word.slice(0,-3);
    if (word.length > 5 && word.endsWith("ed")) return word.slice(0,-2);
    if (word.length > 5 && word.endsWith("es")) return word.slice(0,-2);
    if (word.length > 4 && word.endsWith("s")) return word.slice(0,-1);
    return word;
  }));
}

function jaccard(left: string, right: string) {
  const a = terms(left); const b = terms(right);
  if (!a.size || !b.size) return 0;
  let shared = 0; a.forEach((term) => { if (b.has(term)) shared += 1; });
  return shared / (a.size + b.size - shared);
}

function clipTokens(value: string, maximum: number) {
  if (estimateTokens(value) <= maximum) return value;
  return `${value.slice(0,Math.max(1,maximum * 4 - 1)).trimEnd()}…`;
}

/**
 * Latest intent is primary; the immediately preceding exchange adds compact
 * scene/entity cues.
 *
 * `sceneCue` is an optional, flag-gated addition from Scene State. It is empty
 * by default so retrieval stays exactly as relevance-driven as it is today.
 */
export function focusedRetrievalQuery(messages: Message[], fallback = "", sceneCue = "") {
  const lastUserIndex = [...messages].map((message) => message.role).lastIndexOf("user");
  const latest = lastUserIndex >= 0 ? messages[lastUserIndex].content : fallback;
  const scene = messages.slice(Math.max(0,lastUserIndex - 2),lastUserIndex).map((message) => message.content).join("\n");
  return [
    `LATEST USER INTENT:\n${clipTokens(latest || fallback,700)}`,
    scene ? `IMMEDIATE SCENE CUES:\n${clipTokens(scene,350)}` : "",
    sceneCue ? clipTokens(sceneCue,120) : "",
  ].filter(Boolean).join("\n\n");
}

export function packCoreCanon(entries: CoreCanonEntry[], budget = 1200) {
  const hardBudget = Math.min(1200,Math.max(1,budget));
  const sorted = entries.filter((entry) => entry.status === "active").sort((a,b) => b.importance - a.importance || a.createdAt.localeCompare(b.createdAt));
  const selected: CoreCanonEntry[] = [];
  let used = 0;
  for (const entry of sorted) {
    const available = hardBudget - used;
    if (available <= 0) break;
    const content = clipTokens(entry.content,Math.max(1,available - 10));
    const cost = estimateTokens(content) + 10;
    if (selected.length && cost > available) continue;
    selected.push({ ...entry, content, tokenCount: cost });
    used += cost;
  }
  return selected;
}

function lexicalComponents(content: string, keywords: string[], input: string) {
  const inputTerms = terms(input); const candidateTerms = terms(`${content} ${keywords.join(" ")}`);
  let overlap = 0; inputTerms.forEach((term) => { if (candidateTerms.has(term)) overlap += 1; });
  const phraseHits = keywords.filter((key) => key && input.toLowerCase().includes(key.toLowerCase())).length;
  return { overlap, phraseHits, score: Math.min(40,phraseHits * 20 + overlap * 4) };
}

/**
 * Hybrid ranking, in three tiers with an explicit budget between them.
 *
 * Two properties changed here, and both are about the GUARANTEED tier rather
 * than about scoring.
 *
 *   THE TIER IS BOUNDED IN TOKENS, NOT ONLY IN COUNT. It used to take up to
 *   twelve entries with no token ceiling of its own, so twelve long
 *   commitments could consume the entire episodic budget and leave nothing for
 *   the scene the reader is actually in. Half the budget is now reserved for
 *   relevance; see `protectedTierBudget`.
 *
 *   A COMMITMENT NOBODY HAS RETURNED TO STOPS BEING GUARANTEED. Not resolved,
 *   not dropped — it competes on relevance like everything else. See
 *   `isStaleCommitment` for why age-since-recorded is the only usable signal.
 *
 * Nothing about a boundary changed: boundaries are never stale and never lose
 * their slot. That is the durability the tier exists for.
 */
export function hybridRankMemories(memories: Memory[], input: string, semanticScores: Map<string,number>, limit = 8, tokenBudget = 4200, now = Date.now()) {
  const scored = memories.filter((memory) => memory.status !== "superseded").map((memory) => {
    const lexical = lexicalComponents(memory.content,memory.keywords,input);
    const semantic = Math.max(0,Math.min(1,semanticScores.get(memory.id) ?? 0));
    const importance = memory.importance * 3;
    const kindStatus = (essentialKinds.has(memory.kind) ? 7 : memory.kind === "event" ? 2 : 0) + (memory.status === "active" ? 2 : -2);
    const stale = isStaleCommitment(memory,now);
    const protectedPinned = (memory.pinned ? 35 : 0) + (memory.status === "active" && protectedKinds.has(memory.kind) && !stale ? 20 : 0);
    const recency = recencyScore(memory,now);
    const final = semantic * 45 + lexical.score + importance + kindStatus + protectedPinned + recency;
    const reason = [semantic >= .25 ? "semantic" : "",lexical.score > 0 ? "lexical" : "",memory.pinned ? "pinned" : "",protectedKinds.has(memory.kind) && memory.status === "active" && !stale ? "protected" : "",stale ? "stale_commitment" : "",memory.importance >= 4 ? "important" : ""].filter(Boolean);
    return { memory, semantic, lexical:lexical.score, importance, kindStatus, protectedPinned, recency, final, reason, stale };
  }).sort((a,b) => b.final - a.final || a.memory.id.localeCompare(b.memory.id));

  const selected: Memory[] = []; let used = 0; let dynamic = 0;
  const rejected = new Map<string,string>();
  const add = (row: typeof scored[number], guaranteed = false) => {
    if (selected.some((memory) => memory.id === row.memory.id)) return false;
    if (!guaranteed && selected.some((memory) => jaccard(memory.content,row.memory.content) >= .72)) { rejected.set(row.memory.id,"duplicate"); return false; }
    const cost = estimateTokens(`${row.memory.content} ${row.memory.resolution}`) + 16;
    if (selected.length && used + cost > tokenBudget) { rejected.set(row.memory.id,"token_budget"); return false; }
    selected.push(row.memory); used += cost; return true;
  };
  // A pinned memory is the reader's own instruction and outranks every budget
  // rule below it, exactly as before.
  scored.filter((row) => row.memory.pinned).forEach((row) => add(row,true));
  const guaranteedBudget = protectedTierBudget(tokenBudget);
  let guaranteedTokens = 0; let guaranteedCount = 0;
  for (const row of scored) {
    if (guaranteedCount >= protectedTierLimit) break;
    const { memory } = row;
    if (memory.pinned || memory.status !== "active" || !protectedKinds.has(memory.kind) || row.stale) continue;
    const cost = estimateTokens(`${memory.content} ${memory.resolution}`) + 16;
    if (guaranteedCount > 0 && guaranteedTokens + cost > guaranteedBudget) { rejected.set(memory.id,"protected_tier_full"); continue; }
    if (add(row,true)) { guaranteedCount += 1; guaranteedTokens += cost; }
  }
  for (const row of scored) {
    if (dynamic >= limit) break;
    if (selected.some((memory) => memory.id === row.memory.id)) continue;
    const relevant = row.semantic >= .25 || row.lexical > 0 || (row.memory.status === "active" && (row.memory.importance >= 4 || essentialKinds.has(row.memory.kind)));
    if (!relevant) { rejected.set(row.memory.id,"not_relevant"); continue; }
    if (add(row)) dynamic += 1;
  }
  const ids = new Set(selected.map((memory) => memory.id));
  return {
    selected,
    details: scored.slice(0,80).map((row):RetrievalScoreDetail => ({ type:"memory",id:row.memory.id,kind:row.memory.kind,status:row.memory.status,semantic:row.semantic,lexical:row.lexical,importance:row.importance,kindStatus:row.kindStatus,protectedPinned:row.protectedPinned,recency:row.recency,final:row.final,selected:ids.has(row.memory.id),reason:row.reason,rejection:ids.has(row.memory.id)?"":(rejected.get(row.memory.id)??(dynamic>=limit?"slot_limit":"")) })),
  };
}

export function hybridRankArcs(arcs: MemoryArc[], input: string, semanticScores: Map<string,number>, limit = 4, tokenBudget = 1400) {
  const scored = arcs.map((arc) => {
    const lexical = lexicalComponents(arc.summary,arc.keywords,input);
    const semantic = Math.max(0,Math.min(1,semanticScores.get(arc.id) ?? 0));
    const ageDays = Math.max(0,(Date.now() - new Date(arc.createdAt).getTime()) / 86_400_000);
    const recency = 2 / (1 + ageDays / 90);
    return { arc,semantic,lexical:lexical.score,recency,final:semantic * 45 + lexical.score + recency };
  }).filter((row) => row.semantic >= .22 || row.lexical > 0).sort((a,b) => b.final - a.final || a.arc.id.localeCompare(b.arc.id));
  const selected: MemoryArc[] = []; let used = 0;
  const arcRejected = new Map<string,string>();
  for (const row of scored) {
    if (selected.some((arc) => jaccard(arc.summary,row.arc.summary) >= .72)) { arcRejected.set(row.arc.id,"duplicate"); continue; }
    const cost = estimateTokens(row.arc.summary) + 12;
    if (selected.length && used + cost > tokenBudget) { arcRejected.set(row.arc.id,"token_budget"); continue; }
    selected.push(row.arc); used += cost;
    if (selected.length >= limit) break;
  }
  const ids = new Set(selected.map((arc) => arc.id));
  return {
    selected,
    details: scored.slice(0,60).map((row):RetrievalScoreDetail => ({ type:"arc",id:row.arc.id,semantic:row.semantic,lexical:row.lexical,importance:0,kindStatus:0,protectedPinned:0,recency:row.recency,final:row.final,selected:ids.has(row.arc.id),reason:[row.semantic >= .22 ? "semantic":"",row.lexical > 0 ? "lexical":""].filter(Boolean),rejection:ids.has(row.arc.id)?"":(arcRejected.get(row.arc.id)??"slot_limit") })),
  };
}

function embeddingModel() { return process.env.MEMORY_EMBEDDING_MODEL?.trim() || "qwen/qwen3-embedding-8b"; }
function embeddingDimensions() { return Math.min(1024,Math.max(128,Number(process.env.MEMORY_EMBEDDING_DIMENSIONS) || 1024)); }
function vectorLiteral(values: number[]) { return `[${values.map((value) => Number.isFinite(value) ? Number(value).toFixed(8) : "0").join(",")}]`; }

async function semanticScores(userId: string, conversationId: string, characterId: string, query: string) {
  const embedded = await embeddingWithUsage(query,{ model:embeddingModel(),dimensions:embeddingDimensions() });
  if (embedded.usage) await recordUsageEvent({ userId,conversationId,providerId:"openrouter",model:embeddingModel(),actualModel:embedded.model,kind:"embedding",taskRoute:"memory_retrieval_query",usage:embedded.usage }).catch(() => undefined);
  const vector = vectorLiteral(embedded.embeddings[0]);
  return asUser(userId,async (client) => {
    const [memoryResult,arcResult] = await Promise.all([
      client.query(
        `SELECT me.memory_id AS id,GREATEST(0,1-(me.embedding <=> $4::extensions.vector)) AS similarity
         FROM memory_embeddings me JOIN memories m ON m.id=me.memory_id
         WHERE me.user_id=$1 AND m.character_id=$2 AND (m.conversation_id=$3 OR m.conversation_id IS NULL)
         ORDER BY me.embedding <=> $4::extensions.vector LIMIT 64`,[userId,characterId,conversationId,vector]),
      client.query(
        `SELECT mae.arc_id AS id,GREATEST(0,1-(mae.embedding <=> $3::extensions.vector)) AS similarity
         FROM memory_arc_embeddings mae WHERE mae.user_id=$1 AND mae.conversation_id=$2
         ORDER BY mae.embedding <=> $3::extensions.vector LIMIT 32`,[userId,conversationId,vector]),
    ]);
    return {
      memories:new Map(memoryResult.rows.map((row) => [String(row.id),Number(row.similarity)])),
      arcs:new Map(arcResult.rows.map((row) => [String(row.id),Number(row.similarity)])),
    };
  });
}

export async function retrieveContinuityV2(input: { userId:string;characterId:string;conversationId:string;query:string;messageId?:string|null;limit?:number;tokenBudget?:number }) : Promise<RetrievalV2Result> {
  const started = Date.now(); const tokenBudget = Math.max(1000,input.tokenBudget ?? 6000);
  const archive = await asUser(input.userId,async (client) => {
    const [memoryResult,arcResult,canonResult] = await Promise.all([
      client.query("SELECT * FROM memories WHERE user_id=$3 AND character_id=$1 AND (conversation_id=$2 OR conversation_id IS NULL) ORDER BY pinned DESC,created_at DESC",[input.characterId,input.conversationId,input.userId]),
      client.query("SELECT * FROM memory_arcs WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC",[input.conversationId,input.userId]),
      client.query("SELECT * FROM core_canon_entries WHERE conversation_id=$1 AND user_id=$2 AND status='active' ORDER BY importance DESC,created_at ASC",[input.conversationId,input.userId]),
    ]);
    return { memories:memoryResult.rows.map(memoryFromRow),arcs:arcResult.rows.map(memoryArcFromRow),canon:canonResult.rows.map(coreCanonFromRow) };
  });
  const canonBudget = Math.min(Number(process.env.MEMORY_CANON_TOKEN_BUDGET) || 1200,1200,Math.floor(tokenBudget * .3));
  const coreCanon = packCoreCanon(archive.canon,canonBudget);
  const coreTokens = coreCanon.reduce((sum,entry) => sum + entry.tokenCount,0);
  const remaining = Math.max(500,tokenBudget - coreTokens);
  const arcBudget = Math.min(1600,Math.max(400,Math.floor(remaining * .25)));
  const episodicBudget = Math.max(500,remaining - arcBudget);
  let semanticAvailable = false; let fallbackReason = ""; let semantic = { memories:new Map<string,number>(),arcs:new Map<string,number>() };
  if (memorySemanticEnabled()) {
    try { semantic = await semanticScores(input.userId,input.conversationId,input.characterId,input.query); semanticAvailable = true; }
    catch (error) { fallbackReason = error instanceof Error ? error.message.slice(0,240) : "Semantic retrieval unavailable"; }
  } else fallbackReason = "Semantic retrieval disabled";

  const rankedMemories = semanticAvailable
    ? hybridRankMemories(archive.memories,input.query,semantic.memories,input.limit ?? 8,episodicBudget)
    : { selected:rankMemories(archive.memories,input.query,input.limit ?? 8,episodicBudget),details:[] as RetrievalScoreDetail[] };
  const rankedArcs = semanticAvailable
    ? hybridRankArcs(archive.arcs,input.query,semantic.arcs,4,arcBudget)
    : { selected:rankArcs(archive.arcs,input.query,4,arcBudget),details:[] as RetrievalScoreDetail[] };
  const episodicTokens = rankedMemories.selected.reduce((sum,memory) => sum + estimateTokens(`${memory.content} ${memory.resolution}`) + 16,0);
  const arcTokens = rankedArcs.selected.reduce((sum,arc) => sum + estimateTokens(arc.summary) + 12,0);
  const runId = randomUUID();
  const diagnostics = { runId,semanticAvailable,fallbackReason,totalStoredMemories:archive.memories.length,coreCanonTokens:coreTokens,episodicTokens,arcTokens,scores:[...rankedMemories.details,...rankedArcs.details] };
  await asUser(input.userId,async (client) => {
    if (rankedMemories.selected.length) await client.query("UPDATE memories SET last_recalled_at=now(),recall_count=recall_count+1 WHERE id=ANY($1::uuid[]) AND user_id=$2",[rankedMemories.selected.map((memory) => memory.id),input.userId]);
    await client.query(
      `INSERT INTO memory_retrieval_runs
       (id,conversation_id,user_id,message_id,retrieval_version,semantic_available,fallback_reason,total_stored_memories,core_canon_tokens,retrieved_episodic_tokens,arc_tokens,recalled_memory_ids,recalled_arc_ids,score_details,latency_ms)
       VALUES ($1,$2,$3,$4,'v2',$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
      [runId,input.conversationId,input.userId,input.messageId ?? null,semanticAvailable,fallbackReason,archive.memories.length,coreTokens,episodicTokens,arcTokens,rankedMemories.selected.map((memory) => memory.id),rankedArcs.selected.map((arc) => arc.id),JSON.stringify(diagnostics.scores),Date.now()-started],
    );
  }).catch((error) => console.error("Memory V2 diagnostics failed",error));
  return { coreCanon,memories:rankedMemories.selected,arcs:rankedArcs.selected,diagnostics };
}

async function saveEmbeddings(userId:string,conversationId:string,records:Array<{type:"memory"|"arc";id:string;content:string}>) {
  if (!records.length) return;
  const result = await embeddingWithUsage(records.map((record) => record.content),{model:embeddingModel(),dimensions:embeddingDimensions()});
  if (result.usage) await recordUsageEvent({userId,conversationId,providerId:"openrouter",model:embeddingModel(),actualModel:result.model,kind:"embedding",taskRoute:"memory_embedding_backfill",usage:result.usage}).catch(()=>undefined);
  await asUser(userId,async (client) => {
    for (let index=0;index<records.length;index+=1) {
      const record=records[index]; const embedding=result.embeddings[index]; if (!embedding) continue;
      const hash=createHash("sha256").update(record.content).digest("hex"); const vector=vectorLiteral(embedding);
      if (record.type === "memory") await client.query(
        `INSERT INTO memory_embeddings (memory_id,user_id,embedding,embedding_model,content_hash) VALUES ($1,$2,$3::extensions.vector,$4,$5)
         ON CONFLICT (memory_id) DO UPDATE SET embedding=EXCLUDED.embedding,embedding_model=EXCLUDED.embedding_model,content_hash=EXCLUDED.content_hash,updated_at=now()`,[record.id,userId,vector,result.model,hash]);
      else await client.query(
        `INSERT INTO memory_arc_embeddings (arc_id,user_id,conversation_id,embedding,embedding_model,content_hash) VALUES ($1,$2,$3,$4::extensions.vector,$5,$6)
         ON CONFLICT (arc_id) DO UPDATE SET embedding=EXCLUDED.embedding,embedding_model=EXCLUDED.embedding_model,content_hash=EXCLUDED.content_hash,updated_at=now()`,[record.id,userId,conversationId,vector,result.model,hash]);
    }
  });
}

/**
 * Drops the stored vector for one memory.
 *
 * Called when a memory's text changes or it is superseded. The alternative —
 * leaving the vector and letting the backfill catch up — means the OLD wording
 * keeps answering semantic queries in the meantime, so the archive and the
 * prompt disagree about what the memory says. No vector is a smaller lie than
 * the wrong vector: retrieval falls back to lexical scoring for this one row
 * until the backfill re-embeds it, which it does unprompted because the content
 * hash no longer matches.
 *
 * Best effort, and deliberately outside the caller's transaction. The durable
 * guarantee is elsewhere: `maybeBackfillMemoryEmbeddings` compares a content
 * hash, so an edited memory is re-embedded on the next maintenance pass whether
 * or not this succeeded. This only closes the window in between, so a
 * deployment without the vector tables must not fail an ordinary memory edit
 * because of it.
 */
export async function forgetMemoryEmbedding(userId: string, memoryId: string) {
  await asUser(userId, (client) => client.query("DELETE FROM memory_embeddings WHERE memory_id=$1 AND user_id=$2",[memoryId,userId]))
    .catch((error) => console.warn("Embedding invalidation skipped", error instanceof Error ? error.message : error));
}

export async function embedContinuityRecords(userId:string,conversationId:string,records:Array<{type:"memory"|"arc";id:string;content:string}>) {
  if (!memoryRetrievalV2Enabled(userId) || !memorySemanticEnabled()) return false;
  await saveEmbeddings(userId,conversationId,records.slice(0,64)); return true;
}

export async function maybeBackfillMemoryEmbeddings(userId:string,conversationId:string,limit=48) {
  if (!memoryRetrievalV2Enabled(userId) || !memorySemanticEnabled()) return false;
  const lease=await acquireMemoryJobLease(userId,conversationId,"embedding_backfill",300); if (!lease) return false;
  try {
    const records=await asUser(userId,async (client) => {
      const memories=await client.query(
        `SELECT m.id,m.content,me.content_hash FROM memories m LEFT JOIN memory_embeddings me ON me.memory_id=m.id
         JOIN conversations c ON c.id=$1 AND c.user_id=$2
         WHERE m.user_id=$2 AND m.character_id=c.character_id AND (m.conversation_id=$1 OR m.conversation_id IS NULL)
         ORDER BY (me.memory_id IS NULL) DESC,m.pinned DESC,m.importance DESC,m.updated_at DESC LIMIT $3`,[conversationId,userId,limit*4]);
      const arcs=await client.query(
        `SELECT a.id,a.summary AS content,ae.content_hash FROM memory_arcs a LEFT JOIN memory_arc_embeddings ae ON ae.arc_id=a.id
         WHERE a.conversation_id=$1 AND a.user_id=$2 ORDER BY (ae.arc_id IS NULL) DESC,a.created_at DESC LIMIT $3`,[conversationId,userId,limit*4]);
      const stale=(row:Record<string,unknown>)=>String(row.content_hash||"")!==createHash("sha256").update(String(row.content)).digest("hex");
      const memoryRecords=memories.rows.filter(stale).slice(0,limit).map((row)=>({type:"memory" as const,id:String(row.id),content:String(row.content)}));
      const arcRecords=arcs.rows.filter(stale).slice(0,Math.max(0,limit-memoryRecords.length)).map((row)=>({type:"arc" as const,id:String(row.id),content:String(row.content)}));
      return [...memoryRecords,...arcRecords];
    });
    if (!records.length) return false;
    await saveEmbeddings(userId,conversationId,records); return true;
  } finally { await releaseMemoryJobLease(userId,conversationId,lease).catch(()=>undefined); }
}

type CanonCuration = {
  promote?: Array<{content?:string;category?:MemoryKind;importance?:number;sourceMemoryIds?:string[];sourceArcIds?:string[]}>;
  supersedeIds?: string[];
  demoteIds?: string[];
};

export type CanonPlanAddition = {id:string;content:string;category:MemoryKind;importance:number;sourceMemoryIds:string[];sourceArcIds:string[];sourceMessageCount:number;tokens:number};

/** Applies only derived canon changes. It intentionally has no archive DELETE. */
export async function applyCanonPlan(client:PoolClient,input:{userId:string;conversationId:string;characterId:string;messageCount:number;currentVersion:number;supersede:string[];demote:string[];additions:CanonPlanAddition[]}) {
  for (const id of input.supersede) await client.query("UPDATE core_canon_entries SET status='superseded',updated_at=now() WHERE user_id=$1 AND id=$2",[input.userId,id]);
  for (const id of input.demote) await client.query("UPDATE core_canon_entries SET status='demoted',updated_at=now() WHERE user_id=$1 AND id=$2",[input.userId,id]);
  const version=input.currentVersion+1;
  for (const entry of input.additions) await client.query(
    `INSERT INTO core_canon_entries (id,conversation_id,character_id,user_id,content,category,importance,status,source_memory_ids,source_arc_ids,source_message_count,token_count,curation_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12)`,[entry.id,input.conversationId,input.characterId,input.userId,entry.content,entry.category,entry.importance,entry.sourceMemoryIds,entry.sourceArcIds,entry.sourceMessageCount,entry.tokens,version]);
  await client.query("UPDATE conversations SET last_curated_message_count=$1,canon_version=$2,updated_at=now() WHERE id=$3 AND user_id=$4",[input.messageCount,version,input.conversationId,input.userId]);
}

function curationPrompt(canon:CoreCanonEntry[],memories:Memory[],arcs:MemoryArc[]) {
  return `Curate a tiny CORE CANON for an ongoing roleplay. Output JSON only. The permanent archive below must never be deleted.

Core canon contains only facts the story cannot afford to forget: defining relationships and motivations, foundational shared events, permanent boundaries/status changes, essential NPC relationships, and long-running unresolved goals. Prefer 300-800 tokens total; never exceed 1200. Avoid transient scene details and paraphrase duplicates.

Return {"promote":[{"content":"compact durable fact","category":"identity|relationship|event|promise|preference|boundary|open_loop","importance":1-5,"sourceMemoryIds":[],"sourceArcIds":[]}],"supersedeIds":[],"demoteIds":[]}.
Use only supplied IDs. supersedeIds is for entries replaced/merged by a new entry. demoteIds is for entries no longer foundational. Omit unchanged canon entries from promote.

CURRENT CANON
${canon.length?canon.map((entry)=>`- ${entry.id} [${entry.category}] ${entry.content}`).join("\n"):"- None"}

HIGH-VALUE EPISODIC ARCHIVE
${memories.map((memory)=>`- ${memory.id} [${memory.kind};${memory.status};importance ${memory.importance}] ${memory.content}${memory.resolution?` (resolved: ${memory.resolution})`:""}`).join("\n")||"- None"}

HISTORICAL ARCS
${arcs.map((arc)=>`- ${arc.id} ${arc.summary}`).join("\n")||"- None"}`;
}

export async function maybeCurateCanon(userId:string,conversationId:string,force=false) {
  if (!memoryRetrievalV2Enabled(userId)) return false;
  const lease=await acquireMemoryJobLease(userId,conversationId,"curation",480); if (!lease) return false;
  try {
    const prepared=await asUser(userId,async (client) => {
      const conversation=(await client.query("SELECT * FROM conversations WHERE id=$1 AND user_id=$2",[conversationId,userId])).rows[0];
      if (!conversation) return null;
      const interval=Math.min(150,Math.max(75,Number(process.env.MEMORY_CURATION_INTERVAL_MESSAGES)||100));
      const latest=(await client.query("SELECT role FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[conversationId,userId])).rows[0];
      const messageCount=acceptedMessageCount(Number(conversation.message_count||0),latest?.role as Message["role"] | undefined);
      const last=Number(conversation.last_curated_message_count||0);
      const canonCount=Number((await client.query("SELECT COUNT(*) count FROM core_canon_entries WHERE conversation_id=$1 AND user_id=$2 AND status='active'",[conversationId,userId])).rows[0]?.count||0);
      // Establish the first compact canon early enough to matter, then return
      // to the bounded 75–150 message maintenance cadence.
      const due = canonCount === 0 ? messageCount >= 24 : messageCount-last >= interval;
      if (!force && !due) return null;
      const [canonResult,memoryResult,arcResult]=await Promise.all([
        client.query("SELECT * FROM core_canon_entries WHERE conversation_id=$1 AND user_id=$2 AND status='active' ORDER BY importance DESC,created_at ASC",[conversationId,userId]),
        client.query("SELECT * FROM memories WHERE user_id=$2 AND character_id=$3 AND (conversation_id=$1 OR conversation_id IS NULL) AND status<>'superseded' ORDER BY pinned DESC,importance DESC,created_at DESC LIMIT 100",[conversationId,userId,conversation.character_id]),
        client.query("SELECT * FROM memory_arcs WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 24",[conversationId,userId]),
      ]);
      return {conversation,messageCount,canon:canonResult.rows.map(coreCanonFromRow),memories:memoryResult.rows.map(memoryFromRow),arcs:arcResult.rows.map(memoryArcFromRow)};
    });
    if (!prepared) return false;
    const selection=taskModelSelection("memory_curation"); const rpEngineId=String(prepared.conversation.rp_engine_id||"immersive");
    const response=await completionWithUsage(selection,[
      {role:"system",content:"You are a conservative continuity canon curator. Return valid JSON only."},
      {role:"user",content:curationPrompt(prepared.canon,prepared.memories,prepared.arcs)},
    ],{json:true,maxTokens:2600,temperature:.15});
    if (response.usage) await recordUsageEvent({userId,conversationId,providerId:selection.providerId,model:selection.modelId,actualModel:providerModelId(selection.providerId,selection.modelId)??selection.modelId,rpEngineId,kind:"memory_curation",taskRoute:"memory_curation",usage:response.usage});
    const data=parseJson<CanonCuration>(response.content);
    const canonIds=new Set(prepared.canon.map((entry)=>entry.id)); const memoryIds=new Set(prepared.memories.map((memory)=>memory.id)); const arcIds=new Set(prepared.arcs.map((arc)=>arc.id));
    const supersede=(data.supersedeIds??[]).filter((id)=>canonIds.has(id)); const demote=(data.demoteIds??[]).filter((id)=>canonIds.has(id)&&!supersede.includes(id));
    const categories:MemoryKind[]=["identity","relationship","event","promise","preference","boundary","open_loop"];
    const remaining=prepared.canon.filter((entry)=>!supersede.includes(entry.id)&&!demote.includes(entry.id));
    const hardBudget=Math.min(1200,Math.max(300,Number(process.env.MEMORY_CANON_TOKEN_BUDGET)||1200)); let used=remaining.reduce((sum,entry)=>sum+estimateTokens(entry.content)+10,0);
    const additions:CanonPlanAddition[]=[];
    for (const proposed of (data.promote??[]).slice(0,30)) {
      let content=String(proposed.content||"").trim(); if (!content || remaining.some((entry)=>jaccard(entry.content,content)>=.72)||additions.some((entry)=>jaccard(entry.content,content)>=.72)) continue;
      const available=hardBudget-used; if (available<=12) break; content=clipTokens(content,available-10); const tokens=estimateTokens(content)+10; if (used+tokens>hardBudget) continue;
      const sourceMemoryIds=(proposed.sourceMemoryIds??[]).filter((id)=>memoryIds.has(id)); const sourceArcIds=(proposed.sourceArcIds??[]).filter((id)=>arcIds.has(id));
      const sourceMessageCount=Math.max(0,...sourceMemoryIds.map((id)=>prepared.memories.find((memory)=>memory.id===id)?.sourceMessageCount||0),...sourceArcIds.map((id)=>prepared.arcs.find((arc)=>arc.id===id)?.endMessageCount||0));
      additions.push({id:randomUUID(),content,category:categories.includes(proposed.category as MemoryKind)?proposed.category as MemoryKind:"event",importance:Math.min(5,Math.max(1,Number(proposed.importance)||4)),sourceMemoryIds,sourceArcIds,sourceMessageCount,tokens}); used+=tokens;
    }
    await asUser(userId,(client)=>applyCanonPlan(client,{userId,conversationId,characterId:String(prepared.conversation.character_id),messageCount:prepared.messageCount,currentVersion:Number(prepared.conversation.canon_version||0),supersede,demote,additions}));
    return true;
  } finally { await releaseMemoryJobLease(userId,conversationId,lease).catch(()=>undefined); }
}

/** Used by branch/edit invalidation without deleting the underlying archive. */
export async function invalidateCanonAfter(client:PoolClient,conversationId:string,validThroughPosition:number,userId?:string) {
  const owner=userId??null; const position=Math.max(0,validThroughPosition);
  await client.query("UPDATE core_canon_entries SET status='superseded',updated_at=now() WHERE conversation_id=$1 AND source_message_count>$2 AND ($3::uuid IS NULL OR user_id=$3)",[conversationId,position,owner]);
  await client.query("UPDATE conversations SET last_curated_message_count=LEAST(last_curated_message_count,$1),canon_version=canon_version+1 WHERE id=$2 AND ($3::uuid IS NULL OR user_id=$3)",[position,conversationId,owner]);
}
