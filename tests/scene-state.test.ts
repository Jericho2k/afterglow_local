import { describe, expect, it } from "vitest";
import {
  arcSceneTag, locationLabel, mergeSceneState, normalizeSceneUpdate, renderCurrentScene,
  sceneRetrievalCue, sceneStateTokens, sceneTag, unknownScene, type SceneStateFields,
} from "@/lib/scene-state";
import { roleplayPrompt } from "@/lib/prompts";
import { arc, benchmarkCharacter, memory, scene, scenarioCreation } from "./fixtures/scene-continuity";

/**
 * The rules that make Scene State safe are all in the merge: what persists,
 * what may change, and what must stay unknown. They are tested here without a
 * model so a regression is unambiguous rather than a sampling accident.
 */

const apartment: SceneStateFields = scene({
  storyDay: 4,
  timeOfDay: "evening",
  location: { place: "Maya's apartment", sub: "living room", confidence: "stated" },
  presentCharacters: ["Maya", "Alex"],
  activeSituation: ["They planned to watch a film after dinner."],
});

/** A window the extractor found nothing new in — the overwhelmingly common case. */
const noEvidence = normalizeSceneUpdate({});

describe("scene state merge", () => {
  it("A — keeps the location through ten turns with no movement", () => {
    let fields = apartment;
    for (let turn = 0; turn < 10; turn += 1) fields = mergeSceneState(fields, noEvidence).fields;
    expect(locationLabel(fields.location)).toBe("Maya's apartment — living room");
    expect(fields.presentCharacters).toEqual(["Maya", "Alex"]);
  });

  it("B — moves when the story moves", () => {
    const result = mergeSceneState(apartment, normalizeSceneUpdate({
      location: { place: "Uki's house", sub: "hallway", confidence: "stated" },
    }));
    expect(locationLabel(result.fields.location)).toBe("Uki's house — hallway");
    expect(result.changed).toContain("location");
  });

  it("B — keeps the known corner of a room when only the place is reported again", () => {
    const result = mergeSceneState(apartment, normalizeSceneUpdate({
      location: { place: "Maya's apartment", sub: "", confidence: "stated" },
    }));
    expect(result.fields.location.sub).toBe("living room");
    expect(result.changed).not.toContain("location");
  });

  it("D — advances chronology on explicit narrative evidence", () => {
    const result = mergeSceneState(apartment, normalizeSceneUpdate({
      day_advance: 3, day_advance_evidence: "Three days later, the rain finally stopped.",
    }));
    expect(result.fields.storyDay).toBe(7);
    expect(result.changed).toContain("story_day");
    // A time of day belonged to the day that ended; it is wrong now, not stale.
    expect(result.fields.timeOfDay).toBe("");
  });

  it("D — rolls an established calendar date forward with the skip", () => {
    const dated = { ...apartment, dateKind: "exact" as const, dateText: "2026-10-17" };
    const result = mergeSceneState(dated, normalizeSceneUpdate({ day_advance: 3, day_advance_evidence: "Three days later" }));
    expect(result.fields.dateText).toBe("2026-10-20");
    expect(result.fields.dateKind).toBe("exact");
  });

  it("D — drops a relative date that the skip made untrue", () => {
    const dated = { ...apartment, dateKind: "relative" as const, dateText: "the day after the festival" };
    const result = mergeSceneState(dated, normalizeSceneUpdate({ day_advance: 2, day_advance_evidence: "Two days later" }));
    expect(result.fields.dateKind).toBe("unknown");
    expect(result.fields.dateText).toBe("");
  });

  it("E — fifty messages of dialogue are not a new day", () => {
    let fields = apartment;
    for (let turn = 0; turn < 50; turn += 1) fields = mergeSceneState(fields, noEvidence).fields;
    expect(fields.storyDay).toBe(4);
  });

  it("E — ignores a day advance the extractor could not evidence", () => {
    const result = mergeSceneState(apartment, normalizeSceneUpdate({ day_advance: 4, day_advance_evidence: "" }));
    expect(result.fields.storyDay).toBe(4);
    expect(result.changed).not.toContain("story_day");
  });

  it("F — leaves the date unknown when the story never established one", () => {
    let fields = mergeSceneState(unknownScene, normalizeSceneUpdate({
      location: { place: "the dormitory", sub: "common room", confidence: "stated" }, time_of_day: "Morning",
    })).fields;
    for (let turn = 0; turn < 8; turn += 1) fields = mergeSceneState(fields, noEvidence).fields;
    expect(fields.dateKind).toBe("unknown");
    expect(fields.dateText).toBe("");
    expect(fields.timeOfDay).toBe("morning");
    // Relative chronology still works without a calendar.
    expect(fields.storyDay).toBe(1);
    expect(renderCurrentScene(fields)).toContain("Date: unknown");
  });

  it("F — refuses to treat invented prose as an exact calendar date", () => {
    const update = normalizeSceneUpdate({ date: { kind: "exact", value: "sometime in October" } });
    expect(update.date).toEqual({ kind: "relative", text: "sometime in October" });
    const exact = normalizeSceneUpdate({ date: { kind: "exact", value: "2026-10-17" } });
    expect(exact.date).toEqual({ kind: "exact", text: "2026-10-17" });
  });

  it("G — drops a character the story showed leaving", () => {
    const populated = { ...apartment, presentCharacters: ["Sera", "Maya", "Alex"] };
    const result = mergeSceneState(populated, normalizeSceneUpdate({ present: ["Maya", "Alex"] }));
    expect(result.fields.presentCharacters).toEqual(["Maya", "Alex"]);
    expect(result.changed).toContain("present");
  });

  it("H — puts a character back when they return", () => {
    const left = { ...apartment, presentCharacters: ["Maya", "Alex"] };
    const returned = mergeSceneState(left, normalizeSceneUpdate({ present: ["Maya", "Alex", "Sera"] }));
    expect(returned.fields.presentCharacters).toContain("Sera");
  });

  it("G — a window with no evidence about the cast never empties the room", () => {
    const result = mergeSceneState(apartment, normalizeSceneUpdate({ present: [] }));
    expect(result.fields.presentCharacters).toEqual(["Maya", "Alex"]);
  });

  it("L — carries an unresolved plan through an unrelated beat", () => {
    let fields = apartment;
    fields = mergeSceneState(fields, normalizeSceneUpdate({ location: { place: "Maya's apartment", sub: "kitchen", confidence: "stated" } })).fields;
    fields = mergeSceneState(fields, noEvidence).fields;
    expect(fields.activeSituation).toEqual(["They planned to watch a film after dinner."]);
  });

  it("L — replaces the open loops once the extractor reports new ones", () => {
    const result = mergeSceneState(apartment, normalizeSceneUpdate({
      active_situation: ["The film is playing.", "Maya is falling asleep against Alex."],
    }));
    expect(result.fields.activeSituation).toHaveLength(2);
    expect(result.fields.activeSituation[0]).toBe("The film is playing.");
    expect(result.changed).toContain("active_situation");
  });

  it("bounds everything a model can propose", () => {
    const update = normalizeSceneUpdate({
      location: { place: "x".repeat(400), sub: "y".repeat(400), confidence: "hallucinated" },
      present: Array.from({ length: 30 }, (_, index) => `Person ${index}`),
      active_situation: Array.from({ length: 20 }, (_, index) => `Beat ${index}`),
      day_advance: 999_999, day_advance_evidence: "z".repeat(900),
    });
    expect(update.location?.place.length).toBe(120);
    expect(update.location?.confidence).toBe("inferred");
    expect(update.presentCharacters).toHaveLength(8);
    expect(update.activeSituation).toHaveLength(5);
    expect(update.dayAdvance).toBe(3650);
    expect(update.dayAdvanceEvidence?.length).toBe(200);
  });

  it("survives a model that returns something other than an object", () => {
    expect(normalizeSceneUpdate(null)).toEqual({});
    expect(normalizeSceneUpdate("nonsense")).toEqual({});
    expect(mergeSceneState(apartment, normalizeSceneUpdate([])).fields.location.place).toBe("Maya's apartment");
  });
});

describe("scene state rendering", () => {
  it("stays inside a small prompt budget", () => {
    const tokens = sceneStateTokens(scene({
      storyDay: 12, dateKind: "exact", dateText: "2026-10-17", timeOfDay: "late evening", timeText: "just past eleven",
      location: { place: "Maya's apartment", sub: "bedroom", confidence: "stated" },
      presentCharacters: ["Maya", "Alex"],
      activeSituation: ["They returned from the party.", "Maya is exhausted.", "The film has not been started."],
    }));
    expect(tokens).toBeGreaterThan(30);
    expect(tokens).toBeLessThanOrEqual(250);
  });

  it("renders nothing at all when nothing is established", () => {
    expect(renderCurrentScene(unknownScene)).toBe("");
    expect(sceneStateTokens(unknownScene)).toBe(0);
  });

  it("states unknown fields as unknown rather than omitting them", () => {
    const rendered = renderCurrentScene(scene({ storyDay: 2, location: { place: "the dormitory", sub: "", confidence: "inferred" } }));
    expect(rendered).toContain("Story day: 2");
    expect(rendered).toContain("Date: unknown");
    expect(rendered).toContain("Time: unknown");
    expect(rendered).toContain("Present: unknown");
  });

  it("tags a historical event only when it kept grounding", () => {
    expect(sceneTag({ storyDay: 4, timeOfDay: "afternoon", location: "university courtyard", present: [] })).toBe("[Day 4 · afternoon · university courtyard]");
    expect(sceneTag({ storyDay: null, timeOfDay: "", location: "", present: [] })).toBe("");
    expect(sceneTag(null)).toBe("");
    expect(arcSceneTag({ storyDayStart: 8, storyDayEnd: 10, locations: ["Kyoto hotel", "shrine district"] })).toBe("[Days 8–10 · Kyoto hotel, shrine district]");
    expect(arcSceneTag({ storyDayStart: null, storyDayEnd: null, locations: [] })).toBe("");
  });

  it("keeps the optional retrieval cue to people and place", () => {
    const cue = sceneRetrievalCue(scene({
      storyDay: 9, timeOfDay: "night", location: { place: "the safehouse", sub: "kitchen", confidence: "stated" }, presentCharacters: ["Sera", "Kit"],
    }));
    expect(cue).toContain("Present: Sera, Kit");
    expect(cue).toContain("Place: the safehouse");
    expect(cue).not.toContain("night");
    expect(sceneRetrievalCue(unknownScene)).toBe("");
  });
});

describe("writer prompt grounding", () => {
  it("C — separates the couch you are on from the couch you remember", () => {
    const prompt = roleplayPrompt(
      benchmarkCharacter, "",
      [memory("They talked about the inheritance on the couch.", { storyDay: 11, timeOfDay: "afternoon", location: "Uki's mother's house — couch", present: ["Uki", "Alex"] })],
      [], undefined,
      {
        sceneState: scene({ storyDay: 12, timeOfDay: "late evening", location: { place: "Uki's apartment", sub: "couch", confidence: "stated" }, presentCharacters: ["Uki", "Alex"] }),
      },
    );
    expect(prompt).toContain("CURRENT SCENE — THIS IS NOW");
    expect(prompt).toContain("Location: Uki's apartment — couch");
    expect(prompt).toContain("[Day 11 · afternoon · Uki's mother's house — couch]");
    expect(prompt).toContain("PAST EVENTS");
    expect(prompt).toContain("Never treat a remembered place, time, date, or participant as the current one");
    // The current scene has to outrank the archive, and be said to.
    expect(prompt.indexOf("CURRENT SCENE — THIS IS NOW")).toBeLessThan(prompt.lastIndexOf("Relevant durable memories"));
    expect(prompt).toContain("2. The CURRENT SCENE block for where, when, and who is present right now");
  });

  it("M — annotates a retrieved memory as history without reordering retrieval", () => {
    const memories = [
      memory("Maya admitted she had hidden the letter.", { storyDay: 4, timeOfDay: "afternoon", location: "university courtyard", present: ["Maya", "Alex"] }),
      memory("Alex promised to help Maya deal with her family.", { storyDay: 7, timeOfDay: "evening", location: "Maya's apartment", present: ["Maya", "Alex"] }),
      memory("An older memory that predates scene tracking."),
    ];
    const prompt = roleplayPrompt(benchmarkCharacter, "", memories, [arc("The trip to Kyoto.", { storyDayStart: 8, storyDayEnd: 10, locations: ["Kyoto hotel"] })], undefined, {
      sceneState: scene({ storyDay: 11, location: { place: "the station", sub: "", confidence: "stated" } }),
    });
    expect(prompt).toContain("[Day 4 · afternoon · university courtyard]");
    expect(prompt).toContain("[Day 7 · evening · Maya's apartment]");
    expect(prompt).toContain("[Days 8–10 · Kyoto hotel]");
    // Relevance order is what retrieval returned; annotation must not shuffle it.
    expect(prompt.indexOf("hidden the letter")).toBeLessThan(prompt.indexOf("promised to help Maya"));
    // A memory with no grounding is presented plainly rather than back-dated.
    expect(prompt).toContain("- [event; active; importance 4] An older memory that predates scene tracking.");
  });

  it("P — tracks contextual NPCs for a scenario with no primary character", () => {
    const prompt = roleplayPrompt(scenarioCreation, "", [], [], undefined, {
      sceneState: scene({
        storyDay: 2, timeOfDay: "night",
        location: { place: "the checkpoint", sub: "east gate", confidence: "stated" },
        presentCharacters: ["a conscript sergeant", "two customs officers", "Alex"],
        activeSituation: ["The courier's papers have not been stamped."],
      }),
    });
    expect(prompt).toContain("You run the roleplay experience");
    expect(prompt).toContain("Present: a conscript sergeant, two customs officers, Alex");
    expect(prompt).toContain("Location: the checkpoint — east gate");
    expect(prompt).toContain("The courier's papers have not been stamped.");
  });

  it("adds nothing to the prompt when there is no scene to report", () => {
    const withoutScene = roleplayPrompt(benchmarkCharacter, "", [memory("An untagged memory.")], []);
    const withEmptyScene = roleplayPrompt(benchmarkCharacter, "", [memory("An untagged memory.")], [], undefined, { sceneState: unknownScene });
    expect(withoutScene).toBe(withEmptyScene);
    expect(withoutScene).not.toContain("CURRENT SCENE");
    expect(withoutScene).not.toContain("PAST EVENTS");
  });
});
