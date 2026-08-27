import { describe, expect, it } from "vitest";
import {
  emptyPhysical, mergePhysical, mergeSceneState, normalizeSceneUpdate, renderCurrentScene,
  renderPhysical, sceneExtractionSystemPrompt, sceneIsEmpty, unknownActor, unknownScene,
  type SceneStateFields,
} from "@/lib/scene-state";
import { estimateTokens } from "@/lib/context";
import type { PhysicalActor, ScenePhysical } from "@/lib/types";

/**
 * Physical continuity.
 *
 * Models twist characters into impossible configurations during intimacy,
 * fights, grappling, dancing, carrying, hugging and bed scenes, and they do it
 * across essentially every model. The reason is structural: nothing in the
 * request carried the arrangement forward, so each reply re-imagined it from
 * the prose.
 *
 * The fix is a small ledger, and the whole difficulty is that a ledger of body
 * positions is one wrong step away from being fiction. Two rules keep it
 * honest, and most of this file is one or the other of them:
 *
 *   UNKNOWN STAYS UNKNOWN. A limb nobody mentioned has no value here and never
 *   acquires one. A confidently wrong hand is worse than no hand at all.
 *
 *   AN ESTABLISHED POSITION PERSISTS UNTIL SOMETHING CHANGES IT. That is what
 *   makes it worth carrying at all — and "something" includes standing up,
 *   leaving the room, and the story moving somewhere else, each of which
 *   invalidates a different amount of what was true a moment ago.
 */

function fields(overrides: Partial<SceneStateFields> = {}): SceneStateFields {
  return {
    ...unknownScene,
    location: { ...unknownScene.location },
    presentCharacters: [],
    activeSituation: [],
    physical: { actors: [], contacts: [], constraints: [] },
    ...overrides,
  };
}

function actor(name: string, overrides: Partial<PhysicalActor> = {}): PhysicalActor {
  return { ...unknownActor(name), ...overrides };
}

function physical(overrides: Partial<ScenePhysical> = {}): ScenePhysical {
  return { actors: [], contacts: [], constraints: [], ...overrides };
}

/** The named actor from a merged arrangement, for readable assertions. */
function find(result: ScenePhysical, name: string) {
  return result.actors.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

const still = { relocated: false, present: null };

describe("an established position persists", () => {
  const seated = physical({
    actors: [actor("Maya", {
      posture: "seated", facing: "the user", support: "the couch",
      leftHand: "on the couch cushion", rightHand: "holding a glass",
      leftFoot: "on the floor", rightFoot: "on the floor",
    })],
    constraints: ["coffee table between them"],
  });

  it("carries every field forward when the update says nothing", () => {
    expect(mergePhysical(seated, {}, still)).toEqual(seated);
  });

  it("changes only the field that was reported", () => {
    const result = mergePhysical(seated, {
      physicalActors: [{ name: "Maya", leftHand: "on the user's knee" }],
    }, still);
    const maya = find(result, "Maya")!;
    expect(maya.leftHand).toBe("on the user's knee");
    // Everything else is exactly where the story left it.
    expect(maya.rightHand).toBe("holding a glass");
    expect(maya.posture).toBe("seated");
    expect(maya.support).toBe("the couch");
    expect(result.constraints).toEqual(["coffee table between them"]);
  });

  it("keeps left and right apart", () => {
    const result = mergePhysical(seated, {
      physicalActors: [{ name: "Maya", rightHand: "in her hair" }],
    }, still);
    expect(find(result, "Maya")!.leftHand).toBe("on the couch cushion");
    expect(find(result, "Maya")!.rightHand).toBe("in her hair");
  });

  it("repositions one leg without disturbing the other", () => {
    const result = mergePhysical(seated, {
      physicalActors: [{ name: "Maya", rightLeg: "folded under her", rightFoot: "" }],
    }, still);
    expect(find(result, "Maya")!.rightLeg).toBe("folded under her");
    expect(find(result, "Maya")!.rightFoot).toBe("");
    expect(find(result, "Maya")!.leftFoot).toBe("on the floor");
  });
});

describe("a change of posture invalidates what it made impossible", () => {
  const seated = physical({
    actors: [actor("Maya", {
      posture: "seated", support: "the couch", facing: "the user",
      leftHand: "on the couch cushion", rightHand: "holding a glass",
      leftFoot: "on the floor", rightFoot: "on the floor",
      held: ["a glass of wine"],
    })],
  });

  it("drops placements the new posture cannot hold", () => {
    // She cannot be standing with a hand on the cushion she was sitting on.
    const result = mergePhysical(seated, { physicalActors: [{ name: "Maya", posture: "standing" }] }, still);
    const maya = find(result, "Maya")!;
    expect(maya.posture).toBe("standing");
    expect(maya.support).toBe("");
    expect(maya.leftHand).toBe("");
    expect(maya.rightHand).toBe("");
    expect(maya.leftFoot).toBe("");
  });

  it("keeps what the same update restated", () => {
    const result = mergePhysical(seated, {
      physicalActors: [{ name: "Maya", posture: "standing", rightHand: "still holding the glass", support: "the floor" }],
    }, still);
    const maya = find(result, "Maya")!;
    expect(maya.rightHand).toBe("still holding the glass");
    expect(maya.support).toBe("the floor");
    expect(maya.leftHand).toBe("");
  });

  it("does not make anybody drop what they are holding", () => {
    const result = mergePhysical(seated, { physicalActors: [{ name: "Maya", posture: "standing" }] }, still);
    expect(find(result, "Maya")!.held).toEqual(["a glass of wine"]);
  });

  it("leaves the arrangement alone when the posture is merely restated", () => {
    const result = mergePhysical(seated, { physicalActors: [{ name: "Maya", posture: "seated" }] }, still);
    expect(find(result, "Maya")!.leftHand).toBe("on the couch cushion");
  });

  it("handles lying down the same way standing up is handled", () => {
    const result = mergePhysical(seated, {
      physicalActors: [{ name: "Maya", posture: "lying", support: "the couch" }],
    }, still);
    const maya = find(result, "Maya")!;
    expect(maya.posture).toBe("lying");
    expect(maya.support).toBe("the couch");
    expect(maya.leftFoot).toBe("");
  });
});

describe("contact begins and ends", () => {
  const apart = physical({
    actors: [actor("Maya", { posture: "seated" }), actor("the user", { posture: "standing" })],
  });

  it("records a new contact", () => {
    const result = mergePhysical(apart, { contacts: ["Maya's hand on the user's chest"] }, still);
    expect(result.contacts).toEqual(["Maya's hand on the user's chest"]);
  });

  it("ends contact on an explicit empty list rather than on silence", () => {
    const touching = mergePhysical(apart, { contacts: ["her hand in his"] }, still);
    // Silence is "no evidence", and must not break a contact the story has not
    // said anything about.
    expect(mergePhysical(touching, {}, still).contacts).toEqual(["her hand in his"]);
    // An empty array is the extractor saying they have separated.
    expect(mergePhysical(touching, { contacts: [] }, still).contacts).toEqual([]);
  });

  it("treats a literal 'none' as ended rather than as a contact called none", () => {
    expect(normalizeSceneUpdate({ contacts: ["none"] }).contacts).toEqual([]);
  });
});

describe("one actor carrying another", () => {
  it("records the arrangement on both bodies and as contact", () => {
    const result = mergePhysical(physical(), {
      physicalActors: [
        { name: "Kaelen", posture: "standing", support: "the floor", leftArm: "under her knees", rightArm: "around her back", held: ["Maya"] },
        { name: "Maya", posture: "carried", support: "Kaelen's arms", relativeTo: "held against Kaelen's chest", leftArm: "around his neck" },
      ],
      contacts: ["Maya carried in Kaelen's arms"],
    }, still);

    expect(find(result, "Maya")!.support).toBe("Kaelen's arms");
    expect(find(result, "Kaelen")!.held).toEqual(["Maya"]);
    expect(result.contacts).toEqual(["Maya carried in Kaelen's arms"]);
  });

  it("clears the carry when she is set down", () => {
    const carried = mergePhysical(physical(), {
      physicalActors: [{ name: "Maya", posture: "carried", support: "Kaelen's arms", leftArm: "around his neck" }],
    }, still);
    const down = mergePhysical(carried, {
      physicalActors: [{ name: "Maya", posture: "standing", support: "the floor" }],
      contacts: [],
    }, still);
    expect(find(down, "Maya")!.leftArm).toBe("");
    expect(down.contacts).toEqual([]);
  });
});

describe("unknown stays unknown", () => {
  it("never invents a limb", () => {
    const result = mergePhysical(physical(), {
      physicalActors: [{ name: "Maya", posture: "standing" }],
    }, still);
    const maya = find(result, "Maya")!;
    expect(maya.leftHand).toBe("");
    expect(maya.rightHand).toBe("");
    expect(maya.leftFoot).toBe("");
    expect(maya.held).toEqual([]);
  });

  it("omits an unreported field from the proposal rather than blanking it", () => {
    // The difference between "not mentioned" and "cleared" is the whole
    // guarantee; a normaliser that filled in empty strings would erase the
    // ledger on every quiet turn.
    const update = normalizeSceneUpdate({ physical: [{ name: "Maya", posture: "seated" }] });
    expect(update.physicalActors).toEqual([{ name: "Maya", posture: "seated" }]);
    expect(update.physicalActors?.[0]).not.toHaveProperty("leftHand");
  });

  it("honours an explicit 'unknown' as a retraction", () => {
    const update = normalizeSceneUpdate({ physical: [{ name: "Maya", left_hand: "unknown" }] });
    expect(update.physicalActors?.[0].leftHand).toBe("");
    const before = physical({ actors: [actor("Maya", { posture: "seated", leftHand: "on the cushion" })] });
    expect(find(mergePhysical(before, update, still), "Maya")!.leftHand).toBe("");
  });

  it("drops an actor with a name and nothing else", () => {
    const result = mergePhysical(physical(), { physicalActors: [{ name: "Nobody" }] }, still);
    expect(result.actors).toEqual([]);
  });

  it("renders nothing at all when nothing is established", () => {
    expect(renderPhysical(emptyPhysical)).toBe("");
    expect(sceneIsEmpty(fields())).toBe(true);
  });
});

describe("leaving the scene takes the body with it", () => {
  it("drops an actor who is no longer present", () => {
    const together = physical({
      actors: [actor("Maya", { posture: "seated" }), actor("Kaelen", { posture: "standing" })],
    });
    const result = mergePhysical(together, {}, { relocated: false, present: ["Maya"] });
    expect(result.actors.map((entry) => entry.name)).toEqual(["Maya"]);
  });

  it("keeps somebody who is both present and newly described", () => {
    const result = mergePhysical(physical(), {
      physicalActors: [{ name: "Maya", posture: "kneeling" }],
    }, { relocated: false, present: ["Maya", "the user"] });
    expect(find(result, "Maya")!.posture).toBe("kneeling");
  });
});

describe("moving or skipping a day clears the arrangement", () => {
  const inRoom = fields({
    location: { place: "Maya's apartment", sub: "living room", confidence: "stated" },
    storyDay: 3,
    physical: physical({
      actors: [actor("Maya", { posture: "seated", support: "the couch" })],
      contacts: ["her hand in his"],
      constraints: ["coffee table between them"],
    }),
  });

  it("forgets a position established somewhere else", () => {
    const moved = mergeSceneState(inRoom, {
      location: { place: "the car", sub: "", confidence: "stated" },
    });
    expect(moved.fields.physical).toEqual(emptyPhysical);
    expect(moved.changed).toContain("physical");
  });

  it("forgets a position established on another day", () => {
    const tomorrow = mergeSceneState(inRoom, { dayAdvance: 1, dayAdvanceEvidence: "the next morning" });
    expect(tomorrow.fields.physical).toEqual(emptyPhysical);
  });

  it("keeps it when the scene merely continues in the same place", () => {
    const later = mergeSceneState(inRoom, { activeSituation: ["she has not answered"] });
    expect(later.fields.physical.actors).toHaveLength(1);
    expect(later.changed).not.toContain("physical");
  });

  it("accepts a new arrangement in the same breath as the move", () => {
    const moved = mergeSceneState(inRoom, {
      location: { place: "the car", sub: "", confidence: "stated" },
      physicalActors: [{ name: "Maya", posture: "seated", support: "the passenger seat" }],
    });
    expect(find(moved.fields.physical, "Maya")!.support).toBe("the passenger seat");
    // And nothing survived from the living room.
    expect(moved.fields.physical.contacts).toEqual([]);
  });
});

describe("the block the writer reads", () => {
  const arrangement = physical({
    actors: [
      actor("Maya", {
        posture: "seated", facing: "the user", support: "the couch",
        leftHand: "on the couch cushion", rightHand: "holding a glass",
        leftFoot: "on the floor", rightFoot: "on the floor",
      }),
      actor("the user", { posture: "standing", relativeTo: "directly in front of her" }),
    ],
    constraints: ["coffee table between them"],
  });

  it("lists only what is established, and says that omission means unknown", () => {
    const rendered = renderPhysical(arrangement);
    expect(rendered).toContain("anything not listed is unknown, so do not invent it");
    expect(rendered).toContain("Maya: seated; on the couch; facing the user; left hand on the couch cushion");
    expect(rendered).toContain("the user: standing; position directly in front of her");
    expect(rendered).toContain("Constraints: coffee table between them");
    // No row of blanks for the limbs nobody described.
    expect(rendered).not.toContain("right arm");
    expect(rendered).not.toContain("Contact:");
  });

  it("appears inside the CURRENT SCENE block rather than as a second one", () => {
    const scene = renderCurrentScene(fields({
      location: { place: "Maya's apartment", sub: "living room", confidence: "stated" },
      presentCharacters: ["Maya", "the user"],
      physical: arrangement,
    }));
    expect(scene.indexOf("Physical arrangement")).toBeGreaterThan(scene.indexOf("Location:"));
    expect(scene.split("CURRENT SCENE").length - 1).toBe(1);
  });

  it("stays compact enough to send every turn", () => {
    // Two actors in a fully described close-contact scene. The budget this has
    // to live inside is a per-turn one, so a block that grew into a paragraph
    // of prose would be paid for on every single reply.
    expect(estimateTokens(renderPhysical(arrangement))).toBeLessThan(120);
  });

  it("costs nothing at all in a scene with no physical detail", () => {
    const scene = renderCurrentScene(fields({
      location: { place: "a street", sub: "", confidence: "stated" },
      presentCharacters: ["Maya", "the user"],
    }));
    expect(scene).not.toContain("Physical arrangement");
  });

  it("caps a crowded scene rather than growing without limit", () => {
    const crowd = physical({
      actors: Array.from({ length: 12 }, (_, index) => actor(`Person ${index}`, { posture: "standing" })),
    });
    const result = mergePhysical(crowd, {}, still);
    expect(result.actors.length).toBeLessThanOrEqual(6);
  });
});

describe("the extractor is told the rules, not just the shape", () => {
  const prompt = sceneExtractionSystemPrompt();

  it("asks for the fields the ledger holds", () => {
    for (const field of ["posture", "support", "left_hand", "right_hand", "left_foot", "held", "contacts", "constraints"]) {
      expect(prompt).toContain(field);
    }
  });

  it("says to omit rather than guess", () => {
    expect(prompt).toContain("OMIT any field the story has not established");
    expect(prompt).toContain("a wrong hand is worse than no hand");
  });

  it("says when the detail matters and when it does not", () => {
    expect(prompt).toContain("Intimacy, fights, grappling, dancing, carrying");
    expect(prompt).toContain("Two people walking down a street");
  });

  it("refuses to pick a side when the story did not", () => {
    expect(prompt).toContain("leave both hands alone rather than choosing one");
  });

  it("keeps each field a placement rather than a sentence", () => {
    expect(prompt).toContain("short placement, not a sentence");
    expect(normalizeSceneUpdate({ physical: [{ name: "Maya", posture: "x".repeat(400) }] }).physicalActors?.[0].posture?.length)
      .toBeLessThanOrEqual(90);
  });
});

describe("a malformed proposal cannot corrupt the ledger", () => {
  it("ignores junk", () => {
    expect(normalizeSceneUpdate({ physical: "not an array" }).physicalActors).toBeUndefined();
    expect(normalizeSceneUpdate({ physical: [null, 4, "x"] }).physicalActors).toBeUndefined();
    expect(normalizeSceneUpdate({ contacts: "not an array" }).contacts).toBeUndefined();
  });

  it("accepts both snake_case and camelCase from a model", () => {
    const snake = normalizeSceneUpdate({ physical: [{ name: "Maya", left_hand: "on the rail" }] });
    const camel = normalizeSceneUpdate({ physical: [{ name: "Maya", leftHand: "on the rail" }] });
    expect(snake.physicalActors?.[0].leftHand).toBe("on the rail");
    expect(camel.physicalActors?.[0].leftHand).toBe("on the rail");
  });

  it("caps the number of actors it will accept", () => {
    const many = normalizeSceneUpdate({
      physical: Array.from({ length: 20 }, (_, index) => ({ name: `Person ${index}`, posture: "standing" })),
    });
    expect(many.physicalActors?.length).toBeLessThanOrEqual(6);
  });
});
