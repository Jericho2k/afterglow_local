import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCreationResult } from "@/lib/creation-ai";
import { importOrganizePrompt, quickIdeaPrompt } from "@/lib/creation-prompts";
import { blankCastMember, draftFromCharacter, draftPayload, draftProblems } from "@/components/studio/draft";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";
import type { Character } from "@/lib/types";

/**
 * Cast members, end to end.
 *
 * Two independent failures were losing them, and they failed in different
 * places for different reasons:
 *
 *   ADDING. "Add character" appends an empty member for the creator to type
 *   into. That is editing state, not a person — but it was sent to the server
 *   and failed `name: min(1)`, so the WHOLE creation refused to save with
 *   "cast → 1 → name: Too small". Fifty finished fields rejected because one
 *   placeholder had not been filled in yet.
 *
 *   IMPORTING. `cast` sat second from last in the output contract, right after
 *   the two longest prose fields. Output is capped, a long import reaches the
 *   cap, and the repair pass discards the partial tail — so on exactly the
 *   sources a cast matters for, the cast was the first thing to vanish while
 *   everything else survived.
 */

const alice = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: alice, email: null };

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, setPoolForTesting } = await import("@/lib/db");
const characters = await import("@/app/api/characters/route");
const characterDetail = await import("@/app/api/characters/[id]/route");

const member = (name: string, extra: Record<string, string> = {}) =>
  ({ name, role: `${name}'s part`, tagline: `${name} in one line`, description: `${name}'s private definition`, ...extra });

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
  setPoolForTesting(new (memoryDb.adapters.createPg()).Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: alice, email: null };
});

/** AI output → studio draft → save payload → API → reopen. The whole journey. */
async function importAndSave(aiOutput: Record<string, unknown>, sourceMaterial = "the original paste") {
  const { draft } = normalizeCreationResult(JSON.stringify(aiOutput), { sourceMaterial });
  const studio = draftFromCharacter(draft as unknown as Character);
  const payload = { ...draftPayload(studio), lorebook: "" };
  const created = await characters.POST(new Request("http://test/api/characters", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));
  const body = await created.json();
  if (created.status !== 201) return { status: created.status, body, reopened: null };
  const detail = await characterDetail.GET(
    new Request(`http://test/api/characters/${body.character.id}`),
    { params: Promise.resolve({ id: body.character.id }) },
  );
  return { status: created.status, body, reopened: await detail.json() };
}

describe("an imported cast survives the whole journey", () => {
  it("carries a single character with no cast", async () => {
    const result = await importAndSave({
      creationType: "character", title: "Seraphine", name: "Seraphine",
      personality: "Dry, watchful.", greeting: "She does not look up.", cast: [],
    });
    expect(result.status).toBe(201);
    expect(result.body.character.creationType).toBe("character");
    expect(result.body.character.cast).toEqual([]);
  });

  it("carries a two-member cast", async () => {
    const result = await importAndSave({
      creationType: "cast", title: "Roommates", name: "Roommates",
      scenario: "The lease is up in eleven months.",
      cast: [member("Maya"), member("Sophie")],
    });
    expect(result.status).toBe(201);
    expect(result.body.character.creationType).toBe("cast");
    expect(result.body.character.cast.map((entry: { name: string }) => entry.name)).toEqual(["Maya", "Sophie"]);
    // Reopened from the database, not from the response that wrote it.
    expect(result.reopened.character.cast.map((entry: { name: string }) => entry.name)).toEqual(["Maya", "Sophie"]);
  });

  it("carries a large cast, every member, in order", async () => {
    const names = ["Maya", "Sophie", "Alex", "Rui", "Dagny", "Peter", "Ines", "Kwame", "Lior", "Nora"];
    const result = await importAndSave({
      creationType: "cast", title: "The Whole Building", name: "The Whole Building",
      scenario: "Eleven flats, one boiler.",
      cast: names.map((name) => member(name)),
    });
    expect(result.status).toBe(201);
    expect(result.reopened.character.cast.map((entry: { name: string }) => entry.name)).toEqual(names);
    // Every member gains a stable id on save, so its page has an address.
    for (const entry of result.reopened.character.cast) expect(entry.id).toMatch(/^[a-f0-9]{24}$/);
    // And the public half stays public while the definition stays private.
    expect(result.reopened.character.cast[0].tagline).toBe("Maya in one line");
    expect(result.reopened.character.cast[0].description).toBe("Maya's private definition");
  });

  it("keeps a scenario's optional cast without turning it into a cast creation", async () => {
    const result = await importAndSave({
      creationType: "scenario", title: "The Final War", name: "The Final War",
      scenario: "The armistice held for nine days.",
      responseDirective: "Narrate; play every NPC.",
      cast: [member("General Aster"), member("The Envoy")],
    });
    expect(result.status).toBe(201);
    expect(result.body.character.creationType).toBe("scenario");
    expect(result.reopened.character.cast.map((entry: { name: string }) => entry.name))
      .toEqual(["General Aster", "The Envoy"]);
  });

  it("does not collapse a cast into a single character", async () => {
    const { draft } = normalizeCreationResult(JSON.stringify({
      title: "Roommates", name: "Roommates", cast: [member("Maya"), member("Sophie"), member("Alex")],
    }), {});
    // No explicit creationType from the model and none chosen by the creator:
    // three defined people is a cast, and none of them is demoted.
    expect(draft.creationType).toBe("cast");
    expect(draft.cast).toHaveLength(3);
  });

  it("fabricates nobody the source did not contain", async () => {
    const { draft } = normalizeCreationResult(JSON.stringify({
      creationType: "cast", title: "Roommates",
      cast: [member("Maya"), { role: "Unnamed", description: "Somebody" }, { name: "   " }],
    }), {});
    expect(draft.cast.map((entry) => entry.name)).toEqual(["Maya"]);
  });
});

describe("the output contract protects the cast from a truncated response", () => {
  it("asks for the cast before the long prose fields", () => {
    for (const prompt of [quickIdeaPrompt({ idea: "Three roommates." }), importOrganizePrompt({ source: "Three roommates." })]) {
      // The JSON skeleton itself, not the prose around it: the order inside
      // this block is the order the model writes its answer in.
      const start = prompt.lastIndexOf("Return ONLY valid JSON");
      // The closing brace at the start of a line, so the nested objects inside
      // the skeleton do not end the slice early.
      const contract = prompt.slice(start, prompt.indexOf("\n}", start) + 2);
      const castAt = contract.indexOf('"cast"');
      expect(castAt).toBeGreaterThan(-1);
      // The prose fields most likely to be long. If any of them is written
      // before the cast, a response that runs out of budget loses people.
      for (const later of ['"backstory"', '"scenario"', '"exampleDialogue"', '"responseDirective"']) {
        expect(castAt).toBeLessThan(contract.indexOf(later));
      }
      // The openings are protected the same way and for the same reason: they
      // used to sit at the very end of the contract, which is precisely why a
      // long import arrived with its greetings missing.
      for (const opening of ['"greeting"', '"alternateGreetings"']) {
        const at = contract.indexOf(opening);
        expect(at).toBeGreaterThan(-1);
        for (const later of ['"backstory"', '"scenario"', '"exampleDialogue"']) {
          expect(at).toBeLessThan(contract.indexOf(later));
        }
      }
      expect(prompt).toContain("IN FULL before the long prose fields below them");
    }
  });

  it("still recovers the members a truncated response did write", () => {
    // The contract's new order, cut off partway through the prose beneath it.
    const truncated = '{"creationType":"cast","title":"Roommates From Hell","name":"Roommates From Hell",'
      + '"cast":[{"name":"Maya","description":"Night-shift nurse."},{"name":"Sophie","description":"Art student."}],'
      + '"tags":["Slice of Life"],"backstory":"The lease was signed in a hurry and nobody read';
    const { draft, notices, stats } = normalizeCreationResult(truncated, { sourceMaterial: "long paste" });
    expect(draft.cast.map((entry) => entry.name)).toEqual(["Maya", "Sophie"]);
    expect(stats.repair).toBe("truncated");
    // And the creator is told, rather than being handed a short import that
    // looks complete.
    expect(notices.some((notice) => notice.message.includes("cut short"))).toBe(true);
  });

  it("says nothing about repairs when the response was well formed", () => {
    const { notices, stats } = normalizeCreationResult(JSON.stringify({
      creationType: "cast", title: "Roommates", cast: [member("Maya")],
    }), {});
    expect(stats.repair).toBe("none");
    expect(notices.some((notice) => notice.message.includes("cut short"))).toBe(false);
  });
});

describe("adding a cast member by hand", () => {
  it("saves a creation that has an untouched placeholder in its cast", async () => {
    // Press "Add character", then Save. This used to be a 400 that named an
    // array index and blocked the entire creation.
    const draft = draftFromCharacter(null);
    draft.creationType = "cast";
    draft.profileType = "ensemble";
    draft.title = "Roommates";
    draft.name = "Roommates";
    draft.cast = [{ ...blankCastMember, ...member("Maya") }, { ...blankCastMember }];

    const response = await characters.POST(new Request("http://test/api/characters", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draftPayload(draft), lorebook: "" }),
    }));
    const body = await response.json();
    expect(response.status).toBe(201);
    // The placeholder is not persisted as an unnamed character; it simply was
    // never a character.
    expect(body.character.cast.map((entry: { name: string }) => entry.name)).toEqual(["Maya"]);
  });

  it("never silently discards a member somebody wrote into", () => {
    const written = { ...blankCastMember, role: "The quiet one", description: "Watches everything." };
    const parsed = characterSchema.safeParse({ name: "Roommates", title: "Roommates", creationType: "cast", cast: [written] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // Named, so the creator knows which card to open.
      expect(characterValidationMessage(parsed.error)).toBe("Cast member 1 needs a name.");
    }
  });

  it("stops the creator at the publish gate rather than at the server", () => {
    const draft = draftFromCharacter(null);
    draft.creationType = "cast";
    draft.title = "Roommates";
    draft.cast = [{ ...blankCastMember, ...member("Maya") }, { ...blankCastMember, description: "Watches everything." }];
    const problems = draftProblems(draft);
    expect(problems).toContainEqual({ step: "definition", message: "Cast member 2 needs a name." });

    // An untouched placeholder is not a problem, because it is not content.
    draft.cast = [{ ...blankCastMember, ...member("Maya") }, { ...blankCastMember }];
    expect(draftProblems(draft)).toEqual([]);
  });
});
