import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Worlds V2.
 *
 * A world is a reusable setting with its own page, its own saves and its own
 * discussion. These assert the three things that makes true and the one thing
 * it must never make true: published worlds are findable, saved worlds are
 * private to whoever saved them, a world's page lists the creations built on
 * it — and a private world's lore never leaves the server, not even when a
 * public creation is built on it.
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
const worldDetail = await import("@/app/api/worlds/[id]/route");
const worldSaves = await import("@/app/api/world-saves/route");
const comments = await import("@/app/api/comments/route");

const publicWorld = "dddddddd-0000-4000-8000-000000000001";
const privateWorld = "dddddddd-0000-4000-8000-000000000002";
const bobWorld = "dddddddd-0000-4000-8000-000000000003";
const publicCreation = "aaaaaaaa-0000-4000-8000-000000000001";
const draftCreation = "aaaaaaaa-0000-4000-8000-000000000002";

type World = {
  id: string; name: string; description: string; visibility: string;
  saveCount: number; savedByViewer: boolean; ownedByViewer: boolean; creationCount: number;
};

function json(url: string, body: unknown, method = "POST") {
  return new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function hub(scope: string) {
  const response = await worlds.GET(new Request(`http://test/api/worlds?scope=${scope}`));
  const body = await response.json() as { worlds: World[] };
  return { status: response.status, worlds: body.worlds ?? [] };
}

const ids = (list: World[]) => list.map((world) => world.id);

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
  account = { id: bob, email: null };

  await query("INSERT INTO profiles (id,username,display_name) VALUES ($1,'nova','Nova Vale')", [alice]);
  await query(
    "INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,'Ardenholt','A kingdom without a king.','The Merchant Council rules in practice.','public')",
    [publicWorld, alice],
  );
  await query(
    "INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,'Midnight Academy','Unlisted for now.','Creator-only canon about the sealed wing.','private')",
    [privateWorld, alice],
  );
  await query(
    "INSERT INTO worlds (id,user_id,name,content,visibility) VALUES ($1,$2,'Bob World','Bob canon','private')",
    [bobWorld, bob],
  );
  await query(
    `INSERT INTO characters (id,user_id,name,title,creation_type,visibility,published_at,tagline)
     VALUES ($1,$2,'The Final War','The Final War','scenario','public',now(),'The heroes are running out of options.')`,
    [publicCreation, alice],
  );
  await query(
    "INSERT INTO characters (id,user_id,name,title,visibility) VALUES ($1,$2,'Unfinished','Unfinished','private')",
    [draftCreation, alice],
  );
  await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2),($3,$2)", [publicCreation, publicWorld, draftCreation]);
});

describe("the Worlds hub", () => {
  it("requires an account", async () => {
    account = null;
    expect((await hub("discover")).status).toBe(401);
  });

  it("shows published worlds under Discover and never private ones", async () => {
    const { worlds: listed } = await hub("discover");
    expect(ids(listed)).toContain(publicWorld);
    expect(ids(listed)).not.toContain(privateWorld);
    expect(ids(listed)).not.toContain(bobWorld);
  });

  it("shows the caller their own worlds, private ones included", async () => {
    account = { id: alice, email: null };
    const { worlds: mine } = await hub("mine");
    expect(ids(mine).sort()).toEqual([publicWorld, privateWorld].sort());
    expect(mine.every((world) => world.ownedByViewer)).toBe(true);
  });

  it("never puts another account's world in Your Worlds", async () => {
    const { worlds: mine } = await hub("mine");
    expect(ids(mine)).toEqual([bobWorld]);
  });

  it("counts only creations the viewer may see", async () => {
    // A private creation using the world must not be inferable from a number.
    const card = (await hub("discover")).worlds.find((world) => world.id === publicWorld)!;
    expect(card.creationCount).toBe(1);
  });

  it("never sends lore to a listing", async () => {
    for (const scope of ["discover", "mine"]) {
      const payload = JSON.stringify((await hub(scope)).worlds);
      expect(payload).not.toContain("Merchant Council");
      expect(payload).not.toContain("Creator-only canon");
      expect(payload).not.toContain("Bob canon");
    }
  });
});

describe("saving a world", () => {
  async function save(worldId: string) {
    return worldSaves.POST(json("http://test/api/world-saves", { worldId }));
  }

  it("saves a published world and reports the new total", async () => {
    const response = await save(publicWorld);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ saved: true });
    const rows = await query("SELECT COUNT(*)::int count FROM world_saves WHERE user_id=$1 AND world_id=$2", [bob, publicWorld]);
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it("lists it under Saved, and stops listing it once unsaved", async () => {
    await save(publicWorld);
    expect(ids((await hub("saved")).worlds)).toEqual([publicWorld]);
    await worldSaves.DELETE(new Request(`http://test/api/world-saves?worldId=${publicWorld}`, { method: "DELETE" }));
    expect((await hub("saved")).worlds).toHaveLength(0);
  });

  it("refuses to save a world that is private to somebody else", async () => {
    expect((await save(privateWorld)).status).toBe(404);
    const rows = await query("SELECT COUNT(*)::int count FROM world_saves WHERE world_id=$1", [privateWorld]);
    expect(Number(rows.rows[0].count)).toBe(0);
  });

  it("refuses to save the caller's own world, which they already have", async () => {
    account = { id: alice, email: null };
    expect((await save(publicWorld)).status).toBe(404);
  });

  it("treats saving twice as success rather than as an error", async () => {
    await save(publicWorld);
    expect((await save(publicWorld)).status).toBe(200);
    const rows = await query("SELECT COUNT(*)::int count FROM world_saves WHERE user_id=$1 AND world_id=$2", [bob, publicWorld]);
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it("never exposes who saved a world", async () => {
    await save(publicWorld);
    account = { id: alice, email: null };
    const payload = JSON.stringify((await hub("mine")).worlds);
    expect(payload).not.toContain(bob);
  });
});

describe("a world's own page", () => {
  async function open(worldId: string) {
    const response = await worldDetail.GET(new Request(`http://test/api/worlds/${worldId}`), { params: Promise.resolve({ id: worldId }) });
    return { status: response.status, body: await response.json() };
  }

  it("serves a published world to a visitor, with its lore", async () => {
    const { status, body } = await open(publicWorld);
    expect(status).toBe(200);
    expect(body.world.name).toBe("Ardenholt");
    expect(body.world.content).toContain("Merchant Council");
    expect(body.owner).toBe(false);
  });

  it("refuses a private world to everybody but its owner", async () => {
    expect((await open(privateWorld)).status).toBe(404);
    account = { id: alice, email: null };
    const { status, body } = await open(privateWorld);
    expect(status).toBe(200);
    expect(body.owner).toBe(true);
    expect(body.world.content).toContain("sealed wing");
  });

  it("lists the public creations built on it", async () => {
    const { body } = await open(publicWorld);
    expect(body.creations.map((creation: { id: string }) => creation.id)).toEqual([publicCreation]);
  });

  it("never leaks a draft creation through the association list", async () => {
    const { body } = await open(publicWorld);
    const listed = body.creations.map((creation: { id: string }) => creation.id);
    expect(listed).not.toContain(draftCreation);
    expect(JSON.stringify(body.creations)).not.toContain("Unfinished");
  });

  it("shows the owner their own unpublished creation in the list", async () => {
    account = { id: alice, email: null };
    const { body } = await open(publicWorld);
    expect(body.creations.map((creation: { id: string }) => creation.id).sort()).toEqual([publicCreation, draftCreation].sort());
  });

  it("sends lean creation summaries rather than definitions", async () => {
    const { body } = await open(publicWorld);
    for (const field of ["greeting", "personality", "responseDirective", "boundaries", "sourceMaterial"]) {
      expect(body.creations[0]).not.toHaveProperty(field);
    }
  });
});

describe("editing and deleting a world", () => {
  it("refuses an edit from an account that does not own it", async () => {
    const response = await worldDetail.PATCH(
      json(`http://test/api/worlds/${publicWorld}`, { name: "Hijacked", content: "Rewritten canon" }, "PATCH"),
      { params: Promise.resolve({ id: publicWorld }) },
    );
    expect(response.status).toBe(404);
    const rows = await query("SELECT name FROM worlds WHERE id=$1", [publicWorld]);
    expect(rows.rows[0].name).toBe("Ardenholt");
  });

  it("detaches creations rather than deleting them", async () => {
    account = { id: alice, email: null };
    const response = await worldDetail.DELETE(
      new Request(`http://test/api/worlds/${publicWorld}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: publicWorld }) },
    );
    expect(response.status).toBe(200);
    // The count is what the confirmation is written from, so it is reported.
    expect(await response.json()).toMatchObject({ detachedCreations: 2 });
    // The creations still exist; they simply no longer have this world.
    const creations = await query("SELECT COUNT(*)::int count FROM characters WHERE id IN ($1,$2)", [publicCreation, draftCreation]);
    expect(Number(creations.rows[0].count)).toBe(2);
    const links = await query("SELECT COUNT(*)::int count FROM character_worlds WHERE world_id=$1", [publicWorld]);
    expect(Number(links.rows[0].count)).toBe(0);
  });

  it("refuses a delete from an account that does not own it", async () => {
    const response = await worldDetail.DELETE(
      new Request(`http://test/api/worlds/${publicWorld}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: publicWorld }) },
    );
    expect(response.status).toBe(404);
    expect(Number((await query("SELECT COUNT(*)::int count FROM worlds WHERE id=$1", [publicWorld])).rows[0].count)).toBe(1);
  });
});

describe("world comments", () => {
  it("posts and lists a comment on a published world", async () => {
    const created = await comments.POST(json("http://test/api/comments", { worldId: publicWorld, body: "Great setting." }));
    expect(created.status).toBe(201);
    const listed = await (await comments.GET(new Request(`http://test/api/comments?worldId=${publicWorld}`))).json();
    expect(listed.comments).toHaveLength(1);
    expect(listed.comments[0].body).toBe("Great setting.");
    expect(listed.comments[0].worldId).toBe(publicWorld);
  });

  it("refuses a comment on a world the caller cannot read", async () => {
    expect((await comments.POST(json("http://test/api/comments", { worldId: privateWorld, body: "Peeking" }))).status).toBe(404);
  });

  it("refuses a comment that names both a creation and a world", async () => {
    const response = await comments.POST(json("http://test/api/comments", { worldId: publicWorld, characterId: publicCreation, body: "Both" }));
    expect(response.status).toBe(400);
  });

  it("keeps creation comments and world comments in separate lists", async () => {
    await comments.POST(json("http://test/api/comments", { worldId: publicWorld, body: "About the world." }));
    await comments.POST(json("http://test/api/comments", { characterId: publicCreation, body: "About the creation." }));
    const world = await (await comments.GET(new Request(`http://test/api/comments?worldId=${publicWorld}`))).json();
    const creation = await (await comments.GET(new Request(`http://test/api/comments?characterId=${publicCreation}`))).json();
    expect(world.comments.map((comment: { body: string }) => comment.body)).toEqual(["About the world."]);
    expect(creation.comments.map((comment: { body: string }) => comment.body)).toEqual(["About the creation."]);
  });
});
