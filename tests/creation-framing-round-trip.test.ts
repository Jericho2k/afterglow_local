import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { artPresentation, artStyle, bannerArt } from "@/lib/art-presentation";
import { draftFromCharacter, draftPayload, isMeaningfulDraft, type CreationDraft } from "@/components/studio/draft";
import { defaultArtworkPosition, ogCardModel } from "@/lib/og-card";
import type { Character } from "@/lib/types";
import { emptyCastFunctionForPgMem, publicFunctionSql, publicSqlDatabase, publicViewFunctions } from "./helpers/public-functions";

/**
 * A creator frames their artwork once, and everybody who may see the creation
 * sees the frame they chose.
 *
 * The reported failure was that framing a cover or uploading a desktop banner
 * appeared to do nothing. The write was never wrong — `PATCH` has always stored
 * `banner_path`, `banner_url` and `art_presentation` — so this walks the whole
 * loop instead of asserting on the statement, and it walks it through the REAL
 * routes and the REAL SQL:
 *
 *   editor GET (?scope=edit) → focal point → PATCH → editor GET again →
 *   signed-in page → the anonymous view model → the external card
 *
 * tests/creation-presentation-persistence.test.ts already covers the studio and
 * the signed-in half. What was never covered — and is where a column silently
 * stops travelling, because nothing in TypeScript notices a field that is
 * merely undefined — is the anonymous half: the public functions in
 * supabase/migrations, defined here from the migration files rather than
 * imagined. See tests/helpers/public-functions.ts.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const cover = `users/${alice}/avatars/cover.png`;
const banner = `users/${alice}/avatars/banner.png`;
const nominated = `users/${alice}/avatars/share.png`;
const face = `users/${alice}/avatars/me.png`;

let account: { id: string; email: string | null } | null = null;

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (value: string) => JSON.parse(value),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://storage.test";

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const characters = await import("@/app/api/characters/route");
const characterDetail = await import("@/app/api/characters/[id]/route");
const publicView = await import("@/lib/public-view");

const params = (id: string) => ({ params: Promise.resolve({ id }) });

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
    new Request(`http://test/api/characters/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draftPayload(draft)),
    }),
    params(id),
  );
  expect(response.status).toBe(200);
  return (await response.json() as { character: Character }).character;
}

/** The hero the signed-in Creation page draws, computed the way that page does. */
async function signedInHero(id: string) {
  const response = await characterDetail.GET(new Request(`http://test/api/characters/${id}`), params(id));
  expect(response.status).toBe(200);
  const { character } = await response.json() as { character: Character };
  return bannerArt({
    avatarPath: character.avatarPath,
    avatarUrl: character.avatarUrl,
    bannerPath: character.bannerPath ?? "",
    bannerUrl: character.bannerUrl ?? "",
    presentation: artPresentation(character.artPresentation),
  });
}

/** The hero a logged-out reader draws, from the anonymous view model. */
async function anonymousHero(id: string) {
  const page = await publicView.publicCreationPage(id);
  expect(page, "the anonymous page resolved").not.toBeNull();
  return bannerArt({
    avatarPath: page!.art.avatarPath,
    avatarUrl: page!.art.avatarUrl,
    bannerPath: page!.art.bannerPath,
    bannerUrl: page!.art.bannerUrl,
    presentation: page!.art.presentation,
  });
}

async function externalCard(id: string) {
  const landing = await publicView.publicSafeLanding(id);
  expect(landing, "the safe landing resolved").not.toBeNull();
  return { landing: landing!, card: ogCardModel(landing!) };
}

let creationId = "";

beforeEach(async () => {
  const memoryDb = publicSqlDatabase();
  setPoolForTesting(new (memoryDb.adapters.createPg().Pool)() as unknown as Pool);
  await ensureSchema();
  for (const fn of publicViewFunctions) await query(publicFunctionSql(fn.migration, fn.name), []);
  await query(emptyCastFunctionForPgMem, []);
  account = { id: alice, email: "alice@example.com" };
  // A creator with a handle and a profile picture, which is what makes them
  // visible to the anonymous functions at all.
  await query(
    "INSERT INTO profiles (id,username,display_name,avatar_path) VALUES ($1,'alice','Alice',$2) ON CONFLICT (id) DO NOTHING",
    [alice, face],
  );

  const created = await (await characters.POST(new Request("http://test/api/characters", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Seraphine", title: "Seraphine of the Long Quay", creationType: "character",
      visibility: "public", avatarPath: cover, accent: "#e879a9",
      shareTagline: "A quiet, unhurried romance on a harbour that never sleeps.",
    }),
  }))).json() as { character: Character };
  creationId = created.character.id;
});

describe("a cover focal point survives the save that wrote it", () => {
  it("is exactly where the creator put it when the editor reopens", async () => {
    const opened = await openEditor(creationId);
    expect(artPresentation(opened.artPresentation)).toEqual({});

    await save(creationId, { ...opened, artPresentation: { cover: { focal: { x: 0.31, y: 0.19 } } } });

    // Not "there is a focal point": the same two numbers, because a rounding
    // or a re-normalisation on the way through would move a creator's crop.
    const reopened = await openEditor(creationId);
    expect(artPresentation(reopened.artPresentation)).toEqual({ cover: { focal: { x: 0.31, y: 0.19 } } });
    // And the reopened editor holds no unsaved work, so nothing is offered back.
    expect(isMeaningfulDraft(reopened, reopened)).toBe(false);
  });

  it("frames the artwork identically for a member and for a stranger", async () => {
    await save(creationId, { ...await openEditor(creationId), artPresentation: { cover: { focal: { x: 0.31, y: 0.19 } } } });

    const member = await signedInHero(creationId);
    const stranger = await anonymousHero(creationId);
    expect(member.style).toEqual({ objectPosition: "31% 19%" });
    // The two pages read different columns through different functions. If they
    // ever disagree, the creator's decision applied to half their audience.
    expect(stranger).toEqual(member);
  });

  it("reaches the 3:4 card and the 1:1 ranked row a stranger sees too", async () => {
    await save(creationId, { ...await openEditor(creationId), artPresentation: { cover: { focal: { x: 0.31, y: 0.19 } } } });
    const card = await publicView.publicCreationCard(creationId);
    expect(card).not.toBeNull();
    expect(artStyle(card!.art.presentation, "cover", "3:4")).toEqual({ objectPosition: "31% 19%" });
    expect(artStyle(card!.art.presentation, "cover", "1:1")).toEqual({ objectPosition: "31% 19%" });
  });
});

describe("a desktop banner and its own focal point survive too", () => {
  const framed = (draft: CreationDraft): CreationDraft => ({
    ...draft,
    bannerPath: banner,
    artPresentation: { cover: { focal: { x: 0.31, y: 0.19 } }, banner: { focal: { x: 0.72, y: 0.36 } } },
  });

  it("comes back from the edit GET as a banner, not as a missing field", async () => {
    await save(creationId, framed(await openEditor(creationId)));
    const reopened = await openEditor(creationId);
    expect(reopened.bannerPath).toBe(banner);
    expect(artPresentation(reopened.artPresentation)).toEqual({
      cover: { focal: { x: 0.31, y: 0.19 } },
      banner: { focal: { x: 0.72, y: 0.36 } },
    });
  });

  it("is the wide image both readers draw, at the banner's own focal point", async () => {
    await save(creationId, framed(await openEditor(creationId)));

    const member = await signedInHero(creationId);
    const stranger = await anonymousHero(creationId);
    // The DEDICATED banner, not the cover falling back into a wide slot — which
    // is what "the old presentation remains" looked like.
    expect(member.dedicated).toBe(true);
    expect(member.path).toBe(banner);
    expect(member.style).toEqual({ objectPosition: "72% 36%" });
    expect(stranger).toEqual(member);
  });

  it("survives a second save built from the record the first one returned", async () => {
    /*
     * The destructive shape of this bug. The top-right Save keeps the studio
     * open, so the next payload is derived from the server's response — a field
     * missing from that response is not merely invisible, it is written back as
     * empty on the following press.
     */
    const afterFirst = await save(creationId, framed(await openEditor(creationId)));
    const continued = { ...draftFromCharacter(afterFirst), tagline: "The girl who writes your name" };
    const afterSecond = await save(creationId, continued);

    expect(afterSecond.tagline).toBe("The girl who writes your name");
    expect(afterSecond.bannerPath).toBe(banner);
    expect(afterSecond.artPresentation).toEqual({
      cover: { focal: { x: 0.31, y: 0.19 } },
      banner: { focal: { x: 0.72, y: 0.36 } },
    });
    expect((await anonymousHero(creationId)).style).toEqual({ objectPosition: "72% 36%" });
  });

  it("still lets a creator take the banner away again", async () => {
    await save(creationId, framed(await openEditor(creationId)));
    const reopened = await openEditor(creationId);
    // What "Remove banner" does: the asset and its framing go, the cover's stays.
    await save(creationId, { ...reopened, bannerPath: "", bannerUrl: "", artPresentation: { cover: { focal: { x: 0.31, y: 0.19 } } } });

    const stranger = await anonymousHero(creationId);
    expect(stranger.dedicated).toBe(false);
    expect(stranger.path).toBe(cover);
    expect(stranger.style).toEqual({ objectPosition: "31% 19%" });
  });
});

describe("the external card is framed by the same decision", () => {
  it("crops toward the creator's focal point rather than a constant", async () => {
    const { card: before } = await externalCard(creationId);
    expect(before.artworkPosition).toBe(defaultArtworkPosition);

    await save(creationId, { ...await openEditor(creationId), artPresentation: { cover: { focal: { x: 0.31, y: 0.19 } } } });

    const { card } = await externalCard(creationId);
    expect(card.artwork).toContain(cover);
    expect(card.artworkPosition).toBe("31% 19%");
  });

  it("carries the creation's own artwork without waiting for a classification", async () => {
    // Nothing has classified anything: `share_media_status` is still whatever a
    // brand-new public creation gets, and this is the case that used to produce
    // the artless card for the entire catalogue.
    const stored = await query("SELECT share_media_status FROM characters WHERE id=$1", [creationId]);
    expect(stored.rows[0].share_media_status).toBe("unreviewed");

    const { card } = await externalCard(creationId);
    expect(card.artwork).toContain(cover);
    expect(card.adult).toBe(false);
    expect(card.title).toBe("Seraphine of the Long Quay");
  });

  it("prefers an image nominated for sharing over the cover", async () => {
    await save(creationId, { ...await openEditor(creationId), shareImagePath: nominated });
    const { card } = await externalCard(creationId);
    expect(card.artwork).toContain(nominated);
    expect(card.artwork).not.toContain(cover);
  });

  it("shows the creator's profile picture and derives no initial", async () => {
    const { card } = await externalCard(creationId);
    expect(card.creatorAvatar).toContain(face);
    expect(card.creatorAvatar).toContain("/profile-avatars/");
    expect(Object.keys(card)).not.toContain("monogram");
  });

  it("omits the picture, and nothing else, for a creator who has none", async () => {
    await query("UPDATE profiles SET avatar_path='' WHERE id=$1", [alice]);
    const { card } = await externalCard(creationId);
    expect(card.creatorAvatar).toBe("");
    // The corner is simply empty. There is no letter to fall back to.
    expect(card.title).toBe("Seraphine of the Long Quay");
    expect(card.handle).toBe("@alice");
  });

  it("carries no profile field beyond the picture into the public model", async () => {
    // The safe landing is the narrowest public shape in the product. One field
    // was needed; a bio, a cover, an id or a follower count would each be a new
    // surface, and the test says so by name rather than by intention.
    const { landing } = await externalCard(creationId);
    expect(Object.keys(landing.creator).sort()).toEqual(["avatarPath", "displayName", "username"]);
  });
});

describe("an adult-focused creation gives up none of this", () => {
  beforeEach(async () => {
    await save(creationId, {
      ...await openEditor(creationId),
      contentMode: "adult_focused",
      artPresentation: { cover: { focal: { x: 0.31, y: 0.19 } } },
      shareTagline: "",
    });
  });

  it("has no anonymous page at all, framed or otherwise", async () => {
    expect(await publicView.publicCreationPage(creationId)).toBeNull();
    expect(await publicView.publicCreationCard(creationId)).toBeNull();
  });

  it("sends its cover and its framing nowhere, straight out of the SQL", async () => {
    const { landing, card } = await externalCard(creationId);
    // The columns an open creation's card is built from come back EMPTY for
    // this row, which is the guarantee the application cannot undo.
    expect(landing.openArt.media).toEqual({ kind: "fallback" });
    expect(landing.openArt.presentation).toEqual({});
    expect(card.artwork).toBe("");
    expect(card.artworkPosition).toBe(defaultArtworkPosition);
    // Nor its title, which its own SQL blanks.
    expect(landing.title).toBe("");
    expect(card.title).toBe("18+ creation by @alice");
    expect(card.adult).toBe(true);
  });

  it("may still carry media a moderator classified safe, and only that", async () => {
    await save(creationId, { ...await openEditor(creationId), shareImagePath: nominated });
    // Only Afterglow writes this column; `characterSchema` cannot.
    await query("UPDATE characters SET share_media_status='safe' WHERE id=$1", [creationId]);

    const { landing, card } = await externalCard(creationId);
    expect(card.artwork).toContain(nominated);
    // The approval let ONE image out. The creation's ordinary presentation —
    // its cover, its framing — is still blanked at source.
    expect(card.artwork).not.toContain(cover);
    expect(landing.openArt.media).toEqual({ kind: "fallback" });
    expect(landing.openArt.presentation).toEqual({});
    expect(card.adult).toBe(true);
  });

  it("keeps its creator's picture, which is not gated content", async () => {
    const { card } = await externalCard(creationId);
    expect(card.creatorAvatar).toContain(face);
  });
});

describe("an adult-capable creation is treated as the open page it is", () => {
  beforeEach(async () => {
    await save(creationId, {
      ...await openEditor(creationId),
      contentMode: "adult_capable",
      artPresentation: { cover: { focal: { x: 0.31, y: 0.19 } } },
    });
  });

  it("keeps its public page, its artwork and its framing", async () => {
    expect((await anonymousHero(creationId)).style).toEqual({ objectPosition: "31% 19%" });
    const { card } = await externalCard(creationId);
    expect(card.artwork).toContain(cover);
    expect(card.artworkPosition).toBe("31% 19%");
  });

  it("is not marked 18+ for being capable of it", async () => {
    // Media safety and roleplay capability are separate questions, and this is
    // the mode that exists to keep them separate. A badge here would make the
    // middle mode an 18+ discovery category by the back door.
    const { card } = await externalCard(creationId);
    expect(card.adult).toBe(false);
    expect(card.title).toBe("Seraphine of the Long Quay");
  });
});
