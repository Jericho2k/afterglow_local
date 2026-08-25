import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a list actually downloads.
 *
 * Two rules, and both are about size as well as privacy:
 *
 *   A WORLD LIST OR CARD NEVER CARRIES LORE. A page of world cards must not be
 *   a page of canon documents, and a creation page attached to a
 *   hundred-thousand-character world must not ship that document to draw a
 *   cover and a name.
 *
 *   A CREATION LIST OR CARD NEVER CARRIES THE HIDDEN DEFINITION. Greetings,
 *   personality, backstory, response directives, boundaries, example dialogue,
 *   cast definitions and the import source are the creator's working material.
 *
 * Both used to be violated by routes that reached for `SELECT *`. These assert
 * the payloads rather than the SQL, so the guarantee survives a rewrite of the
 * query underneath it.
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
const worlds = await import("@/app/api/worlds/route");
const characters = await import("@/app/api/characters/route");
const characterDetail = await import("@/app/api/characters/[id]/route");
const discovery = await import("@/app/api/discovery/route");
const saves = await import("@/app/api/saves/route");
const profile = await import("@/app/api/profile/route");

const creation = "aaaaaaaa-0000-4000-8000-000000000001";
const world = "bbbbbbbb-0000-4000-8000-000000000001";

/** A canon document long enough that shipping it by accident is measurable. */
const lore = "Nothing in the ninth district answers to a map. ".repeat(1600);

/** Every field that is the creator's working material rather than the card. */
const secrets = {
  greeting: "SECRET_GREETING",
  personality: "SECRET_PERSONALITY",
  backstory: "SECRET_BACKSTORY",
  response_directive: "SECRET_DIRECTIVE",
  boundaries: "SECRET_BOUNDARIES",
  example_dialogue: "SECRET_DIALOGUE",
  source_material: "SECRET_SOURCE_PASTE",
};

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

  await query("INSERT INTO profiles (id,username,display_name) VALUES ($1,'alice','Alice') ON CONFLICT DO NOTHING", [alice]);
  await query(
    `INSERT INTO characters (id,user_id,name,title,creation_type,profile_type,tagline,visibility,published_at,
       greeting,personality,backstory,response_directive,boundaries,example_dialogue,source_material,cast_members)
     VALUES ($1,$2,'Seraphine','Seraphine','character','single','A tagline','public',now(),$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [creation, alice, secrets.greeting, secrets.personality, secrets.backstory, secrets.response_directive,
      secrets.boundaries, secrets.example_dialogue, secrets.source_material,
      JSON.stringify([{ name: "Maya", role: "Nurse", tagline: "Pays the bills.", description: "SECRET_CAST_DEFINITION" }])],
  );
  await query("INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,'Babel','A city that climbed too far',$3,'public')", [world, alice, lore]);
  await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [creation, world]);
});

async function json(response: Response) {
  return { status: response.status, text: JSON.stringify(await response.clone().json()), body: await response.json() };
}

describe("a world list never carries lore", () => {
  it("leaves it out of every scope of the hub", async () => {
    for (const scope of ["mine", "discover", "saved"]) {
      const payload = await json(await worlds.GET(new Request(`http://test/api/worlds?scope=${scope}`)));
      expect(payload.status).toBe(200);
      expect(payload.text).not.toContain("ninth district");
      for (const summary of payload.body.worlds) {
        expect(summary.content).toBeUndefined();
        expect(summary.contentRich).toBeUndefined();
        // The card's own fields are all still there.
        if (summary.id === world) expect(summary.description).toBe("A city that climbed too far");
      }
    }
  });

  it("leaves it out of a creation's attached world cards", async () => {
    const payload = await json(await characterDetail.GET(
      new Request(`http://test/api/characters/${creation}`), { params: Promise.resolve({ id: creation }) },
    ));
    expect(payload.status).toBe(200);
    expect(payload.body.worlds).toHaveLength(1);
    expect(payload.body.worlds[0].name).toBe("Babel");
    expect(payload.body.worlds[0].content).toBeUndefined();
    // The measurable half: a page that draws one card is not a page that
    // downloads seventy-five thousand characters of canon to draw it.
    expect(payload.text).not.toContain("ninth district");
    expect(payload.text.length).toBeLessThan(lore.length / 2);
  });
});

describe("a creation list never carries the hidden definition", () => {
  it("keeps discovery lean", async () => {
    account = { id: bob, email: null };
    const payload = await json(await discovery.GET(new Request("http://test/api/discovery")));
    for (const secret of Object.values(secrets)) expect(payload.text).not.toContain(secret);
    expect(payload.text).not.toContain("SECRET_CAST_DEFINITION");
  });

  it("keeps the owner's management grid lean", async () => {
    const payload = await json(await characters.GET(new Request("http://test/api/characters?scope=manage")));
    for (const secret of Object.values(secrets)) expect(payload.text).not.toContain(secret);
    expect(payload.body.creations[0].title).toBe("Seraphine");
  });

  it("keeps the saved library lean", async () => {
    account = { id: bob, email: null };
    await query("INSERT INTO character_likes (user_id,character_id) VALUES ($1,$2)", [bob, creation]);
    const payload = await json(await saves.GET());
    for (const secret of Object.values(secrets)) expect(payload.text).not.toContain(secret);
  });

  it("keeps a creator's public profile lean", async () => {
    account = { id: bob, email: null };
    const payload = await json(await profile.GET(new Request("http://test/api/profile?username=alice")));
    expect(payload.status).toBe(200);
    expect(payload.body.creations).toHaveLength(1);
    expect(payload.body.creations[0].title).toBe("Seraphine");
    // This route used to be `SELECT c.*` with no visitor scrub, so asking for
    // somebody's public profile returned their prompt engineering in full.
    for (const secret of Object.values(secrets)) expect(payload.text).not.toContain(secret);
    expect(payload.text).not.toContain("SECRET_CAST_DEFINITION");
  });

  it("omits the import source from the shell's own library", async () => {
    // The shell needs the definition — it chats with these records — but it has
    // never rendered the original paste, which is the largest field a creation
    // has. The studio fetches the complete record for the one being edited.
    const payload = await json(await characters.GET(new Request("http://test/api/characters")));
    expect(payload.body.characters[0].greeting).toBe(secrets.greeting);
    expect(payload.body.characters[0].sourceMaterial).toBe("");
    expect(payload.text).not.toContain("SECRET_SOURCE_PASTE");

    // And it is still there when the record itself is opened.
    const full = await json(await characterDetail.GET(
      new Request(`http://test/api/characters/${creation}`), { params: Promise.resolve({ id: creation }) },
    ));
    expect(full.body.character.sourceMaterial).toBe(secrets.source_material);
  });
});

describe("a page of cards costs one statement, not one per card", () => {
  it("counts creations per world in a single grouped query", async () => {
    const second = "bbbbbbbb-0000-4000-8000-000000000002";
    await query("INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,'Second','Another setting','Short',$3)", [second, alice, "public"]);
    const statements: string[] = [];
    const { pool } = await import("@/lib/db");
    const client = pool();
    const original = client.query.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).query = (text: any, ...rest: any[]) => { statements.push(typeof text === "string" ? text : String(text?.text)); return original(text, ...rest); };
    try {
      await worlds.GET(new Request("http://test/api/worlds?scope=mine"));
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = original;
    }
    const counting = statements.filter((text) => text.includes("FROM character_worlds"));
    // Two worlds on the page, one counting statement. An N+1 regression makes
    // this number follow the number of cards.
    expect(counting).toHaveLength(1);
  });
});
