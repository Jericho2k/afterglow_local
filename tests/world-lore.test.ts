import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxLoreBlockText, normalizeBlocks, richFieldPayload, richToText } from "@/lib/rich-content";
import { worldSchema } from "@/lib/schemas";

/**
 * World lore, at the size the editor advertises.
 *
 * The Lore & canon field said 100,000 characters and stored roughly 30,000.
 * Nothing warned anybody: the block schema silently dropped an over-long
 * paragraph, the plain column then went through `normalizeBlocks`, and
 * `normalizeBlocks` sliced it to the creation-field ceiling on the way past.
 * A creator pasting a long canon document lost two thirds of it and was told
 * their world had been saved.
 *
 * These assert the whole chain at the advertised size, and they assert the
 * other half of the promise too: lore is CONTENT. JSON-shaped lore is not
 * parsed, JavaScript-shaped lore is not executed, and malformed either kind is
 * text that happens to have brackets in it.
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
const worlds = await import("@/app/api/worlds/route");
const worldDetail = await import("@/app/api/worlds/[id]/route");

/**
 * Exactly `size` characters of ordinary prose.
 *
 * The last character is deliberately not whitespace: every layer here trims,
 * correctly, and a fixture that ends in a space would fail by one character
 * for a reason that has nothing to do with what is being tested.
 */
function longLore(size = maxLoreBlockText) {
  const paragraph = "The tower keeps its own weather, and the weather keeps its own counsel. ";
  let text = "";
  while (text.length < size) text += paragraph;
  return `${text.slice(0, size - 1)}.`;
}

const jsonLore = JSON.stringify({
  factions: [{ name: "The Cartographers", rules: ["never map the ninth floor"] }],
  notes: "quotes \"inside\" the string, and a \\backslash",
}, null, 2);

const brokenJsonLore = '{ "factions": [ { "name": "The Cartographers", "rules": [ "never map the ninth floor" ]';

const scriptLore = `const summon = (name) => { eval("alert('" + name + "')"); };\n<script>window.__afterglow = "owned";</script>\n{{char}} refuses.`;

function post(body: unknown) {
  return new Request("http://test/api/worlds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function createWorld(body: Record<string, unknown>) {
  const response = await worlds.POST(post({ name: "Babel", description: "", visibility: "private", contentRich: [], coverPath: "", coverUrl: "", ...body }));
  return { status: response.status, body: await response.json() };
}

async function readWorld(id: string) {
  const response = await worldDetail.GET(new Request(`http://test/api/worlds/${id}`), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
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
  setPoolForTesting(new (memoryDb.adapters.createPg()).Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: alice, email: null };
});

describe("the advertised limit is the real limit", () => {
  it("agrees with the schema", () => {
    // The counter under the field, the textarea's maxLength and the server's
    // ceiling are one constant. They used to be three numbers.
    expect(maxLoreBlockText).toBe(100_000);
    expect(worldSchema.safeParse({ name: "Babel", content: longLore(), contentRich: [] }).success).toBe(true);
  });

  it("keeps 100,000 characters of plain lore through create and reopen", async () => {
    const lore = longLore();
    const created = await createWorld({ content: lore });
    expect(created.status).toBe(201);
    expect(created.body.world.content).toHaveLength(maxLoreBlockText);
    expect(created.body.world.content).toBe(lore);

    const reopened = await readWorld(created.body.world.id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.world.content).toBe(lore);
  });

  it("keeps 100,000 characters of illustrated lore, blocks included", async () => {
    const lore = longLore();
    // Exactly what the editor sends: both halves together, decided once.
    const created = await createWorld({
      content: lore,
      contentRich: [
        { type: "text", text: lore },
        { type: "image", path: "", url: "https://cdn.example/map.png", caption: "The ninth floor" },
      ],
    });
    expect(created.status).toBe(201);
    const stored = created.body.world;
    // The blocks survive because the field carries an image, and the canonical
    // text column beside them says exactly what the blocks say.
    expect(stored.contentRich).toHaveLength(2);
    expect(stored.contentRich[0].text).toHaveLength(maxLoreBlockText);
    expect(stored.content).toBe(lore);
    // The image contributes nothing to what a prompt would read.
    expect(stored.content).not.toContain("cdn.example");
  });

  it("truncates nothing silently at 30,000", async () => {
    const lore = longLore(60_000);
    const created = await createWorld({ content: lore });
    expect(created.body.world.content).toHaveLength(60_000);
    // The old ceiling, named so a regression is unmistakable rather than "some
    // characters went missing".
    expect(created.body.world.content.length).toBeGreaterThan(30_000);
  });

  it("edits a long world without shortening it", async () => {
    const created = await createWorld({ content: longLore(40_000) });
    const grown = longLore(90_000);
    const response = await worldDetail.PATCH(
      new Request(`http://test/api/worlds/${created.body.world.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Babel", description: "", visibility: "private", content: grown, contentRich: [], coverPath: "", coverUrl: "" }),
      }),
      { params: Promise.resolve({ id: created.body.world.id }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).world.content).toBe(grown);
  });
});

describe("lore is content, never a program and never a document to parse", () => {
  it("stores JSON-looking lore verbatim without parsing it", async () => {
    const created = await createWorld({ content: jsonLore });
    expect(created.status).toBe(201);
    // Byte for byte, including the escaping. Nothing tried to read it as JSON,
    // so nothing could disagree with the creator about what it says.
    expect(created.body.world.content).toBe(jsonLore);
    expect((await readWorld(created.body.world.id)).body.world.content).toBe(jsonLore);
  });

  it("accepts malformed JSON-looking lore as the text it is", async () => {
    const created = await createWorld({ content: brokenJsonLore });
    expect(created.status).toBe(201);
    expect(created.body.world.content).toBe(brokenJsonLore);
    // The read path is the one that used to be able to throw. A world whose
    // lore does not happen to be valid JSON must open like any other.
    const reopened = await readWorld(created.body.world.id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.world.content).toBe(brokenJsonLore);
  });

  it("keeps JavaScript-looking lore inert", async () => {
    const created = await createWorld({ content: scriptLore });
    expect(created.status).toBe(201);
    const stored = created.body.world;
    // Preserved exactly — it is somebody's writing — and stored as a string on
    // a text column. There is no evaluation step anywhere on this path.
    expect(stored.content).toBe(scriptLore);
    expect(typeof stored.content).toBe("string");
    // And the block model has nowhere to put markup even if it wanted to: the
    // only fields a block carries are text, an image path, an http(s) URL and
    // a caption, all rendered as React children.
    expect(stored.contentRich).toEqual([]);
  });

  it("survives a hand-written blocks column that is not blocks at all", () => {
    // A jsonb column edited by hand, or written by an older client. Every one
    // of these is dropped rather than rendered or thrown on.
    for (const hostile of [
      null, "not an array", 42, [null], [[]], [{ type: "image" }],
      [{ type: "image", url: "javascript:alert(1)" }],
      [{ type: "text" }], [{ type: "text", text: "   " }],
      [{ type: "video", src: "https://cdn.example/clip.mp4" }],
    ]) {
      expect(() => normalizeBlocks(hostile, maxLoreBlockText)).not.toThrow();
    }
    expect(normalizeBlocks([{ type: "image", url: "javascript:alert(1)" }], maxLoreBlockText)).toEqual([]);
    // A block from a future version degrades to whatever text it carries.
    expect(normalizeBlocks([{ type: "video", text: "still readable" }], maxLoreBlockText))
      .toEqual([{ type: "text", text: "still readable" }]);
  });

  it("keeps a creation field at its own smaller ceiling", () => {
    // Raising the lore limit must not raise everything. A description block is
    // still a description block.
    const oversized = [{ type: "text" as const, text: longLore(50_000) }];
    expect(richToText(normalizeBlocks(oversized))).toHaveLength(30_000);
    expect(richFieldPayload(oversized, maxLoreBlockText).text).toHaveLength(50_000);
  });
});
