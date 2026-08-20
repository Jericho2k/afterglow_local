import { describe, expect, it } from "vitest";
import { normalizeGeneratedCharacter } from "@/lib/character-import";

describe("character import normalization", () => {
  it("repairs common provider field aliases instead of returning invalid character", () => {
    const character = normalizeGeneratedCharacter(JSON.stringify({
      cardName: "The Night Shift",
      cardType: "Multiple characters",
      color: "not-a-color",
      image: "javascript:alert(1)",
      description: "An adult ensemble working overnight.",
      characters: [
        { characterName: "Eda", relationship: "Lead", details: "Decisive and protective." },
        { name: "Mara", role: "Rival", profile: "Dry, observant, and ambitious." },
      ],
      initialMessage: "The office lights flicker.",
      alternativeGreetings: ["Rain needles the empty car park."],
    }), "verbatim source", true);

    expect(character.name).toBe("The Night Shift");
    expect(character.profileType).toBe("ensemble");
    expect(character.cast).toHaveLength(2);
    expect(character.accent).toBe("#e879a9");
    expect(character.avatarUrl).toBe("");
    expect(character.sourceMaterial).toBe("verbatim source");
  });

  it("recovers JSON surrounded by provider prose or markdown", () => {
    const character = normalizeGeneratedCharacter("Result follows:\n```json\n{\"characterName\":\"Mara\",\"greeting\":\"Hello.\"}\n```", "", false);
    expect(character.name).toBe("Mara");
    expect(character.greeting).toBe("Hello.");
  });
});
