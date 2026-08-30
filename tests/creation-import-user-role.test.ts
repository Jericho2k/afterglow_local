import { describe, expect, it } from "vitest";
import { isReaderCastEntry, maxAlternateGreetings, normalizeCreationResult } from "@/lib/creation-ai";
import { importOrganizePrompt, quickIdeaPrompt } from "@/lib/creation-prompts";

/**
 * The reader is not a cast member, and openings do not vanish.
 *
 * Two reports, one shape: the importer answering with something the source did
 * not contain, or losing something it did.
 *
 * A cast is the set of characters AFTERGLOW PORTRAYS. Putting the reader in it
 * is not a cosmetic mistake — the writer prompt then treats them as somebody it
 * plays, which means speaking for the reader and deciding what they do, the one
 * thing every other part of the prompt forbids. It also changed what the
 * creation IS: one character plus a described reader arrived as a two-person
 * Cast.
 */

const json = (value: Record<string, unknown>) => JSON.stringify(value);

describe("a described reader never becomes a cast member", () => {
  it.each([
    "User", "user", "{{user}}", "{{ user }}", "<USER>", "[User]", "You",
    "The User", "the player", "Player", "Reader", "You (the user)", "Player Character", "User Persona",
  ])("drops a cast entry called %s", (name) => {
    const { draft } = normalizeCreationResult(json({
      creationType: "cast",
      title: "The Night Shift",
      cast: [
        { name: "Maya", description: "The charge nurse who runs the ward." },
        { name, description: "You are a new hire on your first week." },
      ],
    }));
    expect(draft.cast.map((member) => member.name)).toEqual(["Maya"]);
  });

  it("keeps a real character whose name merely contains one of those words", () => {
    const { draft } = normalizeCreationResult(json({
      creationType: "cast",
      cast: [
        { name: "Userous the Grey", description: "A wizard." },
        { name: "Playerton", description: "A footballer." },
        { name: "Reader's Digest Guy", description: "A salesman." },
      ],
    }));
    expect(draft.cast.map((member) => member.name)).toEqual(["Userous the Grey", "Playerton", "Reader's Digest Guy"]);
  });

  it("honours an explicit flag from the model", () => {
    expect(isReaderCastEntry({ name: "Alex", isUser: true })).toBe(true);
    expect(isReaderCastEntry({ name: "Alex", isPlayer: "yes" })).toBe(true);
    expect(isReaderCastEntry({ name: "Alex" })).toBe(false);
  });

  it("moves what the entry said into the reader's role instead of discarding it", () => {
    const { draft, notices } = normalizeCreationResult(json({
      creationType: "character",
      name: "Maya",
      cast: [{ name: "{{user}}", description: "You are her estranged younger brother, back after six years." }],
    }));
    expect(draft.cast).toEqual([]);
    expect(draft.userRole).toContain("estranged younger brother");
    expect(notices.some((notice) => notice.message.includes("Your role in this story"))).toBe(true);
  });

  it("does not overwrite a userRole the model already wrote", () => {
    const { draft } = normalizeCreationResult(json({
      userRole: "You play the detective assigned to the case.",
      cast: [{ name: "User", description: "You are somebody else entirely." }],
    }));
    expect(draft.userRole).toBe("You play the detective assigned to the case.");
  });
});

describe("a character does not become a cast because the reader was described", () => {
  it("keeps one character with a reader role as a Character", () => {
    const { draft, notices } = normalizeCreationResult(json({
      // The model answered "cast" because it counted the reader.
      creationType: "cast",
      title: "Seraphine",
      name: "Seraphine",
      cast: [
        { name: "Seraphine", description: "The only character in the source." },
        { name: "You", description: "You are her apprentice." },
      ],
    }));
    expect(draft.creationType).toBe("character");
    expect(draft.profileType).toBe("single");
    expect(draft.cast.map((member) => member.name)).toEqual(["Seraphine"]);
    expect(notices.some((notice) => notice.message.includes("not a cast"))).toBe(true);
  });

  it("leaves a genuine multi-character cast as a Cast", () => {
    const { draft } = normalizeCreationResult(json({
      creationType: "cast",
      title: "Roommates",
      cast: [
        { name: "Maya", description: "Night-shift nurse." },
        { name: "Sophie", description: "Art student." },
        { name: "User", description: "You are the third roommate." },
      ],
    }));
    expect(draft.creationType).toBe("cast");
    expect(draft.cast.map((member) => member.name)).toEqual(["Maya", "Sophie"]);
  });

  it("never overrides a structure the creator chose", () => {
    const { draft } = normalizeCreationResult(json({
      creationType: "cast",
      cast: [{ name: "Seraphine", description: "One." }, { name: "User", description: "You." }],
    }), { creationType: "cast" });
    expect(draft.creationType).toBe("cast");
  });

  it("keeps a scenario's reader role out of the cast", () => {
    const { draft } = normalizeCreationResult(json({
      creationType: "scenario",
      title: "Blackwater Station",
      userRole: "You are the incoming station chief.",
      cast: [{ name: "The User", description: "You are the incoming station chief." }],
    }));
    expect(draft.creationType).toBe("scenario");
    expect(draft.cast).toEqual([]);
    expect(draft.userRole).toContain("station chief");
  });

  it("keeps {{user}} mentions inside prose exactly as written", () => {
    const dialogue = "{{char}}: Good to see you.\n{{user}}: You too.";
    const { draft } = normalizeCreationResult(json({
      name: "Maya", exampleDialogue: dialogue, greeting: "{{user}} pushes the door open.",
    }));
    expect(draft.exampleDialogue).toBe(dialogue);
    expect(draft.greeting).toContain("{{user}}");
    expect(draft.cast).toEqual([]);
  });
});

describe("openings survive the import", () => {
  it("keeps a primary greeting and every alternate", () => {
    const { draft } = normalizeCreationResult(json({
      name: "Maya",
      greeting: "The ward is quiet when you arrive.",
      alternateGreetings: ["She is already waiting outside.", "You find her asleep in the chair.", "The pager goes off before you speak."],
    }));
    expect(draft.greeting).toBe("The ward is quiet when you arrive.");
    expect(draft.alternateGreetings).toHaveLength(3);
  });

  it("promotes the first opening when the primary is empty", () => {
    const { draft } = normalizeCreationResult(json({
      name: "Maya", greeting: "", alternateGreetings: ["The only opening there is.", "A second one."],
    }));
    expect(draft.greeting).toBe("The only opening there is.");
    expect(draft.alternateGreetings).toEqual(["A second one."]);
  });

  it("accepts the aliases real cards use", () => {
    const { draft } = normalizeCreationResult(json({
      name: "Maya", firstMessage: "Primary.", alternativeGreetings: ["Second.", "Third."],
    }));
    expect(draft.greeting).toBe("Primary.");
    expect(draft.alternateGreetings).toEqual(["Second.", "Third."]);
  });

  it("says so rather than silently dropping openings past the limit", () => {
    const openings = Array.from({ length: 20 }, (_, index) => `Opening ${index + 1}.`);
    const { draft, notices } = normalizeCreationResult(json({ name: "Maya", alternateGreetings: openings }));
    expect(draft.greeting).toBe("Opening 1.");
    expect(draft.alternateGreetings).toHaveLength(maxAlternateGreetings);
    // The product limit is real; losing them without a word is the bug.
    const notice = notices.find((item) => item.message.includes("openings were found"));
    expect(notice).toBeTruthy();
    expect(notice?.message).toContain("not imported");
  });

  it("drops blank and duplicate openings without losing the real ones", () => {
    const { draft } = normalizeCreationResult(json({
      name: "Maya", greeting: "The real one.", alternateGreetings: ["", "   ", "The real one.", "A different one."],
    }));
    expect(draft.greeting).toBe("The real one.");
    expect(draft.alternateGreetings).toEqual(["A different one."]);
  });

  it("reports a truncated response instead of presenting a short import as complete", () => {
    const truncated = '{"name":"Maya","greeting":"The ward is quiet.","alternateGreetings":["She is waiting","The pager goes';
    const { draft, notices, stats } = normalizeCreationResult(truncated);
    expect(draft.greeting).toBe("The ward is quiet.");
    expect(stats.repair).toBe("truncated");
    expect(notices.some((notice) => notice.kind === "source" && notice.message.includes("cut short"))).toBe(true);
  });

  it("asks for the openings before the long prose, so a cut response loses prose", () => {
    for (const prompt of [quickIdeaPrompt({ idea: "A night nurse." }), importOrganizePrompt({ source: "A night nurse." })]) {
      const start = prompt.lastIndexOf("Return ONLY valid JSON");
      const contract = prompt.slice(start, prompt.indexOf("\n}", start) + 2);
      expect(contract.indexOf('"greeting"')).toBeLessThan(contract.indexOf('"backstory"'));
      expect(contract.indexOf('"alternateGreetings"')).toBeLessThan(contract.indexOf('"scenario"'));
    }
  });
});

describe("the prompt says it too", () => {
  it("tells the model the reader is never a cast entry", () => {
    for (const prompt of [quickIdeaPrompt({ idea: "x" }), importOrganizePrompt({ source: "x" })]) {
      expect(prompt).toContain("THE READER IS NOT A CAST MEMBER");
      expect(prompt).toContain("one defined character plus a described reader is a CHARACTER");
    }
  });
});
