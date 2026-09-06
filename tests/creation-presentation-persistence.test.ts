import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { artPresentation, bannerArt } from "@/lib/art-presentation";
import { draftFromCharacter, draftPayload, isMeaningfulDraft, type CreationDraft } from "@/components/studio/draft";
import { forgetCreation, readCreation, rememberCreation, resetCreationCacheForTesting } from "@/lib/creation-cache";
import type { Character } from "@/lib/types";

/**
 * A creator changes how their creation is presented, and it stays changed.
 *
 * The reported bug was that framing a cover and uploading a desktop banner
 * appeared to do nothing: the Creation page kept its previous presentation and
 * reopening the studio showed the previous controls. The database was never the
 * problem — `PATCH` wrote `banner_path`, `banner_url` and `art_presentation`,
 * and every query selected them back. `characterFromRow` simply never read them
 * into the `Character` it returned, so the whole authenticated half of the
 * product — the page, the editor, and the payload the NEXT save is built from —
 * was working from a record that had no banner and no framing in it. The third
 * consequence is the destructive one: saving twice wrote the missing fields
 * back as empty.
 *
 * So this walks the real flow rather than asserting on the write:
 *
 *   editor opens → cover focal point → banner upload → banner focal point →
 *   Save → record read back → Creation page → editor reopened
 *
 * and it does it for both save controls, because the top-right Save leaves the
 * studio open on the record the server just returned.
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

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const banner = `users/${alice}/avatars/banner.png`;
const cover = `users/${alice}/avatars/cover.png`;

function post(body: unknown) {
  return new Request("http://test/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** Opening the studio on an existing creation: the editor's own first request. */
async function openEditor(id: string): Promise<CreationDraft> {
  const response = await characterDetail.GET(new Request(`http://test/api/characters/${id}?scope=edit`), params(id));
  expect(response.status).toBe(200);
  const { character } = await response.json() as { character: Character };
  return draftFromCharacter(character);
}

/** Either Save control: both send exactly this. */
async function save(id: string, draft: CreationDraft): Promise<Character> {
  const response = await characterDetail.PATCH(
    new Request(`http://test/api/characters/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draftPayload(draft)) }),
    params(id),
  );
  expect(response.status).toBe(200);
  return (await response.json() as { character: Character }).character;
}

/** What the signed-in Creation page fetches and draws. */
async function creationPage(id: string) {
  const response = await characterDetail.GET(new Request(`http://test/api/characters/${id}`), params(id));
  expect(response.status).toBe(200);
  const { character } = await response.json() as { character: Character };
  return {
    character,
    // Byte for byte what src/app/characters/[id]/profile.tsx computes for its
    // hero, so this is the page's own decision rather than an imitation of it.
    hero: bannerArt({
      avatarPath: character.avatarPath,
      avatarUrl: character.avatarUrl,
      bannerPath: character.bannerPath ?? "",
      bannerUrl: character.bannerUrl ?? "",
      presentation: artPresentation(character.artPresentation),
    }),
  };
}

/** The creator's edits, made in the order the studio makes them. */
function framed(draft: CreationDraft): CreationDraft {
  // 1. Point at the part of the cover that must survive every crop.
  const withCover: CreationDraft = { ...draft, artPresentation: { ...artPresentation(draft.artPresentation), cover: { focal: { x: 0.3, y: 0.2 } } } };
  // 2. Upload a desktop banner. 3. Frame that too.
  return {
    ...withCover,
    bannerPath: banner,
    artPresentation: { ...withCover.artPresentation, banner: { focal: { x: 0.7, y: 0.35 } } },
  };
}

let creationId = "";

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
  resetCreationCacheForTesting();
  account = { id: alice, email: "alice@example.com" };

  const created = await (await characters.POST(post({
    name: "Seraphine", title: "Seraphine", creationType: "character", visibility: "public", avatarPath: cover,
  }))).json() as { character: Character };
  creationId = created.character.id;
});

describe("framing and a banner survive a save", () => {
  it("comes back from the API that wrote it", async () => {
    const saved = await save(creationId, framed(await openEditor(creationId)));

    // The response is what the studio keeps as its record and what the shell
    // hands to every list it has open, so an omission here is not cosmetic:
    // it is the value the next save will send back.
    expect(saved.bannerPath).toBe(banner);
    expect(saved.artPresentation).toEqual({ cover: { focal: { x: 0.3, y: 0.2 } }, banner: { focal: { x: 0.7, y: 0.35 } } });
  });

  it("is stored as a versioned document rather than as two floats", async () => {
    await save(creationId, framed(await openEditor(creationId)));
    const row = await query("SELECT banner_path,banner_url,art_presentation FROM characters WHERE id=$1", [creationId]);
    expect(row.rows[0].banner_path).toBe(banner);
    const stored = typeof row.rows[0].art_presentation === "string"
      ? JSON.parse(row.rows[0].art_presentation)
      : row.rows[0].art_presentation;
    expect(stored).toEqual({ v: 1, cover: { focal: { x: 0.3, y: 0.2 } }, banner: { focal: { x: 0.7, y: 0.35 } } });
  });

  it("renders on the Creation page the creator lands back on", async () => {
    await save(creationId, framed(await openEditor(creationId)));
    const { character, hero } = await creationPage(creationId);

    expect(character.bannerPath).toBe(banner);
    // The dedicated banner, framed by the banner's own focal point — not the
    // cover falling back into a wide slot, which is what the page drew while
    // these fields were missing and is exactly what "kept the previous
    // presentation" looked like.
    expect(hero.dedicated).toBe(true);
    expect(hero.path).toBe(banner);
    expect(hero.style).toEqual({ objectPosition: "70% 35%" });
  });

  it("is in the controls when the editor is reopened", async () => {
    await save(creationId, framed(await openEditor(creationId)));
    const reopened = await openEditor(creationId);

    expect(reopened.bannerPath).toBe(banner);
    expect(artPresentation(reopened.artPresentation)).toEqual({
      cover: { focal: { x: 0.3, y: 0.2 } },
      banner: { focal: { x: 0.7, y: 0.35 } },
    });
    // And the reopened editor is not dirty: a creator who opens the studio and
    // touches nothing has no unsaved work to be offered back.
    expect(isMeaningfulDraft(reopened, reopened)).toBe(false);
  });
});

describe("both Save controls", () => {
  /*
   * The top-right Save keeps the studio open, so the record it holds afterwards
   * is the one the server returned. Pressing Save changes then sends a payload
   * derived from that record — which is why a field missing from the response
   * is not merely invisible, it is deleted on the second press. This is the
   * two-save sequence a creator actually performs.
   */
  it("keeps the presentation when Save is followed by Save changes", async () => {
    const afterTopRight = await save(creationId, framed(await openEditor(creationId)));
    expect(afterTopRight.bannerPath).toBe(banner);

    // The studio continues from the saved record, and the creator makes an
    // unrelated edit before finishing.
    const continued = { ...draftFromCharacter(afterTopRight), tagline: "The girl who writes your name" };
    const afterSaveChanges = await save(creationId, continued);

    expect(afterSaveChanges.tagline).toBe("The girl who writes your name");
    expect(afterSaveChanges.bannerPath).toBe(banner);
    expect(afterSaveChanges.artPresentation).toEqual({ cover: { focal: { x: 0.3, y: 0.2 } }, banner: { focal: { x: 0.7, y: 0.35 } } });

    const { hero } = await creationPage(creationId);
    expect(hero.path).toBe(banner);
    expect(hero.style).toEqual({ objectPosition: "70% 35%" });
  });

  it("still lets a creator remove a banner deliberately", async () => {
    await save(creationId, framed(await openEditor(creationId)));
    const reopened = await openEditor(creationId);
    // What the "Remove banner" control does: the asset and its framing go, the
    // cover's framing stays.
    const removed: CreationDraft = { ...reopened, bannerPath: "", bannerUrl: "", artPresentation: { cover: { focal: { x: 0.3, y: 0.2 } } } };
    await save(creationId, removed);

    const { hero, character } = await creationPage(creationId);
    expect(character.bannerPath).toBe("");
    expect(hero.dedicated).toBe(false);
    expect(hero.path).toBe(cover);
    expect(hero.style).toEqual({ objectPosition: "30% 20%" });
  });
});

describe("the studio knows the presentation changed", () => {
  it("counts framing, a banner and outward copy as unsaved work", async () => {
    const opened = await openEditor(creationId);
    // Each of these used to leave the draft looking identical to the record:
    // autosave kept nothing, and a closed tab lost the change.
    expect(isMeaningfulDraft({ ...opened, artPresentation: { cover: { focal: { x: 0.3, y: 0.2 } } } }, opened)).toBe(true);
    expect(isMeaningfulDraft({ ...opened, bannerPath: banner }, opened)).toBe(true);
    expect(isMeaningfulDraft({ ...opened, bannerUrl: "https://example.test/wide.png" }, opened)).toBe(true);
    expect(isMeaningfulDraft({ ...opened, shareTitle: "Slow burn" }, opened)).toBe(true);
    expect(isMeaningfulDraft({ ...opened, shareTagline: "A quiet romance." }, opened)).toBe(true);
    expect(isMeaningfulDraft({ ...opened, shareImagePath: cover }, opened)).toBe(true);
    expect(isMeaningfulDraft({ ...opened, contentMode: "adult_capable" }, opened)).toBe(true);
    expect(isMeaningfulDraft({ ...opened, descriptionRich: [{ type: "image", path: `users/${alice}/avatars/inline.png`, url: "", caption: "" }] }, opened)).toBe(true);
  });

  it("does not count opening the picker and closing it again", async () => {
    const opened = await openEditor(creationId);
    // An empty `cover` key is what the picker leaves behind when a creator
    // looks and commits to nothing. It stores as nothing, so it must compare as
    // nothing — otherwise every creation that was merely LOOKED at is offered
    // back as recovered work.
    expect(isMeaningfulDraft({ ...opened, artPresentation: { cover: {} } }, opened)).toBe(false);
  });

  it("ignores a classification the platform changed underneath the creator", async () => {
    const opened = await openEditor(creationId);
    // `shareMediaStatus` is the one stored field a creator does not edit. A
    // moderator approving their image must not make their open studio look
    // like it holds unsaved work.
    expect(isMeaningfulDraft({ ...opened, shareMediaStatus: "safe" }, opened)).toBe(false);
  });
});

describe("the page cannot paint what the save replaced", () => {
  it("forgets the creation this tab had already been shown", async () => {
    rememberCreation(creationId, { detail: { character: { bannerPath: "" } }, comments: [] });
    expect(readCreation(creationId)).toBeDefined();
    forgetCreation(creationId);
    // A Back into the creation page now finds nothing to paint and waits for
    // the fetch, which is the only way the first frame can be the saved one.
    expect(readCreation(creationId)).toBeUndefined();
  });

  it("is what a successful save actually does", () => {
    /*
     * The wiring, asserted at the source, because the alternative is a jsdom
     * mount of the whole studio to observe one map deletion. Saving is the
     * single choke point — both controls call it — so the invalidation belongs
     * inside it and nowhere else.
     */
    const studio = readFileSync(new URL("../src/components/studio/CreationStudio.tsx", import.meta.url), "utf8");
    expect(studio).toContain('import { forgetCreation } from "@/lib/creation-cache"');
    const save = studio.slice(studio.indexOf("async function save("), studio.indexOf("async function remove("));
    expect(save).toContain("forgetCreation(complete.id)");
    // And before the studio hands control back to whoever is navigating.
    expect(save.indexOf("forgetCreation(complete.id)")).toBeLessThan(save.indexOf("onSaved(complete"));
  });

  it("leaves the corrected Back semantics alone", () => {
    // Saving still returns THROUGH history when the creation's page is the
    // entry underneath, and still replaces otherwise. Invalidating a cache is
    // not a navigation change, and this is what says so if somebody later
    // reaches for `router.push` to force a fresh render.
    const editor = readFileSync(new URL("../src/app/characters/[id]/edit/editor.tsx", import.meta.url), "utf8");
    expect(editor).toContain("savedEditDestination(savedId, takeEditorOrigin(window.sessionStorage))");
    expect(editor).toContain('if (destination.type === "back") { router.back(); return; }');
    expect(editor).not.toContain("router.push");
  });
});
