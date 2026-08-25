import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hybridRankArcs, hybridRankMemories } from "@/lib/memory-v2";
import { roleplayPrompt } from "@/lib/prompts";
import { focusedRetrievalQuery } from "@/lib/memory-v2";
import { assessEvidence, promptRegions } from "@/lib/eval/evidence";
import { crossVerdict } from "@/lib/eval/taxonomy";
import { decisionReadiness, formatSummary, summarize, type EvaluatedTurn } from "@/lib/eval/report";
import { judgeEnabled, judgeTurn } from "@/lib/eval/judge";
import {
  archiveAsOf, claimsFromMemories, establishedFacts, labelKey, obsoleteFacts, selectCheckpoints,
  type BackupFile, type CheckpointLabels,
} from "@/lib/eval/replay";
import { streamCompletion } from "@/lib/llm";
import { responseLengthPlan } from "@/lib/response-length";
import { inferenceSessionId } from "@/lib/inference-session";
import type { Character, Memory, MemoryArc, Message } from "@/lib/types";

/**
 * The ecological half of the V2.1a gate.
 *
 * Skipped unless pointed at a backup export, so CI never depends on private
 * data or on paid inference. Run it locally:
 *
 *   EVAL_BACKUP=./afterglow-backup.json npx vitest run tests/eval/replay.test.ts
 *
 * That alone answers stage one on real stories — was the continuity each turn
 * needed actually in the prompt — with no model calls at all. Adding
 * `EVAL_GENERATE=true` regenerates each checkpoint through the real writer, and
 * `EVAL_JUDGE=true` audits those generations, which is what produces the
 * retrieval-versus-writer split the sprint gate is waiting on.
 *
 * Optional `EVAL_LABELS=./labels.json` supplies hand-written expected facts per
 * checkpoint; hand labels beat derived ones and take precedence where present.
 */

const backupPath = process.env.EVAL_BACKUP ?? "";
const describeReplay = backupPath ? describe : describe.skip;

function loadBackup(): BackupFile {
  return JSON.parse(readFileSync(backupPath, "utf8")) as BackupFile;
}

function loadLabels(): CheckpointLabels {
  const path = process.env.EVAL_LABELS;
  if (!path) return {};
  return JSON.parse(readFileSync(path, "utf8")) as CheckpointLabels;
}

async function generate(character: Character, system: string, history: Message[], userTurn: string) {
  const stream = await streamCompletion(
    {
      providerId: process.env.EVAL_PROVIDER ?? "deepseek",
      modelId: process.env.EVAL_MODEL ?? "deepseek-v4-flash",
    },
    [
      { role: "system", content: system },
      ...history.map((message) => ({ role: message.role, content: message.content })),
      { role: "user" as const, content: userTurn },
    ],
    {
      maxTokens: responseLengthPlan("natural", 1800).maxTokens,
      temperature: 0.95,
      sessionId: inferenceSessionId("rp_generation", `eval:${character.id}`),
    },
  );

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const delta = (JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> })
          .choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
      } catch { /* ignore malformed chunks */ }
    }
  }
  return text;
}

describeReplay("replayed conversations", () => {
  it("attributes continuity failures across real checkpoints", async () => {
    const backup = loadBackup();
    const labels = loadLabels();
    const turns: EvaluatedTurn[] = [];

    const byConversation = new Map<string, Message[]>();
    for (const message of backup.messages) {
      const list = byConversation.get(message.conversationId) ?? [];
      list.push(message);
      byConversation.set(message.conversationId, list);
    }

    const maxConversations = Number(process.env.EVAL_CONVERSATIONS ?? 5);
    const conversations = backup.conversations
      .map((row) => ({ id: String(row.id), characterId: String(row.characterId ?? row.character_id) }))
      .filter((row) => (byConversation.get(row.id)?.length ?? 0) > Number(process.env.EVAL_MIN_MESSAGES ?? 40))
      .slice(0, maxConversations);

    expect(conversations.length, "no conversation in the backup is long enough to be worth replaying").toBeGreaterThan(0);

    for (const conversation of conversations) {
      const messages = (byConversation.get(conversation.id) ?? [])
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const characterRow = backup.characters.find((entry) => entry.id === conversation.characterId);
      if (!characterRow) continue;
      const character = characterRow.data as unknown as Character;

      const allMemories = (backup.memories ?? []).filter((memory) => memory.conversationId === conversation.id || memory.conversationId === null);
      const allArcs = (backup.arcs ?? []).filter((arc) => arc.conversationId === conversation.id);

      for (const checkpoint of selectCheckpoints(conversation.id, messages, {
        every: Number(process.env.EVAL_EVERY ?? 12),
        minPriorMessages: Number(process.env.EVAL_MIN_PRIOR ?? 40),
        max: Number(process.env.EVAL_CHECKPOINTS ?? 8),
      })) {
        const archive = archiveAsOf(allMemories, allArcs, checkpoint.priorMessageCount);
        const history = messages.slice(Math.max(0, checkpoint.index - 30), checkpoint.index);

        // The real retrieval query and the real ranker. Semantic scores are
        // absent offline, so this measures the lexical/importance path — which
        // is also the path a deployment without embeddings actually runs.
        const query = focusedRetrievalQuery(history, checkpoint.userTurn);
        const ranked = hybridRankMemories(archive.memories, query, new Map(), 8, 3600);
        const rankedArcs = hybridRankArcs(archive.arcs, query, new Map(), 4, 1200);

        const system = roleplayPrompt(character, "", ranked.selected, rankedArcs.selected, undefined, {});

        const label = labels[labelKey(checkpoint)];
        const derived = establishedFacts(archive.memories, checkpoint.priorMessageCount);
        const required = label?.facts
          ? label.facts.map((fact, position) => ({ id: `label-${position}`, description: "hand-labelled", anyOf: [fact] }))
          : claimsFromMemories(derived);
        const obsolete = label?.obsolete ?? obsoleteFacts(archive.memories, checkpoint.priorMessageCount).map((memory) => memory.content);

        const regions = promptRegions(system, history.map((message) => `${message.role}: ${message.content}`));
        const evidence = assessEvidence(regions, required, obsolete.map((fact, position) => ({
          id: `obsolete-${position}`, description: "no longer authoritative", anyOf: [fact],
        })));

        let outcome: "clean" | "error" = "clean";
        let categories: Parameters<typeof crossVerdict>[0]["categories"];
        let rationale = "";

        if (process.env.EVAL_GENERATE === "true") {
          const reply = await generate(character, system, history, checkpoint.userTurn);
          if (judgeEnabled()) {
            const judged = await judgeTurn({
              characterName: character.name,
              facts: required.flatMap((claim) => claim.anyOf),
              obsolete,
              recentTranscript: history.slice(-6).map((message) => `${message.role}: ${message.content}`),
              userTurn: checkpoint.userTurn,
              reply,
            });
            outcome = judged.outcome;
            categories = judged.categories;
            rationale = judged.rationale;
          }
        }

        turns.push({
          id: labelKey(checkpoint),
          label: `${character.name} @ message ${checkpoint.index}`,
          verdict: crossVerdict({
            evidence: evidence.verdict,
            outcome: evidence.contaminants.length ? "error" : outcome,
            fromRetrieval: evidence.fromRetrieval,
            contaminated: evidence.contaminants.length > 0,
            categories,
          }),
          // Identifiers and counts only. No transcript, no prompt, no reply.
          attributionRef: {
            recalledMemoryIds: ranked.selected.map((memory) => memory.id),
            recalledArcIds: rankedArcs.selected.map((arc) => arc.id),
            writerModel: process.env.EVAL_MODEL ?? "deepseek-v4-flash",
            episodicTokens: ranked.selected.length,
            arcTokens: rankedArcs.selected.length,
          },
          notes: rationale || undefined,
        });
      }
    }

    const summary = summarize(turns);
    const readiness = decisionReadiness(summary);
    console.log(`\n${formatSummary(summary, `Replayed checkpoints (${backupPath})`)}\n`);
    console.log(`decision readiness: ${readiness.ready ? "READY" : "NOT READY"} — ${readiness.reason}\n`);

    // The gate reports; it does not fail the build on a quality number. The
    // only assertion is that it actually measured something, because a run
    // that silently evaluated zero turns would look like good news.
    expect(summary.total).toBeGreaterThan(0);
  }, 600_000);
});

/**
 * The pieces of the replay path that can be checked without any data at all.
 * These run in CI and guard the part most likely to invalidate a whole run:
 * accidentally showing a checkpoint something it could not have known.
 */
describe("replay checkpoint selection", () => {
  const message = (index: number, role: Message["role"]): Message => ({
    id: `m${index}`, conversationId: "c", role, content: `turn ${index}`,
    variants: [], selectedVariant: 0, memoryIds: [], arcIds: [],
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  });
  const messages = Array.from({ length: 120 }, (_, index) => message(index, index % 2 === 0 ? "user" : "assistant"));

  it("samples late turns, where continuity is actually load-bearing", () => {
    const checkpoints = selectCheckpoints("c", messages, { every: 12, minPriorMessages: 40, max: 8 });
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      expect(checkpoint.index).toBeGreaterThanOrEqual(40);
      // Every checkpoint is a user turn with a reply after it, or there is
      // nothing to regenerate and nothing to compare against.
      expect(messages[checkpoint.index].role).toBe("user");
      expect(messages[checkpoint.index + 1].role).toBe("assistant");
    }
  });

  it("never lets a checkpoint see continuity derived from its own future", () => {
    const memories: Memory[] = [80, 200].map((source) => ({
      id: `mem-${source}`, characterId: "x", conversationId: "c",
      content: `fact from ${source}`, kind: "identity", importance: 4, keywords: [],
      pinned: false, status: "active", resolution: "", resolvedAt: null,
      lastRecalledAt: null, recallCount: 0, sourceMessageCount: source, scene: null,
      createdAt: new Date(0).toISOString(),
    }));
    const arcs: MemoryArc[] = [{
      id: "arc-late", conversationId: "c", summary: "later chapter", keywords: [],
      startMessageCount: 150, endMessageCount: 200,
      storyDayStart: null, storyDayEnd: null, locations: [],
      createdAt: new Date(0).toISOString(),
    }];

    const asOf = archiveAsOf(memories, arcs, 100);
    // This is the assertion the whole replay rests on: an eval that leaks the
    // future measures a system with foresight and reports numbers nobody can
    // reproduce in production.
    expect(asOf.memories.map((memory) => memory.id)).toEqual(["mem-80"]);
    expect(asOf.arcs).toHaveLength(0);
  });

  it("treats only constraining memory kinds as established facts", () => {
    const memories: Memory[] = ["identity", "event", "boundary"].map((kind, index) => ({
      id: `k${index}`, characterId: "x", conversationId: "c",
      content: `${kind} fact`, kind: kind as Memory["kind"], importance: 4, keywords: [],
      pinned: false, status: "active", resolution: "", resolvedAt: null,
      lastRecalledAt: null, recallCount: 0, sourceMessageCount: 10, scene: null,
      createdAt: new Date(0).toISOString(),
    }));
    const facts = establishedFacts(memories, 100).map((memory) => memory.kind);
    // A reply is not obliged to reference everything that ever happened, so
    // ordinary events are not treated as obligations.
    expect(facts).toContain("identity");
    expect(facts).toContain("boundary");
    expect(facts).not.toContain("event");
  });
});
