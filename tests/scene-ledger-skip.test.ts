import { describe, expect, it } from "vitest";
import { midSentenceNames, sceneExtractionSystemPrompt, sceneUpdateSkippable, unknownScene } from "@/lib/scene-state";
import { estimateTokens } from "@/lib/context";
import { scene } from "./fixtures/scene-continuity";

/**
 * THE CHEAPEST WAY TO RUN AN EXTRACTOR IS NOT TO.
 *
 * Most turns of most stories change nothing the ledger holds, and the largest
 * saving available in this workload is simply not paying to discover that. This
 * suite asserts the two properties the pre-check has to have, which pull in
 * opposite directions and are therefore both worth pinning:
 *
 *   IT ACTUALLY SKIPS. A heuristic that always answers "run it" is a function
 *   call that costs a function call. The ordinary-conversation cases below have
 *   to be skipped or the feature does not exist.
 *
 *   IT ERRS TOWARD RUNNING. A false positive costs one very cheap extraction.
 *   A false negative is a stale ledger — a story that moved to the kitchen with
 *   a writer still told it is in the bedroom — which is a continuity error the
 *   reader sees. So every case that plausibly moves anybody, changes the room,
 *   or advances the clock must run, INCLUDING the ambiguous ones.
 *
 * And one property that is not about accuracy at all: it must be deterministic
 * and must not call anything. Building an LLM to decide whether to call an LLM
 * is the same bill with an extra hop.
 */

const established = scene({
  storyDay: 3,
  time: { kind: "period", text: "evening" },
  location: { place: "Maya's apartment", sub: "living room", confidence: "stated" },
  present: [{ name: "Maya", position: "on the sofa" }, { name: "User", position: "beside Maya" }],
});

function messages(...contents: string[]) {
  return contents.map((content) => ({ content }));
}

describe("the static-turn skip", () => {
  it("skips the exchanges the brief names", () => {
    for (const line of ["Yeah.", "What do you mean?", "I don't know.", "Mm.", "...", "Sure, whatever."]) {
      expect(sceneUpdateSkippable(messages(line), established).skip).toBe(true);
    }
  });

  it("skips several exchanges in which nobody moves and no time passes", () => {
    const quiet = messages(
      "Do you really believe that?",
      "\"I believe most of it,\" she says. \"Enough of it.\"",
      "That is not the same thing.",
      "\"No,\" she agrees. \"It is not.\"",
    );
    expect(sceneUpdateSkippable(quiet, established).skip).toBe(true);
  });

  it("runs on movement, however ordinary the sentence", () => {
    for (const line of [
      "I stand up and walk to the kitchen.",
      "She goes to answer the door.",
      "*He steps outside for some air.*",
      "We should head upstairs.",
    ]) {
      expect(sceneUpdateSkippable(messages(line), established).skip).toBe(false);
    }
  });

  it("runs on anything that moves the clock", () => {
    for (const line of [
      "An hour later, the rain stops.",
      "It is nearly midnight.",
      "The next morning she is already gone.",
      "We wait.",
    ]) {
      expect(sceneUpdateSkippable(messages(line), established).skip).toBe(false);
    }
  });

  it("runs when somebody arrives or leaves", () => {
    for (const line of [
      "\"Sorry I'm late,\" says a voice behind them.",
      "She hangs up and does not call back.",
      "*Anna joins them at the table.*",
    ]) {
      expect(sceneUpdateSkippable(messages(line), established).skip).toBe(false);
    }
  });

  it("runs when an unfamiliar name appears mid-sentence", () => {
    const decision = sceneUpdateSkippable(messages("I asked whether Anna knew about it."), established);
    expect(decision.skip).toBe(false);
    expect(decision.reason).toContain("Anna");
  });

  it("does not treat a sentence-opening capital as a name", () => {
    // The whole difficulty: roleplay prose opens sentences after asterisks and
    // quotation marks as well as after full stops, and a naive capitalisation
    // test would flag the first word of essentially every message and skip
    // nothing, ever.
    expect(midSentenceNames("*She shrugs.* \"Fine.\" Maybe not.")).toEqual([]);
    expect(midSentenceNames("I told Maya about it.")).toEqual(["Maya"]);
  });

  it("runs on a substantial new passage even when no cue word appears in it", () => {
    // Length is its own gate: a long reply can relocate a scene without using
    // any of the words above, and a short one essentially cannot.
    const long = messages(`"${"and so on, "  .repeat(80)}"`);
    expect(sceneUpdateSkippable(long, established).reason).toBe("substantial new prose");
  });

  it("never skips while the ledger has nothing established", () => {
    expect(sceneUpdateSkippable(messages("Yeah."), unknownScene).skip).toBe(false);
    // Nor while it is half-established: an opening that has a room but nobody
    // in it is one cheap extraction away from being worth having.
    const partial = scene({ storyDay: 1, location: { place: "the flat", sub: "", confidence: "stated" } });
    expect(sceneUpdateSkippable(messages("Yeah."), partial).skip).toBe(false);
  });

  it("is deterministic, and says why", () => {
    const first = sceneUpdateSkippable(messages("I don't know."), established);
    const second = sceneUpdateSkippable(messages("I don't know."), established);
    expect(first).toEqual(second);
    expect(first.reason).toBeTruthy();
  });
});

describe("the extraction prompt after the reduction", () => {
  it("is a fraction of the size the physical simulation needed", () => {
    /*
     * The old system prompt carried a JSON shape with twelve limb fields per
     * character plus nine rules governing when to fill them in, and it was
     * ~1,390 estimated tokens (5,542 characters). It was sent once per
     * accepted turn.
     *
     * This is not the main saving — running far less often on a far cheaper
     * model is — but it is the one that applies to every call that does happen,
     * and it is worth a regression test because a prompt is the easiest thing
     * in a codebase to grow back.
     */
    const before = 1386;
    const after = estimateTokens(sceneExtractionSystemPrompt());
    expect(after).toBeLessThan(before * 0.7);
  });

  it("asks for nothing the ledger no longer stores", () => {
    const prompt = sceneExtractionSystemPrompt();
    for (const gone of ["left_hand", "right_hand", "posture", "contacts", "constraints", "active_situation", "held"]) {
      expect(prompt).not.toContain(gone);
    }
  });

  it("states the two rules that keep the ledger honest", () => {
    const prompt = sceneExtractionSystemPrompt();
    // Never invent precision the story did not give.
    expect(prompt).toContain("Never convert a period into a clock time");
    // A short window is not evidence that somebody is absent.
    expect(prompt).toContain("PRESENT IS ADDITIVE AND IS NOT A ROLL CALL");
    expect(prompt).toContain("That is the only way a person comes off the ledger.");
  });
});
