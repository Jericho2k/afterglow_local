import { artworkReport, loadCardArtwork } from "@/lib/og-artwork";
import { ogCardModel } from "@/lib/og-card";
import { publicSafeLanding } from "@/lib/public-view";
import { query } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, moderationAdminRequired, unauthorized } from "@/lib/session";

/**
 * Where a creation's artwork stops on its way to a link preview.
 *
 * This exists because the failure it diagnoses is invisible by construction.
 * The composed card renders perfectly with the picture missing — same layout,
 * same wordmark, same creator, same 200 — so "the artwork is gone" and "this
 * creation has no artwork" and "this creation is gated" all produce the same
 * bytes. Reasoning about which one you are looking at, from the outside, is
 * not possible; the last round of this was spent doing exactly that.
 *
 * So the chain is walked once, in order, and every step reports what it saw:
 *
 *   characters.avatar_path / avatar_url / share_image_*        (the row)
 *     -> public_creation_safe_landing open_* columns            (the SQL)
 *     -> publicSafeLanding().openArt                            (the view model)
 *     -> ogCardModel().artwork                                  (the card model)
 *     -> loadCardArtwork()                                      (fetch + format)
 *     -> ImageResponse                                          (drawn, or not)
 *
 * WHAT IT WILL NOT SAY. No image bytes and no data URIs — a byte count and a
 * sniffed media type are enough to tell a WebP from a 404, and shipping the
 * picture through a JSON endpoint would be a second way to publish it. No
 * credentials, no environment values: `storageConfigured` is a boolean, not
 * the URL. Storage object PATHS are included because they are what the
 * moderator has to act on and are already public in every card and page this
 * creation appears in.
 *
 * Moderator-only, and rate limited, because it makes this server fetch a URL
 * that a creator supplied. That is the same request the preview route already
 * makes on its own, so it is not new reach — but it should not be reachable by
 * anybody who feels like pointing it somewhere.
 */

/** Empty rather than absent, so a missing column reads differently from an empty one. */
function present(row: Record<string, unknown>, column: string) {
  return { present: column in row, value: String(row[column] ?? "") };
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const denied = moderationAdminRequired(account);
  if (denied) return denied;
  const limited = checkRateLimit(`og-diagnostics:${account.id}`, 60, 60_000);
  if (limited) return limited;

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Pass a creation id" }, { status: 400 });

  /*
   * The stored row, read directly rather than through any view model.
   *
   * This is the only step that may disagree with every step below it, which is
   * exactly why it is here: if the columns hold a cover and the safe landing
   * does not, the SQL function is the answer and nothing further down needs
   * reading.
   */
  const stored = await query(
    `SELECT visibility, moderation_status, content_mode, share_media_status,
            avatar_path, avatar_url, share_image_path, share_image_url
       FROM characters WHERE id=$1`,
    [id],
  ).catch(() => null);
  const row = stored?.rows[0] ?? null;

  /*
   * The same function the anonymous world calls, and the raw columns it
   * returned. A database that has not had 0039 applied shows up here as
   * `present: false` on every `open_` column rather than as a puzzle.
   */
  const landingRow = await query("SELECT * FROM public_creation_safe_landing($1)", [id])
    .then((result) => result.rows[0] ?? null)
    .catch((error: unknown) => ({ __error: error instanceof Error ? error.message : "query failed" }));
  const sqlError = landingRow && "__error" in landingRow ? String(landingRow.__error) : "";
  const landingColumns = landingRow && !sqlError ? landingRow as Record<string, unknown> : null;

  const landing = await publicSafeLanding(id).catch(() => null);
  const card = landing ? ogCardModel(landing) : null;
  const [artwork, avatar] = await Promise.all([
    loadCardArtwork(card?.artwork ?? ""),
    loadCardArtwork(card?.creatorAvatar ?? ""),
  ]);

  return Response.json({
    id,
    // Whether `avatarSource` can build a URL at all. A deployment missing this
    // produces empty artwork for every creation, with no other symptom.
    storageConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    row: row ? {
      visibility: String(row.visibility || ""),
      moderationStatus: String(row.moderation_status || ""),
      contentMode: String(row.content_mode || ""),
      shareMediaStatus: String(row.share_media_status || ""),
      avatarPath: String(row.avatar_path || ""),
      avatarUrl: String(row.avatar_url || ""),
      shareImagePath: String(row.share_image_path || ""),
      shareImageUrl: String(row.share_image_url || ""),
    } : null,
    safeLandingSql: sqlError ? { error: sqlError } : landingColumns ? {
      openShareImagePath: present(landingColumns, "open_share_image_path"),
      openShareImageUrl: present(landingColumns, "open_share_image_url"),
      openAvatarPath: present(landingColumns, "open_avatar_path"),
      openAvatarUrl: present(landingColumns, "open_avatar_url"),
      creatorAvatarPath: present(landingColumns, "creator_avatar_path"),
      artPresentation: { present: "art_presentation" in landingColumns },
    } : null,
    viewModel: landing ? {
      contentMode: landing.contentMode,
      // The two doors, reported separately: `share` is the classified one an
      // adult-focused creation has, `openArt` the already-public one it does
      // not. A gated creation SHOULD read fallback/{} here.
      classifiedShare: landing.share.kind,
      openArt: {
        kind: landing.openArt.media.kind,
        isCover: landing.openArt.isCover,
        framed: Object.keys(landing.openArt.presentation).length > 0,
      },
      creatorAvatarPath: landing.creator.avatarPath,
    } : null,
    cardModel: card ? {
      // The URL is a public storage address for a public creation, and it is
      // the value a moderator needs to open in a browser to see the same thing
      // the renderer saw.
      artwork: card.artwork,
      artworkPosition: card.artworkPosition,
      creatorAvatar: card.creatorAvatar,
      adult: card.adult,
    } : null,
    // The step that was missing, and the one that answers the question.
    render: { artwork: artworkReport(artwork), creatorAvatar: artworkReport(avatar) },
  });
}
