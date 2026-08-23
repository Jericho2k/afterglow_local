import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { characterSchema } from "@/lib/schemas";
import { creationCtaLabel, creationOverview, creationTitle, creationType, primaryCharacterName } from "@/lib/creation";
import { normalizeHashtag } from "@/lib/tags";
import type { Character } from "@/lib/types";

/**
 * The creation model.
 *
 * Everything published is a creation, which may be built around one character,
 * a defined cast, or a scenario with no primary character at all. These assert
 * the two properties the whole redesign rests on: a scenario never needs a
 * fabricated character, and a creation written before any of this existed
 * keeps behaving exactly as it did.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
let account: { id: string; email: string | null } | null = null;

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const characters = await import("@/app/api/characters/route");
const characterDetail = await import("@/app/api/characters/[id]/route");
const { visitorCharacter } = await import("@/lib/access");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
function post(body: unknown) {
  return new Request("http://test/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("creation schema", () => {
  it("infers the structure of a payload written before creations existed", () => {
    const legacy = characterSchema.parse({ name: "The Wayfarers", profileType: "ensemble" });
    expect(legacy.creationType).toBe("cast");
    const single = characterSchema.parse({ name: "Mara" });
    expect(single.creationType).toBe("character");
    expect(single.title).toBe("");
  });

  it("keeps the legacy profile type in step with the creation type", () => {
    expect(characterSchema.parse({ name: "The Final War", creationType: "scenario" }).profileType).toBe("ensemble");
    expect(characterSchema.parse({ name: "Seraphine", creationType: "character", profileType: "ensemble" }).profileType).toBe("single");
  });

  it("stores platform tags and creator hashtags as two separate systems", () => {
    const parsed = characterSchema.parse({
      name: "The Final War",
      creationType: "scenario",
      // Mixed spellings snap onto the taxonomy; unknown tags are still kept.
      tags: ["romance", "Fantasy", "My Own Category"],
      hashtags: ["#MHA", "final war", "villainau", "villainau"],
    });
    expect(parsed.tags).toEqual(["Romance", "Fantasy", "My Own Category"]);
    expect(parsed.hashtags).toEqual(["mha", "finalwar", "villainau"]);
  });

  it("normalises a hashtag into something a URL can carry", () => {
    expect(normalizeHashtag("  #Slow Burn!! ")).toBe("slowburn");
    expect(normalizeHashtag("###")).toBe("");
  });

  it("accepts a scenario with no cast at all", () => {
    const parsed = characterSchema.safeParse({ name: "The Final War", creationType: "scenario", cast: [] });
    expect(parsed.success).toBe(true);
  });
});

describe("creation presentation", () => {
  const base = { creationType: "character" as const, profileType: "single" as const, cast: [], title: "", name: "Seraphine" };

  it("titles a creation with its title, falling back to the name for older records", () => {
    expect(creationTitle(base)).toBe("Seraphine");
    expect(creationTitle({ ...base, title: "Your New Roommate", name: "Emily Carter" })).toBe("Your New Roommate");
  });

  it("does not invent a primary character for a scenario", () => {
    const scenario = { ...base, creationType: "scenario" as const, profileType: "ensemble" as const, title: "The Final War", name: "The Final War" };
    expect(primaryCharacterName(scenario)).toBe("");
    expect(creationCtaLabel(scenario)).toBe("Enter The Final War");
    expect(creationType(scenario)).toBe("scenario");
  });

  it("addresses a character by name and an experience by title", () => {
    expect(creationCtaLabel({ ...base, title: "Your New Roommate", name: "Emily Carter" })).toBe("Chat with Emily Carter");
    expect(creationCtaLabel({ ...base, creationType: "cast", profileType: "ensemble", title: "Roommates From Hell" })).toBe("Enter Roommates From Hell");
  });

  it("treats an old ensemble record as a cast", () => {
    expect(creationType({ creationType: undefined as unknown as Character["creationType"], profileType: "ensemble" })).toBe("cast");
  });

  it("shows the authored description, and the older fallback when there is none", () => {
    const legacy = { description: "", backstory: "She writes poetry.", personality: "Guarded.", scenario: "", creationType: "character" as const, profileType: "single" as const };
    expect(creationOverview(legacy)).toBe("She writes poetry.\n\nGuarded.");
    expect(creationOverview({ ...legacy, description: "A poet who already knows your name." })).toBe("A poet who already knows your name.");
  });
});

describe("public exposure", () => {
  it("keeps instruction fields out of what a visitor receives", () => {
    const character = {
      responseDirective: "Always end on a question.",
      boundaries: "No violence.",
      exampleDialogue: "{{char}}: Hi.",
      sourceMaterial: "The original paste.",
      description: "A poet who already knows your name.",
      backstory: "She writes poetry.",
      cast: [{ name: "Maya", role: "Roommate", description: "Full hidden definition.", tagline: "Keeps the place standing.", avatarPath: "", avatarUrl: "" }],
    } as unknown as Character;
    const visible = visitorCharacter(character);
    expect(visible.responseDirective).toBe("");
    expect(visible.boundaries).toBe("");
    expect(visible.exampleDialogue).toBe("");
    expect(visible.sourceMaterial).toBe("");
    expect(visible.cast[0].description).toBe("");
    // What the creator wrote for readers survives.
    expect(visible.cast[0].tagline).toBe("Keeps the place standing.");
    expect(visible.description).toBe("A poet who already knows your name.");
    expect(visible.backstory).toBe("She writes poetry.");
  });
});

describe("creation persistence", () => {
  beforeEach(async () => {
    const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
    memoryDb.public.registerFunction({
      name: "date_trunc", args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz,
      implementation: (unit: string, value: Date) => { const out = new Date(value); if (unit === "day") out.setHours(0, 0, 0, 0); return out; },
    });
    memoryDb.public.registerFunction({
      name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
      implementation: (value: string, length: number) => value.slice(0, length),
    });
    const adapter = memoryDb.adapters.createPg();
    setPoolForTesting(new adapter.Pool() as unknown as Pool);
    await ensureSchema();
    account = { id: alice, email: null };
  });

  it("round-trips a scenario creation with no characters", async () => {
    const created = await (await characters.POST(post({
      name: "The Final War",
      title: "The Final War",
      creationType: "scenario",
      tagline: "The heroes are running out of options.",
      description: "U.A. is a fortress now, and you are the option nobody wanted to use.",
      userRole: "A sealed asset whose file is classified.",
      scenario: "Every battlefield plan has a weakness.",
      hashtags: ["#mha", "finalwar"],
      tags: ["Adventure"],
      visibility: "public",
    }))).json();

    expect(created.character.creationType).toBe("scenario");
    expect(created.character.title).toBe("The Final War");
    expect(created.character.userRole).toContain("sealed asset");
    expect(created.character.hashtags).toEqual(["mha", "finalwar"]);
    expect(created.character.cast).toEqual([]);

    account = { id: bob, email: null };
    const detail = await (await characterDetail.GET(new Request("http://test"), params(created.character.id))).json();
    expect(detail.character.creationType).toBe("scenario");
    expect(detail.character.title).toBe("The Final War");
    expect(detail.character.description).toContain("fortress");
    expect(detail.character.hashtags).toEqual(["mha", "finalwar"]);
  });

  it("keeps a creation written before this release rendering as it did", async () => {
    // A row from the old schema: an ensemble card, no creation type, no title.
    const id = "cccccccc-0000-4000-8000-000000000001";
    await query(
      "INSERT INTO characters (id,name,profile_type,user_id,visibility,backstory) VALUES ($1,'The Wayfarers','ensemble',$2,'public','They climb the tower.')",
      [id, alice],
    );
    account = { id: bob, email: null };
    const detail = await (await characterDetail.GET(new Request("http://test"), params(id))).json();
    expect(detail.character.creationType).toBe("cast");
    expect(detail.character.title).toBe("");
    expect(creationTitle(detail.character)).toBe("The Wayfarers");
    // With no authored description the public overview still has its text.
    expect(creationOverview(detail.character)).toContain("They climb the tower.");
  });

  it("stores cast portraits and public blurbs alongside the private definition", async () => {
    const created = await (await characters.POST(post({
      name: "Roommates From Hell",
      title: "Roommates From Hell",
      creationType: "cast",
      visibility: "public",
      cast: [
        { name: "Maya", role: "Protective roommate", tagline: "Keeps the place standing.", description: "Hidden definition." },
        { name: "Sophie", role: "Chaotic best friend", tagline: "Owns the toaster feud.", description: "Hidden definition." },
      ],
    }))).json();
    expect(created.character.cast).toHaveLength(2);
    expect(created.character.cast[0].tagline).toBe("Keeps the place standing.");

    account = { id: bob, email: null };
    const detail = await (await characterDetail.GET(new Request("http://test"), params(created.character.id))).json();
    expect(detail.character.cast[0].tagline).toBe("Keeps the place standing.");
    // The visitor sees the cast, never the definitions that steer the model.
    expect(detail.character.cast[0].description).toBe("");
  });
});
