import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftFromCharacter, draftPayload, type CreationDraft } from "@/components/studio/draft";
import type { Character } from "@/lib/types";
import { emptyCastFunctionForPgMem, publicFunctionSql, publicSqlDatabase, publicViewFunctions } from "./helpers/public-functions";

/**
 * A public creation's artwork reaching the picture a stranger sees.
 *
 * The previous release verified every step of this chain except the last one,
 * and the last one was where it broke: the card model carried the cover, the
 * renderer declined to draw its format, and the output was a perfectly good
 * card with nothing on it. So this drives the REAL route — the same SQL, the
 * same view model, the same card model, the same `ImageResponse` — and asserts
 * on what came back rather than on what was intended.
 *
 * The one thing stubbed is the storage origin, because these tests must not
 * make a network request. It answers with real bytes in real formats, which is
 * the property under test: what the renderer is handed decides the outcome.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const cover = `users/${alice}/avatars/cover.png`;
const webpCover = `users/${alice}/avatars/cover.webp`;
const gifCover = `users/${alice}/avatars/cover.gif`;
const nominated = `users/${alice}/avatars/share.jpeg`;
const face = `users/${alice}/avatars/me.png`;
const storage = "https://storage.test";

let account: { id: string; email: string | null } | null = null;

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (value: string) => JSON.parse(value),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = storage;

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const characters = await import("@/app/api/characters/route");
const characterDetail = await import("@/app/api/characters/[id]/route");
const ogCard = await import("@/app/api/og/card/route");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const gif = Buffer.from("R0lGODlhAQABAIABAP8AAAAAACH5BAEAAAEALAAAAAABAAEAAAICTAEAOw==", "base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
const webp = Buffer.from("UklGRjoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAABBxAREYiI/gcAAABWUDggGAAAADABAJ0BKgEAAQADADQlpAADcAD++5QAAA==", "base64");

/** The storage bucket, answering with whatever the object's suffix says it is. */
const storedBytes = (url: string) => (
  url.endsWith(".webp") ? { bytes: webp, type: "image/webp" }
    : url.endsWith(".gif") ? { bytes: gif, type: "image/gif" }
      : url.endsWith(".jpeg") || url.endsWith(".jpg") ? { bytes: jpeg, type: "image/jpeg" }
        : { bytes: png, type: "image/png" }
);

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(storage)) throw new Error(`unexpected request to ${url}`);
    const { bytes, type } = storedBytes(url);
    return new Response(bytes, { status: 200, headers: { "Content-Type": type, "Content-Length": String(bytes.byteLength) } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function openEditor(id: string): Promise<CreationDraft> {
  const response = await characterDetail.GET(new Request(`http://test/api/characters/${id}?scope=edit`), params(id));
  const { character } = await response.json() as { character: Character };
  return draftFromCharacter(character);
}

async function save(id: string, draft: CreationDraft) {
  const response = await characterDetail.PATCH(
    new Request(`http://test/api/characters/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draftPayload(draft)),
    }),
    params(id),
  );
  expect(response.status).toBe(200);
}

/** The route a crawler actually calls, and what it answered. */
async function renderCard(id: string) {
  const response = await ogCard.GET(new Request(`http://test/api/og/card?id=${id}`));
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    artwork: response.headers.get("X-Og-Artwork") ?? "",
    format: response.headers.get("X-Og-Artwork-Format") ?? "",
    avatar: response.headers.get("X-Og-Avatar") ?? "",
    png: [...bytes.slice(0, 4)].join(",") === "137,80,78,71",
    bytes: bytes.byteLength,
  };
}

let creationId = "";

beforeEach(async () => {
  const memoryDb = publicSqlDatabase();
  setPoolForTesting(new (memoryDb.adapters.createPg().Pool)() as unknown as Pool);
  await ensureSchema();
  for (const fn of publicViewFunctions) await query(publicFunctionSql(fn.migration, fn.name), []);
  await query(emptyCastFunctionForPgMem, []);
  account = { id: alice, email: "alice@example.com" };
  await query(
    "INSERT INTO profiles (id,username,display_name,avatar_path) VALUES ($1,'alice','Alice',$2) ON CONFLICT (id) DO NOTHING",
    [alice, face],
  );
  const created = await (await characters.POST(new Request("http://test/api/characters", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Seraphine", title: "Seraphine of the Long Quay", creationType: "character",
      visibility: "public", avatarPath: cover,
    }),
  }))).json() as { character: Character };
  creationId = created.character.id;
});

describe("a storage-backed cover reaches the rendered card", () => {
  it("draws it, and says so", async () => {
    const card = await renderCard(creationId);
    expect(card.artwork).toBe("ready");
    expect(card.format).toBe("image/png");
    expect(card.png).toBe(true);
  }, 30_000);

  it("draws a custom share image in preference to the cover", async () => {
    await save(creationId, { ...await openEditor(creationId), shareImagePath: nominated });
    const card = await renderCard(creationId);
    expect(card.artwork).toBe("ready");
    // The JPEG the creator nominated, not the PNG cover behind it.
    expect(card.format).toBe("image/jpeg");
  }, 30_000);

  it("draws the creator's picture alongside it", async () => {
    expect((await renderCard(creationId)).avatar).toBe("ready");
  }, 30_000);
});

describe("a format the renderer cannot draw is never silent", () => {
  it("names the format instead of producing an artless card with no reason", async () => {
    /*
     * The reported bug, end to end. Everything above this layer is correct —
     * the row has a cover, the SQL ships it, the model resolves it — and the
     * card still comes back without a picture. What changed is that it now
     * SAYS so, in a header a crawl can be inspected with.
     */
    await save(creationId, { ...await openEditor(creationId), avatarPath: webpCover });
    const card = await renderCard(creationId);
    expect(card.artwork).toBe("unsupported_format");
    expect(card.format).toBe("image/webp");
    // Still a card, and still a valid PNG: the degradation is deliberate.
    expect(card.png).toBe(true);
  }, 30_000);

  it("names a GIF the same way, since uploads accept those too", async () => {
    await save(creationId, { ...await openEditor(creationId), avatarPath: gifCover });
    const card = await renderCard(creationId);
    expect(card.artwork).toBe("unsupported_format");
    expect(card.format).toBe("image/gif");
  }, 30_000);

  it("reports an image the storage bucket no longer has", async () => {
    globalThis.fetch = (async () => new Response("gone", { status: 404 })) as typeof fetch;
    const card = await renderCard(creationId);
    expect(card.artwork).toBe("unreachable");
    expect(card.png).toBe(true);
  }, 30_000);
});

describe("gating is exactly what it was", () => {
  it("draws nothing for an adult-focused creation, and reports it as absent", async () => {
    await save(creationId, { ...await openEditor(creationId), contentMode: "adult_focused" });
    const card = await renderCard(creationId);
    // `absent` rather than a format outcome: the model never offered artwork,
    // so nothing was fetched. The refusal happens in SQL and in the media rule,
    // both of which are untouched by anything in this change.
    expect(card.artwork).toBe("absent");
    expect(card.png).toBe(true);
    // The creator's picture is not gated content and still appears.
    expect(card.avatar).toBe("ready");
  }, 30_000);

  it("still refuses an unclassified gated cover even though open covers now draw", async () => {
    await save(creationId, { ...await openEditor(creationId), contentMode: "adult_focused", shareImagePath: nominated });
    expect((await renderCard(creationId)).artwork).toBe("absent");
    // …and releases it once a moderator has classified that exact image.
    await query("UPDATE characters SET share_media_status='safe' WHERE id=$1", [creationId]);
    expect((await renderCard(creationId)).artwork).toBe("ready");
  }, 30_000);
});
