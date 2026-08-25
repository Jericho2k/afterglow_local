import { retrievedSections, type EvidenceSection, type EvidenceVerdict } from "./taxonomy";

/**
 * Where a fact actually was when the writer saw it.
 *
 * A plain substring search over the whole prompt answers the wrong question.
 * "Maya lives in Berlin" appearing in the recent transcript and the same
 * sentence appearing in a retrieved memory are completely different findings:
 * the first means retrieval was never needed, and a wrong reply is squarely
 * the writer's; the second means retrieval did its job. Collapsing the two is
 * how an eval ends up blaming the ranker for prompt problems.
 *
 * So evidence is located by SECTION. The prompt has stable headers — they are
 * the ones `roleplayPrompt` writes — and the transcript arrives as separate
 * messages, so the split is structural rather than guessed.
 */

/**
 * The markers that open each region of the assembled system prompt, in the
 * order `roleplayPrompt` emits them. Kept here rather than exported from the
 * prompt builder because the eval must notice if the prompt changes shape:
 * a header that stops matching shows up as evidence vanishing, which is a
 * finding, not a silent pass.
 */
const sectionMarkers: Array<{ section: EvidenceSection; marker: string }> = [
  { section: "definition", marker: "ROLEPLAY PRESET" },
  { section: "scene", marker: "CURRENT SCENE — THIS IS NOW" },
  { section: "canon", marker: "Core canon — foundational facts that remain in force:" },
  { section: "summary", marker: "Rolling state and story-so-far:" },
  { section: "memories", marker: "Relevant durable memories" },
  { section: "arcs", marker: "Relevant historical arcs" },
];

export type PromptRegions = Partial<Record<EvidenceSection, string>>;

/**
 * Split an assembled prompt into named regions.
 *
 * Sections are located by marker position and run until the next marker that
 * actually appears, so an absent block (no Scene State, no canon yet) simply
 * has no region rather than swallowing the one after it.
 */
export function promptRegions(systemPrompt: string, transcript: string[] = []): PromptRegions {
  const found = sectionMarkers
    .map(({ section, marker }) => ({ section, marker, at: systemPrompt.indexOf(marker) }))
    .filter((entry) => entry.at >= 0)
    .sort((left, right) => left.at - right.at);

  const regions: PromptRegions = {};
  for (let index = 0; index < found.length; index += 1) {
    const start = found[index].at;
    const end = index + 1 < found.length ? found[index + 1].at : systemPrompt.length;
    regions[found[index].section] = systemPrompt.slice(start, end);
  }
  if (transcript.length) regions.transcript = transcript.join("\n\n");
  return regions;
}

/**
 * Comparison form.
 *
 * Lowercased, punctuation folded to spaces, whitespace collapsed. Deliberately
 * not stemmed and not fuzzy: a claim is authored alongside the fixture that
 * uses it, so an exact-after-normalisation match is achievable, and anything
 * looser would start reporting evidence that is not really there.
 */
export function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}'"]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * One fact the turn needs, and the surface forms that prove it arrived.
 *
 * `anyOf` exists because the same fact is phrased differently by the
 * consolidator, the curator and the scene extractor. Any one of them counts.
 */
export type EvidenceClaim = {
  id: string;
  description: string;
  anyOf: string[];
};

export type ClaimLocation = {
  claim: EvidenceClaim;
  /** Every region the claim was found in, most authoritative first. */
  sections: EvidenceSection[];
  found: boolean;
  /** True when at least one hit was in a section the memory system fills. */
  fromRetrieval: boolean;
};

export function locateClaim(claim: EvidenceClaim, regions: PromptRegions): ClaimLocation {
  const normalizedRegions = new Map<EvidenceSection, string>();
  for (const [section, text] of Object.entries(regions)) {
    if (text) normalizedRegions.set(section as EvidenceSection, normalize(text));
  }
  const sections: EvidenceSection[] = [];
  for (const [section, text] of normalizedRegions) {
    if (claim.anyOf.some((form) => form.trim() && text.includes(normalize(form)))) sections.push(section);
  }
  // Report in authority order so the first entry is the strongest source.
  const order = [...retrievedSections, "definition", "transcript"] as EvidenceSection[];
  sections.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  return {
    claim,
    sections,
    found: sections.length > 0,
    fromRetrieval: sections.some((section) => retrievedSections.includes(section)),
  };
}

export type EvidenceReport = {
  verdict: EvidenceVerdict;
  /** Every required claim was supplied by retrieval, not merely by the transcript. */
  fromRetrieval: boolean;
  located: ClaimLocation[];
  missing: EvidenceClaim[];
  /** Claims present only because the transcript still happened to carry them. */
  transcriptOnly: EvidenceClaim[];
  /** Forbidden material that should not have been in the prompt but was. */
  contaminants: ClaimLocation[];
};

/**
 * Stage one of the verdict.
 *
 * `forbidden` is as important as `required` and is what catches the failures
 * that are invisible from the reply alone: a resolved promise still being
 * injected, an obsolete fact still presented as current, a past scene
 * appearing without its tag. Those are retrieval faults whether or not the
 * writer happened to trip over them this turn.
 */
export function assessEvidence(
  regions: PromptRegions,
  required: EvidenceClaim[],
  forbidden: EvidenceClaim[] = [],
): EvidenceReport {
  const located = required.map((claim) => locateClaim(claim, regions));
  const missing = located.filter((entry) => !entry.found).map((entry) => entry.claim);
  const transcriptOnly = located
    .filter((entry) => entry.found && !entry.fromRetrieval && entry.sections.includes("transcript"))
    .map((entry) => entry.claim);

  const verdict: EvidenceVerdict = missing.length === 0
    ? "present"
    : missing.length === required.length ? "absent" : "partial";

  // Forbidden material is only ever checked in the parts of the prompt the
  // memory system controls. The transcript is history and is allowed to
  // contain the obsolete fact — that is exactly what makes it obsolete.
  const contaminants = forbidden
    .map((claim) => locateClaim(claim, regions))
    .filter((entry) => entry.fromRetrieval);

  return {
    verdict,
    fromRetrieval: located.length > 0 && located.every((entry) => entry.fromRetrieval),
    located,
    missing,
    transcriptOnly,
    contaminants,
  };
}
