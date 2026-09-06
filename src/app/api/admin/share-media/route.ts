import { randomUUID } from "node:crypto";
import { nominatedMedia, shareMediaStatus, shareMediaStatuses, type ShareMediaStatus } from "@/lib/content-mode";
import { query, transaction } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, moderationAdminRequired, unauthorized } from "@/lib/session";

/**
 * Classifying the image a creator nominated for sharing.
 *
 * 0036 split the decision in two — a creator NOMINATES an image, the platform
 * CLASSIFIES it — and shipped only the refusal. Nothing anywhere wrote `safe`,
 * so `share_media_status` was a door with no handle: every external preview in
 * the product fell back to the branded card, permanently, and a creator who
 * followed the studio's instruction to nominate a share image was waiting on a
 * review that could not happen.
 *
 * This is the review. It is deliberately the SMALLEST thing that closes the
 * loop, and it is worth saying what it is not:
 *
 *   * It is not an automated classifier. There is none in this deployment —
 *     the providers here are text chat completions — and inventing a
 *     dependency on somebody else's vision model is a product decision with a
 *     bill attached, not a detail to slip into a fix. See
 *     docs/share-media-review-2026-09.md.
 *   * It is not a new kind of privilege. The reviewer is the moderator who
 *     already exists (`moderationAdminRequired`), and the decision lands in
 *     `moderation_actions`, which is already immutable, already keyed by
 *     creation, and already unreadable to everybody else.
 *   * It is not a trust checkbox for creators. A creator cannot reach this
 *     route, and `share_media_status` remains absent from `characterSchema`.
 *
 * The queue is deliberately narrow: public creations whose nominated image
 * nobody has classified. A private or unlisted creation has no external
 * preview to authorise, so reviewing one would be asking a person to look at
 * pictures for no reason.
 */

/** What a moderator may set. `unreviewed` is included so a decision can be undone. */
const decisions = shareMediaStatuses;

type QueueRow = {
  characterId: string;
  name: string;
  title: string;
  creator: { id: string; username: string; displayName: string };
  contentMode: string;
  status: ShareMediaStatus;
  /**
   * The image as it stands, which is what a decision applies to.
   *
   * `nominatedMedia` rather than `shareMedia`: the second answers "may this
   * leave Afterglow" and returns nothing for everything in this queue, which
   * is exactly the set a reviewer needs to look at.
   */
  image: { kind: string; path: string; url: string; nominated: boolean };
  updatedAt: string;
};

function imageOf(row: Record<string, unknown>) {
  const media = nominatedMedia({
    shareImagePath: String(row.share_image_path || ""),
    shareImageUrl: String(row.share_image_url || ""),
    avatarPath: String(row.avatar_path || ""),
    avatarUrl: String(row.avatar_url || ""),
  });
  return {
    kind: media.kind,
    path: media.kind === "storage" ? media.path : "",
    url: media.kind === "external" ? media.url : "",
    // Whether the creator chose this image FOR sharing, or it is their cover
    // standing in. A reviewer reads the two differently.
    nominated: Boolean(String(row.share_image_path || "").trim() || String(row.share_image_url || "").trim()),
  };
}

/**
 * The image a decision is about, as one comparable value.
 *
 * The same collapse `shareMediaCandidate` performs in TypeScript and the
 * character update performs in SQL, written once here so the queue and the
 * decision cannot disagree about which image they are talking about. The prefix
 * exists because the queue joins `profiles`, which has an `avatar_path` of its
 * own — a creator's portrait is not a creation's artwork, and an unqualified
 * column would be ambiguous rather than wrong in an interesting way.
 */
function candidateSql(prefix = "") {
  const column = (name: string) => `${prefix}${name}`;
  return `(CASE WHEN ${column("share_image_path")}<>'' THEN ${column("share_image_path")}`
    + ` WHEN ${column("share_image_url")}<>'' THEN ${column("share_image_url")}`
    + ` WHEN ${column("avatar_path")}<>'' THEN ${column("avatar_path")} ELSE ${column("avatar_url")} END)`;
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = moderationAdminRequired(account);
  if (denied) return denied;
  const requested = new URL(request.url).searchParams.get("status") || "unreviewed";
  const status = decisions.includes(requested as ShareMediaStatus) ? requested as ShareMediaStatus : "unreviewed";

  const result = await query(
    `SELECT c.id,c.name,c.title,c.content_mode,c.share_media_status,c.share_image_path,c.share_image_url,
       c.avatar_path,c.avatar_url,c.updated_at,c.user_id,p.username creator_username,p.display_name creator_display_name
     FROM characters c
     LEFT JOIN profiles p ON p.id=c.user_id
     WHERE c.visibility='public' AND c.moderation_status='active' AND c.share_media_status=$1
       AND ${candidateSql("c.")} <> ''
     ORDER BY c.updated_at DESC LIMIT 200`,
    [status],
  );

  const queue: QueueRow[] = result.rows.map((row) => ({
    characterId: String(row.id),
    name: String(row.name || ""),
    title: String(row.title || ""),
    creator: {
      id: String(row.user_id || ""),
      username: String(row.creator_username || ""),
      displayName: String(row.creator_display_name || "Afterglow creator"),
    },
    contentMode: String(row.content_mode || "clean"),
    status: shareMediaStatus(row.share_media_status),
    image: imageOf(row),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }));
  return Response.json({ queue, status });
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = moderationAdminRequired(account);
  if (denied) return denied;
  const limited = checkRateLimit(`share-media:${account.id}`, 120, 60_000);
  if (limited) return limited;

  const body = await request.json().catch(() => null) as { characterId?: unknown; status?: unknown; image?: unknown; reason?: unknown } | null;
  const characterId = typeof body?.characterId === "string" ? body.characterId : "";
  if (!/^[0-9a-f-]{36}$/i.test(characterId)) return Response.json({ error: "Invalid creation" }, { status: 400 });
  if (typeof body?.status !== "string" || !decisions.includes(body.status as ShareMediaStatus)) {
    return Response.json({ error: "Invalid classification" }, { status: 400 });
  }
  const status = body.status as ShareMediaStatus;
  /*
   * The image the moderator actually looked at.
   *
   * Required, and checked against the row inside the transaction, because a
   * creator can change their nomination between the queue being drawn and the
   * decision being made. Approving by creation id alone would then approve an
   * image nobody had seen — the same hole the reset in the character update
   * closes from the other side.
   */
  const reviewed = typeof body.image === "string" ? body.image.trim() : "";
  if (!reviewed) return Response.json({ error: "Name the image being classified" }, { status: 400 });
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";

  const outcome = await transaction(async (client) => {
    const found = await client.query(
      `SELECT id,share_media_status,${candidateSql()} candidate FROM characters WHERE id=$1 FOR UPDATE`,
      [characterId],
    );
    if (!found.rowCount) return { error: "notFound" as const };
    const current = String(found.rows[0].candidate || "");
    if (current !== reviewed) return { error: "changed" as const, current };
    await client.query("UPDATE characters SET share_media_status=$2 WHERE id=$1", [characterId, status]);
    await client.query(
      "INSERT INTO moderation_actions (id,character_id,report_id,moderator_user_id,action,reason,metadata) VALUES ($1,$2,NULL,$3,'classify_share_media',$4,$5::jsonb)",
      [randomUUID(), characterId, account.id, reason, JSON.stringify({
        status,
        previousStatus: shareMediaStatus(found.rows[0].share_media_status),
        // The audit names the file, so "who approved this picture" has an
        // answer even after the creator has moved on to another one.
        image: reviewed,
      })],
    );
    return { ok: true as const, status };
  });

  if ("error" in outcome && outcome.error === "notFound") return Response.json({ error: "Creation not found" }, { status: 404 });
  if ("error" in outcome && outcome.error === "changed") {
    return Response.json(
      { error: "The creator changed this image after the queue was drawn. Reload and review the current one.", current: outcome.current },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, characterId, status });
}
