import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Public character page data contract.
 *
 * The page derives its sections from what the creator actually supplied, so
 * these assert the shape the UI branches on: absent data must come back empty
 * (the section and its nav entry disappear) rather than as a placeholder, and
 * public metrics must describe the character globally rather than the viewer.
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
const characterDetail = await import("@/app/api/characters/[id]/route");
const comments = await import("@/app/api/comments/route");
const gallery = await import("@/app/api/characters/[id]/gallery/route");
const worldDetail = await import("@/app/api/worlds/[id]/route");

const bare = "aaaaaaaa-0000-4000-8000-000000000001";
const rich = "aaaaaaaa-0000-4000-8000-000000000002";
const world = "bbbbbbbb-0000-4000-8000-000000000001";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
function post(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

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
  account = null;

  // A character with nothing optional filled in, and one with everything.
  await query("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Bare',$2,'public')", [bare, alice]);
  await query(
    `INSERT INTO characters (id,name,tagline,user_id,visibility,tags,quick_facts,backstory,message_count,chat_count,like_count)
     VALUES ($1,'Seraphine','The girl who writes your name',$2,'public',$3::text[],$4::jsonb,'Sharp-tongued and guarded.',18,7,3)`,
    [rich, alice, ["Poetry", "Dark Romance"], JSON.stringify([{ label: "Age", value: "24" }, { label: "Location", value: "Berlin" }])],
  );
  await query("INSERT INTO worlds (id,name,content,user_id,visibility,cover_path) VALUES ($1,'Nocturne City','Neon and rain',$2,'public','users/x/covers/a.png')", [world, alice]);
  await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [rich, world]);
  await query(
    "INSERT INTO character_gallery (id,character_id,user_id,storage_path,position) VALUES ($1,$2,$3,'users/x/g/1.png',0)",
    [crypto.randomUUID(), rich, alice],
  );
});

describe("public character detail", () => {
  it("omits every optional section for a character with none of them", async () => {
    account = { id: bob, email: null };
    const body = await (await characterDetail.GET(new Request("http://test"), params(bare))).json();
    expect(body.character.tags).toEqual([]);
    expect(body.character.quickFacts).toEqual([]);
    expect(body.character.gallery).toEqual([]);
    expect(body.worlds).toEqual([]);
  });

  it("returns canonical tags, quick facts, gallery and world for an enriched character", async () => {
    account = { id: bob, email: null };
    const body = await (await characterDetail.GET(new Request("http://test"), params(rich))).json();
    expect(body.character.tags).toEqual(["Poetry", "Dark Romance"]);
    expect(body.character.quickFacts).toEqual([{ label: "Age", value: "24" }, { label: "Location", value: "Berlin" }]);
    expect(body.character.gallery).toHaveLength(1);
    expect(body.worlds[0].name).toBe("Nocturne City");
    expect(body.worlds[0].coverPath).toBe("users/x/covers/a.png");
  });

  it("reports character-wide public metrics rather than the viewer's own activity", async () => {
    account = { id: bob, email: null };
    const body = await (await characterDetail.GET(new Request("http://test"), params(rich))).json();
    expect(body.character.publicStats.messages).toBe(18);
    expect(body.character.publicStats.chats).toBe(7);
    // Saves are the product's affinity metric; the storage column is still like_count.
    expect(body.character.publicStats.saves).toBe(3);
    // Ranking has no backend answer yet, so it stays null and renders as unavailable.
    expect(body.character.publicStats.rank).toBeNull();
  });

  it("marks a visitor as a non-owner and the creator as owner", async () => {
    account = { id: bob, email: null };
    expect((await (await characterDetail.GET(new Request("http://test"), params(rich))).json()).owner).toBe(false);
    account = { id: alice, email: null };
    expect((await (await characterDetail.GET(new Request("http://test"), params(rich))).json()).owner).toBe(true);
  });

  it("keeps a private character unreachable by another account", async () => {
    await query("UPDATE characters SET visibility='private' WHERE id=$1", [rich]);
    account = { id: bob, email: null };
    expect((await characterDetail.GET(new Request("http://test"), params(rich))).status).toBe(404);
  });

  it("does not leak the creator's import source material to a visitor", async () => {
    await query("UPDATE characters SET source_material='private production notes' WHERE id=$1", [rich]);
    account = { id: bob, email: null };
    const body = await (await characterDetail.GET(new Request("http://test"), params(rich))).json();
    expect(body.character.sourceMaterial).toBe("");
  });
});

describe("gallery ownership", () => {
  it("refuses to let a visitor replace another account's gallery", async () => {
    account = { id: bob, email: null };
    const response = await gallery.PUT(post("http://test", { images: [{ storagePath: `users/${bob}/avatars/x.png` }] }), params(rich));
    expect(response.status).toBe(404);
    const rows = await query("SELECT COUNT(*)::int count FROM character_gallery WHERE character_id=$1", [rich]);
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it("lets the owner replace their own gallery", async () => {
    account = { id: alice, email: null };
    const response = await gallery.PUT(post("http://test", { images: [
      { storagePath: `users/${alice}/avatars/one.png` },
      { storagePath: `users/${alice}/avatars/two.png` },
    ] }), params(rich));
    expect(response.status).toBe(200);
    expect((await response.json()).images).toHaveLength(2);
  });
});

describe("comments", () => {
  it("requires a readable character", async () => {
    await query("UPDATE characters SET visibility='private' WHERE id=$1", [rich]);
    account = { id: bob, email: null };
    expect((await comments.POST(post("http://test", { characterId: rich, body: "hello" }))).status).toBe(404);
  });

  it("accepts a comment on a published character and returns it", async () => {
    account = { id: bob, email: null };
    const created = await comments.POST(post("http://test", { characterId: rich, body: "Incredible depth." }));
    expect(created.status).toBe(201);
    const listed = await (await comments.GET(new Request(`http://test/api/comments?characterId=${rich}`))).json();
    expect(listed.comments[0].body).toBe("Incredible depth.");
    expect(listed.comments[0].authoredByViewer).toBe(true);
  });

  it("returns an empty list rather than fabricated content", async () => {
    account = { id: bob, email: null };
    const listed = await (await comments.GET(new Request(`http://test/api/comments?characterId=${bare}`))).json();
    expect(listed.comments).toEqual([]);
  });
});

describe("world pages", () => {
  it("serves a published world to a visitor with the characters that use it", async () => {
    account = { id: bob, email: null };
    const body = await (await worldDetail.GET(new Request("http://test"), params(world))).json();
    expect(body.world.name).toBe("Nocturne City");
    expect(body.owner).toBe(false);
    expect(body.creations.map((entry: { id: string }) => entry.id)).toContain(rich);
  });

  it("keeps a private world unreachable by another account", async () => {
    await query("UPDATE worlds SET visibility='private' WHERE id=$1", [world]);
    account = { id: bob, email: null };
    expect((await worldDetail.GET(new Request("http://test"), params(world))).status).toBe(404);
  });

  it("refuses a world cover write from a non-owner", async () => {
    account = { id: bob, email: null };
    const response = await worldDetail.PATCH(
      new Request("http://test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Hijacked", content: "x", coverPath: `users/${bob}/covers/x.png` }) }),
      params(world),
    );
    expect(response.status).toBe(404);
    const row = await query("SELECT name FROM worlds WHERE id=$1", [world]);
    expect(row.rows[0].name).toBe("Nocturne City");
  });
});
