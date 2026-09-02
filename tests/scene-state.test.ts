import { describe, expect, it } from "vitest";
import {
  arcSceneTag, locationLabel, mergeSceneState, normalizeSceneUpdate, renderCurrentScene,
  sceneRetrievalCue, sceneStateTokens, sceneTag, timeLabel, unknownScene, type SceneStateFields,
} from "@/lib/scene-state";
import { roleplayPrompt } from "@/lib/prompts";
import { arc, benchmarkCharacter, memory, present, scene, scenarioCreation } from "./fixtures/scene-continuity";

/**
 * The rules that make the Scene Ledger safe are all in the merge: what
 * persists, what may change, and what must stay unknown. They are tested here
 * without a model so a regression is unambiguous rather than a sampling
 * accident.
 */

const apartment: SceneStateFields = scene({
  storyDay: 4,
  time: { kind: "period", text: "evening" },
  location: { place: "Maya's apartment", sub: "living room", confidence: "stated" },
  present: [{ name: "Maya", position: "on the sofa" }, { name: "Alex", position: "beside Maya" }],
});

/** A window the extractor found nothing new in — the overwhelmingly common case. */
const noEvidence = normalizeSceneUpdate({});

describe("scene ledger merge", () => {
  it("A — keeps the location through ten turns with no movement", () => {
    let fields = apartment;
    for (let turn = 0; turn < 10; turn += 1) fields = mergeSceneState(fields, noEvidence).fields;
    expect(locationLabel(fields.location)).toBe("Maya's apartment — living room");
    expect(fields.present.map((person) => person.name)).toEqual(["Maya", "Alex"]);
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

  it("B — moving keeps the people and drops positions that belonged to the old room", () => {
    const result = mergeSceneState(apartment, normalizeSceneUpdate({
      location: { place: "Maya's apartment", sub: "kitchen", confidence: "stated" },
    }));
    expect(result.fields.present.map((person) => person.name)).toEqual(["Maya", "Alex"]);
    expect(result.fields.present.every((person) => person.position === "")).toBe(true);
  });

  it("D — advances chronology on explicit narrative evidence", () => {
    const result = mergeSceneState(apartment, normalizeSceneUpdate({
      day_advance: 3, day_advance_evidence: "Three days later, the rain finally stopped.",
    }));
    expect(result.fields.storyDay).toBe(7);
    expect(result.changed).toContain("story_day");
    // A time belonged to the day that ended; it is wrong now, not merely stale.
    expect(result.fields.time).toEqual({ kind: "unknown", text: "" });
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
      location: { place: "the dormitory", sub: "common room", confidence: "stated" },
      time: { kind: "period", text: "morning" },
    })).fields;
    for (let turn = 0; turn < 8; turn += 1) fields = mergeSceneState(fields, noEvidence).fields;
    expect(fields.dateKind).toBe("unknown");
    expect(fields.dateText).toBe("");
    expect(fields.time).toEqual({ kind: "period", text: "morning" });
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
});

/**
 * TIME PRECISION.
 *
 * The old ledger had two fields — a broad period and an optional exact clock
 * reading — and therefore had no way to hold "around nine" or "a few minutes
 * later" without either inventing precision or losing it. These assert that the
 * precision the story gave is the precision the ledger keeps, in both
 * directions.
 */
describe("scene ledger time precision", () => {
  it("keeps a clock reading exact", () => {
    expect(normalizeSceneUpdate({ time: { kind: "exact", text: "21:37" } }).time).toEqual({ kind: "exact", text: "21:37" });
    expect(normalizeSceneUpdate({ time: { kind: "exact", text: "9 PM" } }).time).toEqual({ kind: "exact", text: "9 PM" });
  });

  it("keeps an approximate time approximate rather than rounding it to a clock", () => {
    const update = normalizeSceneUpdate({ time: { kind: "approximate", text: "around 9 PM" } });
    expect(update.time).toEqual({ kind: "approximate", text: "around 9 PM" });
    expect(timeLabel(update.time!)).toBe("around 9 PM (approximate)");
  });

  it("keeps a period a period, and never promotes one to a time", () => {
    const update = normalizeSceneUpdate({ time: { kind: "period", text: "late evening" } });
    expect(update.time).toEqual({ kind: "period", text: "late evening" });
    expect(timeLabel(update.time!)).toBe("late evening");
  });

  it("holds a relative time and says what it is relative to", () => {
    const update = normalizeSceneUpdate({ time: { kind: "relative", text: "a few minutes later" } });
    expect(update.time).toEqual({ kind: "relative", text: "a few minutes later" });
    expect(timeLabel(update.time!)).toContain("relative to the previous beat");
  });

  it("demotes a claimed exact time that is not actually a clock reading", () => {
    // The one direction that can invent information: a model labelling "late
    // evening" as exact is claiming a precision the story never gave.
    expect(normalizeSceneUpdate({ time: { kind: "exact", text: "late evening" } }).time)
      .toEqual({ kind: "approximate", text: "late evening" });
  });

  it("treats an unknown or missing time as no evidence at all", () => {
    expect(normalizeSceneUpdate({ time: { kind: "unknown", text: "" } }).time).toBeUndefined();
    expect(normalizeSceneUpdate({ time: { kind: "period", text: "unknown" } }).time).toBeUndefined();
    expect(normalizeSceneUpdate({}).time).toBeUndefined();
    // And an omitted time leaves the established one alone.
    expect(mergeSceneState(apartment, normalizeSceneUpdate({})).fields.time).toEqual({ kind: "period", text: "evening" });
  });
});

/**
 * WHO IS IN THE ROOM.
 *
 * The reported failure this exists to fix: three people enter, the user talks
 * to one of them for thirty messages, and the other two disappear from the
 * writer's view because no recent extraction window mentioned them.
 */
describe("scene ledger presence", () => {
  const crowded = scene({
    storyDay: 2,
    location: { place: "the flat", sub: "living room", confidence: "stated" },
    present: [
      { name: "User", position: "on sofa" },
      { name: "Maya", position: "beside User" },
      { name: "Anna", position: "near window" },
    ],
  });

  it("G — thirty quiet turns do not remove anybody who was never shown leaving", () => {
    let fields = crowded;
    for (let turn = 0; turn < 30; turn += 1) {
      // The realistic window: the extractor saw an exchange between two of the
      // three and reported only what it saw.
      fields = mergeSceneState(fields, normalizeSceneUpdate({ present: [{ name: "Maya", position: "beside User" }] })).fields;
    }
    expect(fields.present.map((person) => person.name)).toEqual(["User", "Maya", "Anna"]);
    expect(fields.present.find((person) => person.name === "Anna")?.position).toBe("near window");
  });

  it("G — an empty present list never empties the room", () => {
    expect(mergeSceneState(crowded, normalizeSceneUpdate({ present: [] })).fields.present).toHaveLength(3);
  });

  it("G — departure is the only thing that removes somebody", () => {
    const result = mergeSceneState(crowded, normalizeSceneUpdate({ departed: ["Anna"] }));
    expect(result.fields.present.map((person) => person.name)).toEqual(["User", "Maya"]);
    expect(result.changed).toContain("present");
  });

  it("H — puts a character back when they return, with wherever they now are", () => {
    const left = mergeSceneState(crowded, normalizeSceneUpdate({ departed: ["Anna"] })).fields;
    const back = mergeSceneState(left, normalizeSceneUpdate({ present: [{ name: "Anna", position: "in the doorway" }] })).fields;
    expect(back.present.map((person) => person.name)).toEqual(["User", "Maya", "Anna"]);
    expect(back.present.find((person) => person.name === "Anna")?.position).toBe("in the doorway");
  });

  it("updates a position without disturbing anybody else", () => {
    const moved = mergeSceneState(crowded, normalizeSceneUpdate({ present: [{ name: "Anna", position: "at the table" }] })).fields;
    expect(moved.present.find((person) => person.name === "Anna")?.position).toBe("at the table");
    expect(moved.present.find((person) => person.name === "User")?.position).toBe("on sofa");
  });

  it("keeps an established position when a later report has nothing to say about it", () => {
    const again = mergeSceneState(crowded, normalizeSceneUpdate({ present: [{ name: "Anna" }] })).fields;
    expect(again.present.find((person) => person.name === "Anna")?.position).toBe("near window");
  });

  it("a new day re-establishes the room rather than inheriting yesterday's", () => {
    const tomorrow = mergeSceneState(crowded, normalizeSceneUpdate({
      day_advance: 1, day_advance_evidence: "The next morning",
      present: [{ name: "User", position: "" }],
    })).fields;
    expect(tomorrow.present.map((person) => person.name)).toEqual(["User"]);
  });

  it("matches an existing person case-insensitively rather than duplicating them", () => {
    const result = mergeSceneState(crowded, normalizeSceneUpdate({ present: [{ name: "anna", position: "at the door" }] })).fields;
    expect(result.present).toHaveLength(3);
    expect(result.present.find((person) => person.name.toLowerCase() === "anna")?.position).toBe("at the door");
  });
});

describe("scene ledger input bounding", () => {
  it("bounds everything a model can propose", () => {
    const update = normalizeSceneUpdate({
      location: { place: "x".repeat(400), sub: "y".repeat(400), confidence: "hallucinated" },
      present: Array.from({ length: 30 }, (_, index) => ({ name: `Person ${index}`, position: "z".repeat(200) })),
      departed: Array.from({ length: 30 }, (_, index) => `Gone ${index}`),
      day_advance: 999_999, day_advance_evidence: "z".repeat(900),
    });
    expect(update.location?.place.length).toBe(120);
    expect(update.location?.confidence).toBe("inferred");
    expect(update.present).toHaveLength(8);
    expect(update.present?.[0].position.length).toBe(60);
    expect(update.departed).toHaveLength(8);
    expect(update.dayAdvance).toBe(3650);
    expect(update.dayAdvanceEvidence?.length).toBe(200);
  });

  it("accepts a bare name, because that is what a model emits with nothing to add", () => {
    expect(normalizeSceneUpdate({ present: ["Maya", "Anna"] }).present)
      .toEqual([{ name: "Maya", position: "" }, { name: "Anna", position: "" }]);
  });

  it("reads a position of \"unknown\" as no position rather than as one", () => {
    expect(normalizeSceneUpdate({ present: [{ name: "Maya", position: "unknown" }] }).present)
      .toEqual([{ name: "Maya", position: "" }]);
  });

  it("survives a model that returns something other than an object", () => {
    expect(normalizeSceneUpdate(null)).toEqual({});
    expect(normalizeSceneUpdate("nonsense")).toEqual({});
    expect(mergeSceneState(apartment, normalizeSceneUpdate([])).fields.location.place).toBe("Maya's apartment");
  });

  it("ignores the fields the old physical simulation used to carry", () => {
    // A model prompted from a cached older instruction set, or one improvising,
    // must not be able to put limb geometry back into the ledger.
    const update = normalizeSceneUpdate({
      physical: [{ name: "Maya", posture: "seated", left_hand: "on the cushion" }],
      contacts: ["Maya's hand on Alex's chest"],
      constraints: ["coffee table between them"],
      active_situation: ["They planned to watch a film."],
    });
    expect(update).toEqual({});
  });
});

describe("scene ledger rendering", () => {
  it("stays inside a small prompt budget", () => {
    const tokens = sceneStateTokens(scene({
      storyDay: 12, dateKind: "exact", dateText: "2026-10-17",
      time: { kind: "approximate", text: "just past eleven" },
      location: { place: "Maya's apartment", sub: "bedroom", confidence: "stated" },
      present: [{ name: "Maya", position: "on the bed" }, { name: "Alex", position: "in the doorway" }],
    }));
    expect(tokens).toBeGreaterThan(30);
    expect(tokens).toBeLessThanOrEqual(140);
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

  it("shows each person with their rough position and says they are all still here", () => {
    const rendered = renderCurrentScene(scene({
      storyDay: 3, location: { place: "the flat", sub: "living room", confidence: "stated" },
      present: [{ name: "User", position: "on sofa" }, { name: "Maya", position: "beside User" }, { name: "Anna", position: "near window" }],
    }));
    expect(rendered).toContain("Present: User (on sofa), Maya (beside User), Anna (near window)");
    expect(rendered).toContain("Everyone listed under Present is still here.");
  });

  it("carries no trace of the physical simulation it replaced", () => {
    const rendered = renderCurrentScene(apartment);
    for (const gone of ["Physical arrangement", "left hand", "right hand", "Contact:", "Constraints:", "Active situation"]) {
      expect(rendered).not.toContain(gone);
    }
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
      storyDay: 9, time: { kind: "period", text: "night" },
      location: { place: "the safehouse", sub: "kitchen", confidence: "stated" },
      present: present("Sera", "Kit"),
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
        sceneState: scene({
          storyDay: 12, time: { kind: "period", text: "late evening" },
          location: { place: "Uki's apartment", sub: "couch", confidence: "stated" },
          present: present("Uki", "Alex"),
        }),
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
        storyDay: 2, time: { kind: "period", text: "night" },
        location: { place: "the checkpoint", sub: "east gate", confidence: "stated" },
        present: [
          { name: "a conscript sergeant", position: "at the barrier" },
          { name: "two customs officers", position: "in the hut" },
          { name: "Alex", position: "" },
        ],
      }),
    });
    expect(prompt).toContain("You run the roleplay experience");
    expect(prompt).toContain("Present: a conscript sergeant (at the barrier), two customs officers (in the hut), Alex");
    expect(prompt).toContain("Location: the checkpoint — east gate");
  });

  it("adds nothing to the prompt when there is no scene to report", () => {
    const withoutScene = roleplayPrompt(benchmarkCharacter, "", [memory("An untagged memory.")], []);
    const withEmptyScene = roleplayPrompt(benchmarkCharacter, "", [memory("An untagged memory.")], [], undefined, { sceneState: unknownScene });
    expect(withoutScene).toBe(withEmptyScene);
    expect(withoutScene).not.toContain("CURRENT SCENE");
    expect(withoutScene).not.toContain("PAST EVENTS");
  });
});
