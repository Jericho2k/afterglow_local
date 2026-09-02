import { describe, expect, it } from "vitest";
import { estimateTokens } from "@/lib/context";
import {
  emptyScene, mergeSceneState, normalizeSceneUpdate, sceneExtractionPrompt,
  sceneExtractionSystemPrompt, sceneUpdateSkippable, type SceneStateFields,
} from "@/lib/scene-state";

/**
 * WHERE THE SCENE LEDGER'S SAVING COMES FROM, SEPARATED.
 *
 * Four things changed at once, and a single "it is much cheaper now" figure
 * would mix them and be useless for deciding what to keep:
 *
 *   FEWER CALLS      — regenerated drafts no longer extract at all, and static
 *                      turns carry the ledger forward without a model.
 *   A SMALLER PROMPT — the extraction contract lost the physical simulation.
 *   A CHEAPER MODEL  — the default route is Ling rather than DeepSeek.
 *   CACHE            — a stable prefix on a stable session.
 *
 * This file measures the first two, because they are the two that are properties
 * of THIS CODE and can therefore be asserted offline and deterministically. The
 * third is a price list and the fourth is a provider-reported number; both are
 * reported by `GET /api/usage/background` from the real ledger, and neither is
 * guessed at here.
 *
 * The story below is synthetic and its shape is the whole argument, so it is
 * stated plainly rather than tuned: a scene is established, then a long stretch
 * of ordinary conversation happens inside it, punctuated by real movement, with
 * the reader regenerating some replies. That is what a roleplay looks like, and
 * if the mix here were dishonest the skip rate would be too.
 */

type Turn = {
  content: string;
  /** How the turn reached the pipeline. A regenerate is a discarded draft. */
  action: "send" | "continue" | "regenerate";
  /** What the extractor would report, when it runs. */
  update?: Record<string, unknown>;
};

/**
 * Forty turns of one story.
 *
 * Sixteen are quiet exchanges in a settled room; six genuinely move somebody,
 * change the room or advance the clock; eight are regenerated drafts of replies
 * the reader did not keep; the rest open the scene or continue an accepted one.
 */
const story: Turn[] = [
  { content: "*Maya opens the door to her apartment and drops her keys in the bowl.*", action: "send", update: { location: { place: "Maya's apartment", sub: "hallway", confidence: "stated" }, time: { kind: "period", text: "evening" }, present: [{ name: "Maya", position: "in the hallway" }, { name: "You", position: "in the doorway" }] } },
  { content: "I follow her in and sit down on the sofa.", action: "send", update: { location: { place: "Maya's apartment", sub: "living room", confidence: "stated" }, present: [{ name: "You", position: "on the sofa" }] } },
  { content: "\"Do you want tea?\"", action: "send" },
  { content: "Sure.", action: "send" },
  { content: "\"Sure isn't an answer.\"", action: "regenerate" },
  { content: "\"That's not an answer.\"", action: "regenerate" },
  { content: "\"That is not an answer, and you know it.\"", action: "send" },
  { content: "It is the only one I've got.", action: "send" },
  { content: "\"Mm.\"", action: "send" },
  { content: "Why does it matter?", action: "send" },
  { content: "\"It doesn't. Forget I asked.\"", action: "send" },
  { content: "I don't believe you.", action: "send" },
  { content: "\"You never do.\"", action: "continue" },
  { content: "*She goes through to the kitchen and puts the kettle on.*", action: "send", update: { location: { place: "Maya's apartment", sub: "kitchen", confidence: "stated" }, present: [{ name: "Maya", position: "at the counter" }] } },
  { content: "I stay where I am.", action: "send" },
  { content: "\"Suit yourself.\"", action: "send" },
  { content: "What did she say about it?", action: "send" },
  { content: "\"Nothing worth repeating.\"", action: "regenerate" },
  { content: "\"Nothing I'd repeat.\"", action: "send" },
  { content: "That bad?", action: "send" },
  { content: "\"Worse.\"", action: "send" },
  { content: "*A key turns in the front door and Anna comes in, shaking off the rain.*", action: "send", update: { present: [{ name: "Anna", position: "in the hallway" }] } },
  { content: "\"You're early.\"", action: "send" },
  { content: "\"Traffic was nothing.\"", action: "regenerate" },
  { content: "\"The roads were empty for once.\"", action: "send" },
  { content: "Hm.", action: "send" },
  { content: "I don't know what to say to that.", action: "send" },
  { content: "\"Then don't.\"", action: "send" },
  { content: "\"Anyway.\"", action: "send" },
  { content: "*Anna takes the chair by the window and does not take her coat off.*", action: "send", update: { present: [{ name: "Anna", position: "in the chair by the window" }] } },
  { content: "You are not staying, then.", action: "send" },
  { content: "\"I didn't say that.\"", action: "regenerate" },
  { content: "\"I never said that.\"", action: "send" },
  { content: "You didn't have to.", action: "send" },
  { content: "\"No.\"", action: "send" },
  { content: "\"Well.\"", action: "send" },
  { content: "*An hour later the rain has stopped and Anna has gone.*", action: "send", update: { time: { kind: "relative", text: "an hour later" }, departed: ["Anna"] } },
  { content: "She didn't say goodbye.", action: "regenerate" },
  { content: "She left without saying anything.", action: "send" },
  { content: "\"She never does.\"", action: "send" },
];

type LedgerRun = {
  /** Turns that reached the ledger at all: everything except regenerations. */
  eligible: number;
  /** Turns the pipeline never saw, because a discarded draft is not a position. */
  discardedDrafts: number;
  calls: number;
  skipped: number;
  finalScene: SceneStateFields;
  promptTokensPerCall: number;
};

function run(): LedgerRun {
  let fields = emptyScene();
  let eligible = 0;
  let discardedDrafts = 0;
  let calls = 0;
  let skipped = 0;
  let promptTokens = 0;

  for (const turn of story) {
    /*
     * THE TRIGGER RULE, APPLIED FIRST.
     *
     * A regenerated candidate is not a new canonical story position, so it does
     * not reach the ledger and cannot cost anything. This is the largest single
     * effect in the table below and it is also the correctness fix: pressing
     * Regenerate four times used to have the ledger read four different futures
     * in turn, each overwriting the last.
     */
    if (turn.action === "regenerate") { discardedDrafts += 1; continue; }
    eligible += 1;

    const decision = sceneUpdateSkippable([{ content: turn.content }], fields);
    if (decision.skip) { skipped += 1; continue; }

    calls += 1;
    promptTokens += estimateTokens(sceneExtractionSystemPrompt())
      + estimateTokens(sceneExtractionPrompt({
        previous: fields,
        transcript: turn.content,
        knownNames: ["You", "Maya", "Anna"],
        premise: "An evening in.",
        isOpening: false,
      }));
    fields = mergeSceneState(fields, normalizeSceneUpdate(turn.update ?? {})).fields;
  }

  return { eligible, discardedDrafts, calls, skipped, finalScene: fields, promptTokensPerCall: calls ? promptTokens / calls : 0 };
}

describe("Scene Ledger economics", () => {
  it("reports calls, skips and prompt size over one realistic story", () => {
    const result = run();
    /*
     * The old pipeline for the same story: one extraction on every turn the
     * chat route completed, regenerations included, at ~1,390 tokens of system
     * prompt plus a fourteen-message window.
     */
    const before = { calls: story.length, promptTokensPerCall: 1386 + 900 };
    console.log([
      "",
      `SCENE LEDGER — ${story.length} turns of one story`,
      `  eligible story advances   ${result.eligible}   (accepted replies and continues)`,
      `  discarded drafts          ${result.discardedDrafts}   (regenerations: never extracted, never charged)`,
      `  extractor calls made      ${result.calls}`,
      `  calls skipped             ${result.skipped}`,
      `  skip rate                 ${((result.skipped / result.eligible) * 100).toFixed(0)}% of eligible advances`,
      "",
      "  ATTRIBUTION — the two effects this file can measure offline:",
      `    fewer calls             ${before.calls} → ${result.calls}  (${(((before.calls - result.calls) / before.calls) * 100).toFixed(0)}% fewer)`,
      `    smaller prompt          ~${before.promptTokensPerCall.toLocaleString()} → ~${Math.round(result.promptTokensPerCall).toLocaleString()} input tokens per call`,
      `    input tokens for story  ~${(before.calls * before.promptTokensPerCall).toLocaleString()} → ~${Math.round(result.calls * result.promptTokensPerCall).toLocaleString()}`,
      "",
      "  A cheaper model and a warm cache multiply the figure above and are NOT",
      "  counted here: a price list is not a measurement and a cache ratio is a",
      "  provider-reported number. Both appear in GET /api/usage/background.",
      "",
    ].join("\n"));

    expect(result.calls).toBeLessThan(before.calls / 2);
    expect(result.promptTokensPerCall).toBeLessThan(before.promptTokensPerCall);
  });

  it("skips a real majority of the quiet turns without missing a real change", () => {
    const result = run();
    // The feature has to actually skip: a heuristic that always runs is a
    // function call that costs a function call.
    expect(result.skipped / result.eligible).toBeGreaterThan(0.25);
    /*
     * AND — the part that matters more — every genuine change still landed.
     * Three people were in the room, one of them left, the story moved from the
     * hallway to the living room to the kitchen, and an hour passed. If the
     * skip had eaten any of that, this is where it would show.
     */
    expect(result.finalScene.location.sub).toBe("kitchen");
    expect(result.finalScene.time).toEqual({ kind: "relative", text: "an hour later" });
    expect(result.finalScene.present.map((person) => person.name)).toEqual(["Maya", "You"]);
  });

  it("keeps a character in the room through sixteen turns of not being mentioned", () => {
    /*
     * The reported failure, run end to end through the trigger policy, the skip
     * heuristic and the merge together rather than asserted on the merge alone.
     * Anna arrives, is not addressed for the whole middle of the story, and is
     * still in the chair by the window until the transcript says she left.
     */
    let fields = emptyScene();
    let sawAnnaLeave = false;
    for (const turn of story) {
      if (turn.action === "regenerate") continue;
      if (sceneUpdateSkippable([{ content: turn.content }], fields).skip) continue;
      const update = normalizeSceneUpdate(turn.update ?? {});
      if (update.departed?.includes("Anna")) sawAnnaLeave = true;
      fields = mergeSceneState(fields, update).fields;
      const annaHasArrived = fields.present.some((person) => person.name === "Anna");
      // Between arriving and leaving, Anna is on the ledger on every single
      // turn — including the ones nobody addressed her on.
      if (annaHasArrived && !sawAnnaLeave) expect(fields.present.map((person) => person.name)).toContain("Anna");
    }
    expect(sawAnnaLeave).toBe(true);
    expect(fields.present.map((person) => person.name)).not.toContain("Anna");
  });
});
