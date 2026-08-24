import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rich content, end to end.
 *
 * The unit tests prove the serializer drops images. These prove the promise
 * that matters in production: an illustrated creation stores its words in the
 * column every prompt reads, so the model receives text no matter which code
 * path reaches it — and the pictures survive alongside, for people.
 */

const alice = "11111111-1111-4111-8111-111111111111";
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
const { roleplayPrompt } = await import("@/lib/prompts");
const { characterFromRow } = await import("@/lib/db");

const image = (path: string, caption = "") => ({ type: "image", path, url: "", caption });
const text = (value: string) => ({ type: "text", text: value });

const illustrated = {
  name: "Vesper Lang",
  title: "Vesper Lang",
  creationType: "character",
  visibility: "private",
  description: "ignored in favour of the blocks",
  descriptionRich: [
    text("She owns the tattoo shop on Meridian Street."),
    image("users/11111111-1111-4111-8111-111111111111/avatars/shop.png", "The shop at closing time"),
    text("She has never once been on time for anything else."),
  ],
  greeting: "ignored in favour of the blocks",
  greetingRich: [
    text("*The needle stops. She doesn't look up.*"),
    image("users/11111111-1111-4111-8111-111111111111/avatars/needle.png", "Mid-session"),
    text("\"You booked three hours for forty minutes of work again.\""),
  ],
  alternateGreetings: ["The shop is closed."],
  alternateGreetingsRich: [[text("The shop is closed."), image("users/11111111-1111-4111-8111-111111111111/avatars/closed.png")]],
};

function post(body: unknown) {
  return new Request("http://test/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

describe("what the database ends up holding", () => {
  it("writes the words to the text column and the pictures beside them", async () => {
    const created = await (await characters.POST(post(illustrated))).json();
    const row = (await query("SELECT description,description_rich,greeting,greeting_rich FROM characters WHERE id=$1", [created.character.id])).rows[0];

    // The text column is the serialised words, and nothing else.
    expect(row.description).toBe("She owns the tattoo shop on Meridian Street.\n\nShe has never once been on time for anything else.");
    expect(row.description).not.toContain("shop.png");
    expect(row.greeting).toContain("You booked three hours");
    expect(row.greeting).not.toContain("needle.png");

    // And the blocks are there for the page to render.
    expect(row.description_rich).toHaveLength(3);
    expect(row.greeting_rich).toHaveLength(3);
  });

  it("keeps an opening and its pictures index-aligned", async () => {
    const created = await (await characters.POST(post(illustrated))).json();
    const row = (await query("SELECT alternate_greetings,alternate_greetings_rich FROM characters WHERE id=$1", [created.character.id])).rows[0];
    expect(row.alternate_greetings).toEqual(["The shop is closed."]);
    expect(row.alternate_greetings_rich[0]).toHaveLength(2);
  });

  it("stores plain content exactly as it always did, with no blocks", async () => {
    const created = await (await characters.POST(post({
      name: "Seraphine", title: "Seraphine", visibility: "private",
      description: "A poet who keeps her drafts hidden.",
      greeting: "You find her notebook.",
    }))).json();
    const row = (await query("SELECT description,description_rich,greeting_rich FROM characters WHERE id=$1", [created.character.id])).rows[0];
    expect(row.description).toBe("A poet who keeps her drafts hidden.");
    // Not marked rich: a creation nobody put a picture in is the same row it
    // has always been.
    expect(row.description_rich).toEqual([]);
    expect(row.greeting_rich).toEqual([]);
  });

  it("drops the blocks again when the last image is removed", async () => {
    const created = await (await characters.POST(post(illustrated))).json();
    await characterDetail.PATCH(
      new Request(`http://test/api/characters/${created.character.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...illustrated, descriptionRich: [text("Just words now.")], greetingRich: [], greeting: "Plain." }),
      }),
      { params: Promise.resolve({ id: created.character.id }) },
    );
    const row = (await query("SELECT description,description_rich FROM characters WHERE id=$1", [created.character.id])).rows[0];
    expect(row.description).toBe("Just words now.");
    expect(row.description_rich).toEqual([]);
  });
});

describe("what the model receives", () => {
  it("builds a prompt with no trace of any image", async () => {
    const created = await (await characters.POST(post(illustrated))).json();
    const row = (await query("SELECT * FROM characters WHERE id=$1", [created.character.id])).rows[0];
    const character = characterFromRow({ ...row, world_ids: [] }, alice);
    const prompt = roleplayPrompt(character, "", [], []);

    for (const leak of ["shop.png", "needle.png", "closed.png", "users/1111", "The shop at closing time", "Mid-session"]) {
      expect(prompt.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("still carries every word the creator wrote", async () => {
    const created = await (await characters.POST(post(illustrated))).json();
    const row = (await query("SELECT * FROM characters WHERE id=$1", [created.character.id])).rows[0];
    const character = characterFromRow({ ...row, world_ids: [] }, alice);
    // The definition the prompt is built from is unchanged by illustration:
    // the same sentences reach the model either way.
    expect(character.description).toContain("Meridian Street");
    expect(character.greeting).toContain("You booked three hours");
  });

  it("does not require a different model for an illustrated creation", async () => {
    // Stated as a property of the data rather than of the caller: the columns
    // a prompt reads are text columns, so there is nothing for a vision model
    // to be needed for.
    const created = await (await characters.POST(post(illustrated))).json();
    const row = (await query("SELECT description,greeting,alternate_greetings FROM characters WHERE id=$1", [created.character.id])).rows[0];
    for (const value of [row.description, row.greeting, ...(row.alternate_greetings as string[])]) {
      expect(typeof value).toBe("string");
      expect(value).not.toMatch(/\.png|\.jpe?g|\.webp|users\//i);
    }
  });
});

describe("what a reader receives", () => {
  it("sends the blocks back so the page can render the pictures", async () => {
    const created = await (await characters.POST(post(illustrated))).json();
    const detail = await (await characterDetail.GET(
      new Request(`http://test/api/characters/${created.character.id}`),
      { params: Promise.resolve({ id: created.character.id }) },
    )).json();
    expect(detail.character.descriptionRich).toHaveLength(3);
    expect(detail.character.descriptionRich[1]).toMatchObject({ type: "image", path: "users/11111111-1111-4111-8111-111111111111/avatars/shop.png" });
    expect(detail.character.greetingRich[1]).toMatchObject({ type: "image" });
  });

  it("refuses an image source that is not an image location", async () => {
    const created = await (await characters.POST(post({
      name: "Vesper", title: "Vesper", visibility: "private",
      descriptionRich: [
        text("Before."),
        { type: "image", url: "javascript:alert(1)", path: "", caption: "" },
        { type: "image", path: "../../etc/passwd", url: "", caption: "" },
        text("After."),
      ],
    }))).json();
    const row = (await query("SELECT description,description_rich FROM characters WHERE id=$1", [created.character.id])).rows[0];
    // Both bad blocks are gone, and the text either side survives.
    expect(row.description_rich).toEqual([]);
    expect(row.description).toBe("Before.\n\nAfter.");
  });

  it("does not fail the whole save because one block was malformed", async () => {
    const response = await characters.POST(post({
      name: "Vesper", title: "Vesper", visibility: "private",
      descriptionRich: [text("Kept."), { type: "image" }],
    }));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.character.description).toBe("Kept.");
  });
});
