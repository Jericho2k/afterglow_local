import { completionWithUsage, parseJson } from "../llm";
import { taskModelSelection } from "../provider";
import { failureCategories, type FailureCategory, type OutcomeVerdict } from "./taxonomy";

/**
 * The optional judge.
 *
 * Stage two — did the reply actually break continuity — cannot be answered by
 * string matching, so it needs a model. That makes it paid, non-deterministic
 * and unavailable in CI, which is why every part of the gate that CAN be
 * answered structurally is answered structurally in `evidence.ts` and this file
 * is reached only when `EVAL_JUDGE=true`.
 *
 * Two deliberate constraints on what the judge is allowed to decide.
 *
 * It never assigns blame. It is asked only whether the reply contradicts the
 * supplied facts and which categories apply; the retrieval-versus-writer
 * attribution is computed from evidence the harness located itself, because a
 * judge that could hand out attributions would quietly become the thing being
 * measured.
 *
 * It is told to abstain. `insufficient` is a first-class answer and flows to
 * the `ambiguous` bucket rather than being redistributed, because a gate that
 * pressures a judge into a verdict produces a confident wrong roadmap.
 */

export function judgeEnabled() {
  return process.env.EVAL_JUDGE === "true";
}

export type JudgeInput = {
  /** The creation's name, for pronoun and voice sanity. */
  characterName: string;
  /** The continuity facts this turn was supposed to honour. */
  facts: string[];
  /** Material that is obsolete, resolved, or historical — honouring it is an error. */
  obsolete?: string[];
  /** The last few turns, oldest first, as "Role: text". */
  recentTranscript: string[];
  /** The user turn being replied to. */
  userTurn: string;
  /** The reply under evaluation. */
  reply: string;
};

export type JudgeResult = {
  outcome: OutcomeVerdict;
  categories: FailureCategory[];
  /** The judge's own words, kept for the report and for spot-checking it. */
  rationale: string;
  /** True when the judge declined to decide. */
  abstained: boolean;
};

function judgePrompt(input: JudgeInput) {
  return `You are auditing ONE reply from a fiction roleplay for CONTINUITY errors only.

You are not judging prose quality, pacing, style, spice, or whether the reply is
interesting. Only whether it is consistent with the established facts below.

CHARACTER: ${input.characterName}

ESTABLISHED FACTS THE REPLY MUST NOT CONTRADICT
${input.facts.length ? input.facts.map((fact) => `- ${fact}`).join("\n") : "- None supplied"}

${input.obsolete?.length ? `NO LONGER TRUE — treating any of these as current IS an error
${input.obsolete.map((fact) => `- ${fact}`).join("\n")}

` : ""}RECENT TRANSCRIPT
${input.recentTranscript.join("\n")}

USER'S TURN
${input.userTurn}

REPLY UNDER EVALUATION
${input.reply}

Decide whether the reply contains a continuity error.

Important rules:
- Fiction may legitimately contain lies, mistaken beliefs, dreams, hypotheticals
  and unreliable narration. A character stating something false IN CHARACTER,
  when the fiction supports it, is not a continuity error.
- Not mentioning a fact is not an error. Only contradicting one is.
- If the reply is merely vague, or you cannot tell without more of the story,
  answer "insufficient". Do not guess.

Return ONLY JSON:
{"verdict":"clean"|"error"|"insufficient",
 "categories":[${failureCategories.filter((category) => category !== "writer_misuse" && category !== "ambiguous").map((category) => `"${category}"`).join("|")}],
 "rationale":"one or two sentences quoting the specific contradiction"}

Use "categories" only when verdict is "error". Choose the ones that genuinely apply.`;
}

/**
 * Runs the judge on its own task route, so a roleplay writer is never
 * accidentally the thing grading its own output.
 *
 * DELIBERATELY `taskModelSelection` RATHER THAN THE ADMIN ROUTE. An
 * administrator switching the memory model must not silently switch the model
 * that grades memory quality: a judge that moves with the thing it is judging
 * cannot produce a comparison. This reads the environment route and the code
 * default only, and is unaffected by anything in
 * src/lib/background-routing.ts.
 */
export async function judgeTurn(input: JudgeInput): Promise<JudgeResult> {
  const selection = taskModelSelection("memory_curation");
  const response = await completionWithUsage(selection, [
    { role: "system", content: "You are a precise continuity auditor for fiction. Return valid JSON only." },
    { role: "user", content: judgePrompt(input) },
  ], { json: true, maxTokens: 700, temperature: 0 });

  return parseJudgeResponse(response.content);
}

/** Split out so the parsing rules are testable without paying for inference. */
export function parseJudgeResponse(raw: string): JudgeResult {
  let data: { verdict?: string; categories?: unknown; rationale?: unknown };
  try {
    data = parseJson<typeof data>(raw);
  } catch {
    // An unparseable judge is an abstention, never a pass. Counting a
    // malformed response as "clean" would silently deflate the failure rate.
    return { outcome: "error", categories: ["ambiguous"], rationale: "Judge response could not be parsed.", abstained: true };
  }

  const verdict = String(data.verdict ?? "").toLowerCase();
  const rationale = typeof data.rationale === "string" ? data.rationale.slice(0, 600) : "";

  if (verdict === "clean") return { outcome: "clean", categories: [], rationale, abstained: false };

  const allowed = new Set<string>(failureCategories);
  const categories = Array.isArray(data.categories)
    ? data.categories.filter((entry): entry is FailureCategory => typeof entry === "string" && allowed.has(entry))
    : [];

  if (verdict === "insufficient") {
    return { outcome: "error", categories: ["ambiguous"], rationale, abstained: true };
  }
  if (verdict === "error") {
    return { outcome: "error", categories: categories.length ? categories : ["ambiguous"], rationale, abstained: false };
  }
  // Anything else is a judge that did not follow the contract, which is an
  // abstention rather than a verdict.
  return { outcome: "error", categories: ["ambiguous"], rationale: rationale || `Unrecognised verdict "${verdict}".`, abstained: true };
}
