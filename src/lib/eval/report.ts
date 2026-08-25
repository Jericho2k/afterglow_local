import { attributionOf, categoryLabels, failureCategories, type Attribution, type FailureCategory, type TurnVerdict } from "./taxonomy";

/**
 * The number the gate exists to produce.
 *
 * V2.1a stops here and reports. The decision that follows — whether to spend a
 * sprint on retrieval integrity or on the writer contract — is made from
 * `attribution`, so this file keeps that split honest: `latent` passes are not
 * counted as successes, and ambiguous turns are never redistributed into the
 * two buckets that would make the answer look tidier than it is.
 */

export type EvaluatedTurn = {
  /** Stable identity for the case or the replayed checkpoint. */
  id: string;
  label: string;
  verdict: TurnVerdict;
  /** Everything needed to re-open this turn later. Never the raw transcript. */
  attributionRef?: {
    retrievalRunId?: string;
    recalledMemoryIds?: string[];
    recalledArcIds?: string[];
    canonEntryIds?: string[];
    sceneStateId?: string;
    writerModel?: string;
    promptTokens?: number;
    coreCanonTokens?: number;
    episodicTokens?: number;
    arcTokens?: number;
  };
  notes?: string;
};

export type EvalSummary = {
  total: number;
  clean: number;
  /** Clean replies whose supporting continuity was not fully present. */
  latent: number;
  failures: number;
  attribution: Record<Attribution, number>;
  attributionShare: Record<Attribution, number>;
  categories: Array<{ category: FailureCategory; label: string; count: number }>;
};

export function summarize(turns: EvaluatedTurn[]): EvalSummary {
  const attribution: Record<Attribution, number> = { retrieval: 0, writer: 0, ambiguous: 0 };
  const counts = new Map<FailureCategory, number>();
  let clean = 0;
  let latent = 0;

  for (const turn of turns) {
    if (turn.verdict.outcome === "clean") {
      clean += 1;
      // A pass that only held because the transcript still carried the fact is
      // a failure waiting for the window to move. It is reported, not hidden.
      if (turn.verdict.evidence !== "present") latent += 1;
      continue;
    }
    if (turn.verdict.attribution !== "pass") attribution[turn.verdict.attribution] += 1;
    for (const category of turn.verdict.categories) counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const failures = turns.length - clean;
  const share = (value: number) => failures > 0 ? value / failures : 0;

  return {
    total: turns.length,
    clean,
    latent,
    failures,
    attribution,
    attributionShare: {
      retrieval: share(attribution.retrieval),
      writer: share(attribution.writer),
      ambiguous: share(attribution.ambiguous),
    },
    categories: failureCategories
      .map((category) => ({ category, label: categoryLabels[category], count: counts.get(category) ?? 0 }))
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count),
  };
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** A plain-text table, printable from CI output or the replay script. */
export function formatSummary(summary: EvalSummary, title = "Continuity evaluation") {
  const lines: string[] = [];
  lines.push(title);
  lines.push("=".repeat(title.length));
  lines.push(`turns evaluated   ${summary.total}`);
  lines.push(`clean             ${summary.clean}${summary.latent ? `  (${summary.latent} of them latent — the fact was not fully in the prompt)` : ""}`);
  lines.push(`failures          ${summary.failures}`);
  lines.push("");
  lines.push("attribution of failures");
  lines.push(`  A retrieval / integrity   ${String(summary.attribution.retrieval).padStart(4)}   ${percent(summary.attributionShare.retrieval)}`);
  lines.push(`  B writer misuse           ${String(summary.attribution.writer).padStart(4)}   ${percent(summary.attributionShare.writer)}`);
  lines.push(`  C mixed / ambiguous       ${String(summary.attribution.ambiguous).padStart(4)}   ${percent(summary.attributionShare.ambiguous)}`);
  if (summary.categories.length) {
    lines.push("");
    lines.push("by category");
    for (const entry of summary.categories) {
      lines.push(`  ${String(entry.count).padStart(4)}  ${entry.label}  [${attributionOf(entry.category)}]`);
    }
  }
  return lines.join("\n");
}

/**
 * Whether the sample is big enough to steer a sprint with.
 *
 * Guarding against the failure mode where four adversarial fixtures produce
 * "80% retrieval" and that becomes a roadmap. The threshold is a judgement
 * call rather than statistics, and it is stated rather than assumed.
 */
export function decisionReadiness(summary: EvalSummary, minimumFailures = 20) {
  if (summary.failures < minimumFailures) {
    return {
      ready: false,
      reason: `Only ${summary.failures} failures observed; ${minimumFailures} is the minimum this gate treats as steerable. Widen the replay set before choosing V2.1b work.`,
    };
  }
  const { retrieval, writer, ambiguous } = summary.attributionShare;
  if (ambiguous > 0.4) {
    return {
      ready: false,
      reason: `${percent(ambiguous)} of failures are ambiguous. Tighten the required-evidence claims on the replay checkpoints before attributing anything.`,
    };
  }
  const lead = Math.abs(retrieval - writer);
  if (lead < 0.15) {
    return {
      ready: true,
      reason: `Retrieval ${percent(retrieval)} and writer ${percent(writer)} are within ${percent(lead)} of each other — no clear winner, so both need work and the cheap fixes should go first.`,
    };
  }
  return {
    ready: true,
    reason: retrieval > writer
      ? `Retrieval/integrity dominates at ${percent(retrieval)}. V2.1b is justified.`
      : `Writer misuse dominates at ${percent(writer)}. Fix the writer contract before spending a sprint on the ranker.`,
  };
}
