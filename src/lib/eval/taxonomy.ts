/**
 * What a continuity failure IS, and who is responsible for it.
 *
 * This file exists because "the output is not perfect" is not a measurement,
 * and because the most expensive mistake available right now would be to spend
 * a memory sprint fixing retrieval when the dominant failure is the writer
 * ignoring continuity it was already given.
 *
 * So the evaluation is deliberately TWO STAGES, and the first one is not about
 * the reply at all:
 *
 *   1. EVIDENCE — was the continuity the turn needed actually present in the
 *      prompt, and in which part of it?
 *   2. OUTCOME  — did the generation contain a continuity error?
 *
 * Crossing those two answers is what produces an attribution instead of an
 * opinion. A wrong reply whose supporting fact was sitting in the prompt is a
 * writer problem and no amount of ranker work will fix it; a wrong reply whose
 * fact never arrived is a retrieval problem and no amount of prompt tuning
 * will fix it. Before this, both looked identical from the outside.
 */

/** Where the required fact was found. Ordered from most to least authoritative. */
export const evidenceSections = [
  /** The Scene State block: where and when NOW is. */
  "scene",
  /** Curated Core Canon. */
  "canon",
  /** The rolling current-state summary. */
  "summary",
  /** Retrieved episodic memories. */
  "memories",
  /** Retrieved historical arcs. */
  "arcs",
  /** The creation's own authored definition, or attached world canon. */
  "definition",
  /**
   * The recent transcript. Important and easy to miss: a fact visible in the
   * last few turns did not need retrieval at all, so a failure here is much
   * more likely to be the writer's.
   */
  "transcript",
] as const;
export type EvidenceSection = typeof evidenceSections[number];

/** Which sections count as "the memory system supplied this". */
export const retrievedSections: EvidenceSection[] = ["scene", "canon", "summary", "memories", "arcs"];

export const failureCategories = [
  /** Continuity was present and correct; the reply contradicted it anyway. */
  "writer_misuse",
  /** A fact the turn needed was never retrieved. */
  "memory_missing",
  /** A resolved or long-dead commitment was injected and acted on. */
  "stale_commitment",
  /** Protected/pinned entries displaced the material the turn actually needed. */
  "protected_crowding",
  /** Two incompatible facts were both live; the reply split the difference. */
  "contradiction",
  /** A past scene was treated as the present one. */
  "scene_confusion",
  /** Curated canon was wrong, missing, or lost a foundational fact. */
  "canon_failure",
  /** The rolling summary distorted or dropped something across rewrites. */
  "summary_drift",
  /** Irrelevant history was retrieved and dragged the reply off-scene. */
  "retrieval_false_positive",
  /** Not enough signal to attribute. Counted, never guessed at. */
  "ambiguous",
] as const;
export type FailureCategory = typeof failureCategories[number];

/** The three buckets the gate reports. */
export type Attribution = "retrieval" | "writer" | "ambiguous";

const attributionByCategory: Record<FailureCategory, Attribution> = {
  writer_misuse: "writer",
  memory_missing: "retrieval",
  stale_commitment: "retrieval",
  protected_crowding: "retrieval",
  contradiction: "retrieval",
  scene_confusion: "retrieval",
  canon_failure: "retrieval",
  summary_drift: "retrieval",
  retrieval_false_positive: "retrieval",
  ambiguous: "ambiguous",
};

export function attributionOf(category: FailureCategory): Attribution {
  return attributionByCategory[category];
}

export const categoryLabels: Record<FailureCategory, string> = {
  writer_misuse: "Correct retrieval, writer misuse",
  memory_missing: "Relevant memory missing",
  stale_commitment: "Stale or resolved commitment injected",
  protected_crowding: "Protected memory crowding",
  contradiction: "Contradiction or obsolete state",
  scene_confusion: "Current-vs-historical scene confusion",
  canon_failure: "Core Canon failure",
  summary_drift: "Rolling-summary drift",
  retrieval_false_positive: "Retrieval false positive",
  ambiguous: "Insufficient evidence",
};

/** Stage one. How much of what the turn needed actually reached the writer. */
export type EvidenceVerdict = "present" | "partial" | "absent";
/** Stage two. Whether the generation was clean. */
export type OutcomeVerdict = "clean" | "error";

export type TurnVerdict = {
  evidence: EvidenceVerdict;
  outcome: OutcomeVerdict;
  /** True when every required fact was supplied by retrieval rather than merely visible in the transcript. */
  fromRetrieval: boolean;
  attribution: Attribution | "pass";
  categories: FailureCategory[];
  /** Why this verdict, in one line, for the report. */
  rationale: string;
};

/**
 * The crossing.
 *
 * The two cases worth naming explicitly:
 *
 * EVIDENCE PRESENT + ERROR is writer misuse, and it is the result that decides
 * whether the memory programme is worth running at all. It is reported as its
 * own top-level outcome rather than folded into a miscellaneous bucket.
 *
 * EVIDENCE ABSENT + CLEAN is a pass that should not be celebrated: the reply
 * survived without the fact, usually because the transcript still carried it.
 * It is recorded as `latent` in the report because it is the exact turn that
 * will fail once the conversation grows and the transcript window moves on.
 */
export function crossVerdict(input: {
  evidence: EvidenceVerdict;
  outcome: OutcomeVerdict;
  fromRetrieval: boolean;
  /**
   * Material that should not have been authoritative was in the prompt anyway
   * — a resolved commitment, an obsolete fact, an untagged past scene.
   *
   * This overrides the evidence stage, and the first run of the fixture suite
   * is what proved it has to: a turn can have every required fact present AND
   * a contaminant beside it, and blaming the writer for averaging the two
   * would be exactly backwards. Putting the contaminant there is a retrieval
   * fault whether or not the writer tripped over it.
   */
  contaminated?: boolean;
  /** Categories the judge or the fixture asserted. May be empty. */
  categories?: FailureCategory[];
}): TurnVerdict {
  const categories = input.categories ?? [];

  if (input.outcome === "clean") {
    return {
      evidence: input.evidence,
      outcome: "clean",
      fromRetrieval: input.fromRetrieval,
      attribution: "pass",
      categories: [],
      rationale: input.evidence === "present"
        ? "Continuity present and the reply honoured it."
        : "Reply was clean, but the supporting continuity was not fully present — this turn is at risk once the transcript moves on.",
    };
  }

  if (input.contaminated) {
    const named = categories.filter((category) => attributionOf(category) === "retrieval");
    return {
      evidence: input.evidence,
      outcome: "error",
      fromRetrieval: input.fromRetrieval,
      attribution: "retrieval",
      categories: named.length ? named : ["contradiction"],
      rationale: "Material that is no longer authoritative was presented to the writer as if it were.",
    };
  }

  if (input.evidence === "present") {
    // The decisive case. Everything the turn needed was in the prompt and the
    // reply broke continuity regardless, so the ranker is not the problem.
    const named = categories.filter((category) => category !== "ambiguous");
    return {
      evidence: "present",
      outcome: "error",
      fromRetrieval: input.fromRetrieval,
      attribution: "writer",
      categories: named.length ? named : ["writer_misuse"],
      rationale: "Every required fact was in the prompt; the reply contradicted it anyway.",
    };
  }

  if (input.evidence === "absent") {
    const named = categories.filter((category) => attributionOf(category) === "retrieval");
    return {
      evidence: "absent",
      outcome: "error",
      fromRetrieval: input.fromRetrieval,
      attribution: "retrieval",
      categories: named.length ? named : ["memory_missing"],
      rationale: "The reply broke continuity and the fact it needed never reached the prompt.",
    };
  }

  // Partial evidence is genuinely ambiguous and is not forced into a bucket.
  return {
    evidence: "partial",
    outcome: "error",
    fromRetrieval: input.fromRetrieval,
    attribution: "ambiguous",
    categories: categories.length ? categories : ["ambiguous"],
    rationale: "Some of the required continuity reached the prompt and some did not; responsibility cannot be assigned from this turn alone.",
  };
}
