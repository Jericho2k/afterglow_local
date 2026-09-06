import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nominatedMedia, shareMedia, shareMediaCandidate } from "@/lib/content-mode";
import { draftFromCharacter, draftPayload } from "@/components/studio/draft";
import type { Character } from "@/lib/types";

/**
 * The half of the share-media rule that was never built.
 *
 * 0036 said a creator NOMINATES an image and Afterglow CLASSIFIES it, and then
 * shipped only the refusal: nothing in the product could write `safe`, so the
 * column was a permanently closed door and every external preview fell back to
 * the branded card. Two things had to be true before it could be opened, and
 * both are asserted here.
 *
 *   * A classification approves AN IMAGE. Swapping the nominated image after an
 *     approval has to withdraw it, or the approval becomes a standing licence
 *     to publish anything into somebody's Discord.
 *   * A creator still cannot classify their own media. Nomination is theirs;
 *     `share_media_status` is not, and no payload may set it.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const moderator = "33333333-3333-4333-8333-333333333333";
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
const shareMediaAdmin = await import("@/app/api/admin/share-media/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const cover = `users/${alice}/avatars/cover.png`;
const banner = `users/${alice}/avatars/banner.png`;
const quiet = `users/${alice}/avatars/quiet.png`;

function post(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function statusOf(id: string) {
  const row = await query("SELECT share_media_status FROM characters WHERE id=$1", [id]);
  return String(row.rows[0].share_media_status);
}

async function approve(id: string, image: string) {
  // The platform's own write, standing in for a moderator's decision.
  await query("UPDATE characters SET share_media_status='safe' WHERE id=$1", [id]);
  expect(await statusOf(id)).toBe("safe");
  return image;
}

/** The studio's save, in full: draft → payload → PATCH. */
async function save(id: string, changes: Partial<Character>) {
  const opened = await (await characterDetail.GET(new Request(`http://test?scope=edit`), params(id))).json() as { character: Character };
  const draft = { ...draftFromCharacter(opened.character), ...changes };
  const response = await characterDetail.PATCH(
    new Request(`http://test/api/characters/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draftPayload(draft)) }),
    params(id),
  );
  expect(response.status).toBe(200);
  return (await response.json() as { character: Character }).character;
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
  process.env.AFTERGLOW_ADMIN_USER_IDS = moderator;
  account = { id: alice, email: "alice@example.com" };

  const created = await (await characters.POST(post("http://test/api/characters", {
    name: "Seraphine", title: "Seraphine", creationType: "character", visibility: "public", avatarPath: cover,
  }))).json() as { character: Character };
  creationId = created.character.id;
});

describe("nomination is the creator's, classification is not", () => {
  it("starts unreviewed, whatever the payload says", async () => {
    expect(await statusOf(creationId)).toBe("unreviewed");
    // The status is absent from `characterSchema`, so this is dropped rather
    // than rejected — and the row is untouched either way.
    await save(creationId, { shareMediaStatus: "safe" } as Partial<Character>);
    expect(await statusOf(creationId)).toBe("unreviewed");
  });

  it("keeps an approval while the nominated image is unchanged", async () => {
    await approve(creationId, cover);
    // Everything else about the creation may change without re-review: the
    // approval is about the picture, and the picture has not moved.
    await save(creationId, { title: "Seraphine of the Long Quay", tagline: "New line", shareTitle: "Slow burn" });
    expect(await statusOf(creationId)).toBe("safe");
    // A banner and a focal point are not the shared image either, so framing
    // work does not cost a creator their approval.
    await save(creationId, { bannerPath: banner, artPresentation: { cover: { focal: { x: 0.3, y: 0.2 } } } });
    expect(await statusOf(creationId)).toBe("safe");
  });

  it("withdraws it the moment the nominated image changes", async () => {
    await approve(creationId, cover);
    // Nothing nominated means the cover is what would be published, so
    // replacing the cover replaces the approved image.
    await save(creationId, { avatarPath: `users/${alice}/avatars/other.png` });
    expect(await statusOf(creationId)).toBe("unreviewed");

    await approve(creationId, `users/${alice}/avatars/other.png`);
    // And nominating a different image explicitly is the same event.
    await save(creationId, { shareImagePath: quiet });
    expect(await statusOf(creationId)).toBe("unreviewed");
  });

  it("protects a nominated image from a cover change, and vice versa", async () => {
    await save(creationId, { shareImagePath: quiet });
    await approve(creationId, quiet);
    // The cover is not what would be published once something else is
    // nominated, so changing it is not a re-nomination.
    await save(creationId, { avatarPath: `users/${alice}/avatars/redrawn.png` });
    expect(await statusOf(creationId)).toBe("safe");
    // Withdrawing the nomination falls back to the cover — a different image
    // again, and one nobody has looked at.
    await save(creationId, { shareImagePath: "" });
    expect(await statusOf(creationId)).toBe("unreviewed");
  });

  it("resolves the same nominated image in TypeScript and in SQL", () => {
    /*
     * The reset lives in the UPDATE, so its resolution order is written twice —
     * once as SQL, once as `nominatedMedia`. They have to agree, or an image
     * would be reviewed under one rule and published under another.
     */
    const source = { shareImagePath: quiet, shareImageUrl: "https://example.test/x.png", avatarPath: cover, avatarUrl: "https://example.test/y.png" };
    expect(shareMediaCandidate(source)).toBe(quiet);
    expect(shareMediaCandidate({ ...source, shareImagePath: "" })).toBe("https://example.test/x.png");
    expect(shareMediaCandidate({ ...source, shareImagePath: "", shareImageUrl: "" })).toBe(cover);
    expect(shareMediaCandidate({ ...source, shareImagePath: "", shareImageUrl: "", avatarPath: "" })).toBe("https://example.test/y.png");
    expect(shareMediaCandidate({})).toBe("");

    const route = readFileSync(new URL("../src/app/api/characters/[id]/route.ts", import.meta.url), "utf8");
    expect(route).toContain("CASE WHEN share_image_path<>'' THEN share_image_path WHEN share_image_url<>'' THEN share_image_url WHEN avatar_path<>'' THEN avatar_path ELSE avatar_url END");
  });

  it("still refuses to publish an unclassified image, which is the older rule", () => {
    // `nominatedMedia` answers "which image", `shareMedia` answers "may it
    // leave" — and only the second consults the status.
    const source = { shareImagePath: quiet, avatarPath: cover };
    expect(nominatedMedia(source)).toEqual({ kind: "storage", path: quiet });
    expect(shareMedia({ ...source, status: "unreviewed" })).toEqual({ kind: "fallback" });
    expect(shareMedia({ ...source, status: "safe" })).toEqual({ kind: "storage", path: quiet });
  });
});

describe("the review queue", () => {
  it("is closed to everybody but a moderator", async () => {
    const denied = await shareMediaAdmin.GET(new Request("http://test/api/admin/share-media"));
    expect(denied.status).toBe(403);
    const refused = await shareMediaAdmin.POST(post("http://test/api/admin/share-media", { characterId: creationId, status: "safe", image: cover }));
    expect(refused.status).toBe(403);
    expect(await statusOf(creationId)).toBe("unreviewed");

    account = null;
    expect((await shareMediaAdmin.GET(new Request("http://test/api/admin/share-media"))).status).toBe(401);
  });

  it("lists the public creations whose nominated image nobody has classified", async () => {
    account = { id: moderator, email: "mod@example.com" };
    const body = await (await shareMediaAdmin.GET(new Request("http://test/api/admin/share-media"))).json();
    expect(body.queue).toHaveLength(1);
    expect(body.queue[0].characterId).toBe(creationId);
    // The cover, standing in because nothing else is nominated — and the
    // reviewer is told that rather than left to infer it.
    expect(body.queue[0].image).toEqual({ kind: "storage", path: cover, url: "", nominated: false });
  });

  it("leaves a creation with no image at all out of it", async () => {
    await save(creationId, { avatarPath: "", avatarUrl: "" });
    account = { id: moderator, email: "mod@example.com" };
    const body = await (await shareMediaAdmin.GET(new Request("http://test/api/admin/share-media"))).json();
    expect(body.queue).toHaveLength(0);
  });

  it("records a decision against the image, in the immutable log", async () => {
    account = { id: moderator, email: "mod@example.com" };
    const response = await shareMediaAdmin.POST(post("http://test/api/admin/share-media", { characterId: creationId, status: "safe", image: cover }));
    expect(response.status).toBe(200);
    expect(await statusOf(creationId)).toBe("safe");

    const log = await query("SELECT action,moderator_user_id,metadata FROM moderation_actions WHERE character_id=$1", [creationId]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].action).toBe("classify_share_media");
    expect(String(log.rows[0].moderator_user_id)).toBe(moderator);
    const metadata = typeof log.rows[0].metadata === "string" ? JSON.parse(log.rows[0].metadata) : log.rows[0].metadata;
    // The file, so "who approved this picture" has an answer even after the
    // creator has moved on to another one.
    expect(metadata).toMatchObject({ status: "safe", previousStatus: "unreviewed", image: cover });
  });

  it("refuses to classify an image the creator has since replaced", async () => {
    account = { id: moderator, email: "mod@example.com" };
    // The queue was drawn, and then the creator nominated something else.
    account = { id: alice, email: "alice@example.com" };
    await save(creationId, { shareImagePath: quiet });
    account = { id: moderator, email: "mod@example.com" };

    const response = await shareMediaAdmin.POST(post("http://test/api/admin/share-media", { characterId: creationId, status: "safe", image: cover }));
    expect(response.status).toBe(409);
    // Nothing was approved, and the creation is still waiting to be looked at.
    expect(await statusOf(creationId)).toBe("unreviewed");
    expect((await query("SELECT id FROM moderation_actions WHERE character_id=$1", [creationId])).rowCount).toBe(0);
  });

  it("rejects a decision that names no image or an unknown status", async () => {
    account = { id: moderator, email: "mod@example.com" };
    expect((await shareMediaAdmin.POST(post("http://test/api/admin/share-media", { characterId: creationId, status: "safe" }))).status).toBe(400);
    expect((await shareMediaAdmin.POST(post("http://test/api/admin/share-media", { characterId: creationId, status: "definitely_fine", image: cover }))).status).toBe(400);
    expect((await shareMediaAdmin.POST(post("http://test/api/admin/share-media", { characterId: "not-a-uuid", status: "safe", image: cover }))).status).toBe(400);
    expect(await statusOf(creationId)).toBe("unreviewed");
  });

  it("can take a decision back", async () => {
    account = { id: moderator, email: "mod@example.com" };
    await shareMediaAdmin.POST(post("http://test/api/admin/share-media", { characterId: creationId, status: "safe", image: cover }));
    await shareMediaAdmin.POST(post("http://test/api/admin/share-media", { characterId: creationId, status: "rejected", image: cover }));
    expect(await statusOf(creationId)).toBe("rejected");
    // Both decisions are in the log; the first is not edited away.
    expect((await query("SELECT id FROM moderation_actions WHERE character_id=$1", [creationId])).rowCount).toBe(2);
  });
});

describe("the workflow is stated where it is enforced", () => {
  it("permits the new action in the audit constraint", () => {
    const migration = readFileSync(new URL("../supabase/migrations/0038_share_media_review.sql", import.meta.url), "utf8");
    expect(migration).toContain("'classify_share_media'");
    // The existing actions survive the constraint being replaced.
    for (const action of ["mark_reviewing", "dismiss", "resolve_no_removal", "remove_creation", "restore_creation"]) {
      expect(migration).toContain(`'${action}'`);
    }
  });

  it("gives the creator somewhere to nominate from", () => {
    const publish = readFileSync(new URL("../src/components/studio/PublishStep.tsx", import.meta.url), "utf8");
    expect(publish).toContain("<ShareImageField");
    const media = readFileSync(new URL("../src/components/studio/MediaFields.tsx", import.meta.url), "utf8");
    // Three sources, and no control that writes a classification.
    expect(media).toContain('label: "Cover artwork"');
    expect(media).toContain('label: "Desktop banner"');
    expect(media).toContain('label: "Another image"');
    expect(media).not.toContain("shareMediaStatus:");
  });

  it("says plainly that no automated classifier exists yet", () => {
    // The report the sprint asked for, kept in the repository rather than in a
    // pull request comment: the reason this queue is human is that there is no
    // image-moderation provider here, and adding one is a decision with a bill.
    const report = readFileSync(new URL("../docs/share-media-review-2026-09.md", import.meta.url), "utf8");
    expect(report).toContain("no image-moderation");
  });
});
