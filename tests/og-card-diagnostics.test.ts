import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Character } from "@/lib/types";
import { emptyCastFunctionForPgMem, publicFunctionSql, publicSqlDatabase, publicViewFunctions } from "./helpers/public-functions";

/**
 * Being able to answer "where did the artwork go" without guessing.
 *
 * The last round of this was spent reasoning from the outside about a card that
 * renders identically whether a creation has no artwork, has artwork the
 * renderer cannot draw, or is gated. That is not a deduction anybody can make
 * from a PNG, and the cost of trying was a release.
 *
 * So the chain is walked once and reported. These assert the two things that
 * make such an endpoint safe to have: only a moderator may call it, and it
 * hands back facts about a picture rather than the picture.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const moderator = "33333333-3333-4333-8333-333333333333";
const cover = `users/${alice}/avatars/cover.webp`;
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
const diagnostics = await import("@/app/api/admin/og-card-diagnostics/route");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const webp = Buffer.from("UklGRjoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAABBxAREYiI/gcAAABWUDggGAAAADABAJ0BKgEAAQADADQlpAADcAD++5QAAA==", "base64");

const realFetch = globalThis.fetch;
let creationId = "";

beforeEach(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const webpFile = url.endsWith(".webp");
    return new Response(webpFile ? webp : png, {
      status: 200,
      headers: { "Content-Type": webpFile ? "image/webp" : "image/png" },
    });
  }) as typeof fetch;

  const memoryDb = publicSqlDatabase();
  setPoolForTesting(new (memoryDb.adapters.createPg().Pool)() as unknown as Pool);
  await ensureSchema();
  for (const fn of publicViewFunctions) await query(publicFunctionSql(fn.migration, fn.name), []);
  await query(emptyCastFunctionForPgMem, []);
  process.env.AFTERGLOW_ADMIN_USER_IDS = moderator;
  account = { id: alice, email: "alice@example.com" };
  await query(
    "INSERT INTO profiles (id,username,display_name,avatar_path) VALUES ($1,'alice','Alice',$2) ON CONFLICT (id) DO NOTHING",
    [alice, face],
  );
  const created = await (await characters.POST(new Request("http://test/api/characters", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Seraphine", title: "Seraphine", creationType: "character", visibility: "public", avatarPath: cover }),
  }))).json() as { character: Character };
  creationId = created.character.id;
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.AFTERGLOW_ADMIN_USER_IDS; });

const trace = (id: string) => diagnostics.GET(new Request(`http://test/api/admin/og-card-diagnostics?id=${id}`));

describe("only a moderator may trace a creation", () => {
  it("refuses a signed-out caller", async () => {
    account = null;
    expect((await trace(creationId)).status).toBe(401);
  });

  it("refuses the creation's own creator", async () => {
    // This route makes the server fetch a creator-supplied URL. That is the
    // same request the preview route already makes, but it is not something
    // anybody should be able to aim.
    expect((await trace(creationId)).status).toBe(403);
  });

  it("refuses a malformed id before touching anything", async () => {
    account = { id: moderator, email: "mod@example.com" };
    expect((await trace("not-an-id")).status).toBe(400);
  });
});

describe("the trace names the step that lost the artwork", () => {
  beforeEach(() => { account = { id: moderator, email: "mod@example.com" }; });

  it("shows the row, the SQL, the model and the render agreeing until the last one", async () => {
    const body = await (await trace(creationId)).json();

    // The row has a cover…
    expect(body.row.avatarPath).toBe(cover);
    expect(body.row.contentMode).toBe("clean");
    // …the SQL ships it…
    expect(body.safeLandingSql.openAvatarPath).toEqual({ present: true, value: cover });
    expect(body.safeLandingSql.creatorAvatarPath.present).toBe(true);
    // …the view model resolves it…
    expect(body.viewModel.openArt).toMatchObject({ kind: "storage", isCover: true });
    // …the card model carries a URL…
    expect(body.cardModel.artwork).toContain(cover);
    // …and the renderer will not draw it, which is the answer.
    expect(body.render.artwork).toMatchObject({ state: "unsupported_format", format: "image/webp", drawn: false });
    // The creator's picture, from the same chain, does draw — which is exactly
    // the confusing production symptom, explained.
    expect(body.render.creatorAvatar).toMatchObject({ state: "ready", drawn: true });
    expect(body.storageConfigured).toBe(true);
  });

  it("hands back no image bytes at all", async () => {
    const text = await (await trace(creationId)).text();
    expect(text).not.toContain("base64");
    expect(text).not.toContain("data:image");
    // The public storage address is included, because it is what a moderator
    // opens to see what the renderer saw, and it is already public.
    expect(text).toContain(cover);
  });

  it("reports a creation that resolves to nothing without inventing one", async () => {
    const body = await (await trace("aaaaaaaa-0000-4000-8000-00000000dead")).json();
    expect(body.row).toBeNull();
    expect(body.viewModel).toBeNull();
    expect(body.cardModel).toBeNull();
    expect(body.render.artwork.state).toBe("absent");
  });

  it("reports a gated creation as offering nothing, not as failing", async () => {
    await query("UPDATE characters SET content_mode='adult_focused' WHERE id=$1", [creationId]);
    const body = await (await trace(creationId)).json();
    expect(body.viewModel.openArt.kind).toBe("fallback");
    expect(body.viewModel.classifiedShare).toBe("fallback");
    expect(body.render.artwork.state).toBe("absent");
  });
});
