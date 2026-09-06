import type { ContentMode } from "./types";

/**
 * What a creation is about, and what it may show a stranger.
 *
 * These are two questions, and the product used to answer both with one
 * boolean. `nsfwEnabled` meant "this story may become explicit", and because it
 * was the only signal available it also became the answer to "may a logged-out
 * visitor see this page?" and "may this image be a link preview?" — questions
 * it was never asked and cannot answer well.
 *
 * The cost of conflating them is not theoretical. A romance that stays clean
 * unless its reader steers otherwise gets treated exactly like a page that
 * exists to be pornographic: hidden behind a login wall, absent from search,
 * and unshareable. That is most of a catalogue made invisible to everyone who
 * has not signed up yet, in a product whose growth depends on the opposite.
 *
 * So classification splits three ways, and media authorisation is separate
 * again. See supabase/migrations/0026_public_content_modes.sql for the
 * database half; this module is the single place the rules are stated for the
 * application.
 */

export const contentModes = ["clean", "adult_capable", "adult_focused"] as const;

export function isContentMode(value: unknown): value is ContentMode {
  return typeof value === "string" && (contentModes as readonly string[]).includes(value);
}

/**
 * A stored value, made safe to reason about.
 *
 * Unknown modes resolve to the most restrictive one rather than the most
 * permissive. A row written by a future release this code does not understand
 * is gated, not published.
 */
export function contentMode(value: unknown): ContentMode {
  return isContentMode(value) ? value : "clean";
}

/**
 * The mode implied by the deprecated boolean, for input that predates modes.
 *
 * A ONE-TIME TRANSLATION, matching 0036's backfill, and not a live derivation:
 * `nsfw_enabled` is authoritative for nothing after that migration, and this
 * exists only for the two places genuinely handed a legacy value — a backup
 * exported before content modes, and a row read from a database mid-migration.
 * Its `true` lands on the restrictive end because a writer that knows nothing
 * about content modes cannot be claiming a creation is merely adult-capable.
 */
export function contentModeFromLegacyFlag(nsfwEnabled: boolean): ContentMode {
  return nsfwEnabled ? "adult_focused" : "clean";
}

/**
 * Whether the CREATION is capable of explicit roleplay.
 *
 * A capability, not a permission. True for both adult modes, and never enough
 * on its own to decide what a writer may produce — see
 * `explicitRoleplayAllowed`, which is the rule prompt construction must use.
 */
export function allowsExplicitRoleplay(mode: ContentMode) {
  return mode !== "clean";
}

/**
 * What the READER has established about themselves.
 *
 * Two facts, deliberately not one. Confirming your age is an identity
 * statement made once; wanting explicit content is a preference that can be
 * changed and that most readers of an adult-capable story have not made.
 * Collapsing them would mean a reader who confirmed they were 18 in order to
 * open one creation found every other story willing to go explicit at them.
 */
export type ReaderAdultState = {
  /** `profiles.adult_confirmed_at` is set. */
  confirmedAdult: boolean;
  /** `user_settings.adult_content_enabled` is on. */
  adultContentEnabled: boolean;
};

/**
 * Whether explicit content may actually be written in THIS story, for THIS
 * reader. The single runtime rule, and the only thing prompt construction may
 * ask.
 *
 * Three facts have to agree, and the reason each is here is different:
 *
 *   * the creation is capable of it — a clean creation never becomes explicit,
 *     whatever the reader has enabled;
 *   * the reader has confirmed they are 18 or over — an age statement, not a
 *     preference, and not something a creation can supply on their behalf;
 *   * the reader has asked for explicit content — so an adult-capable story
 *     stays clean for somebody who merely confirmed their age to read a gated
 *     page once.
 *
 * This is why `nsfw_enabled` cannot come back. That column can express the
 * first fact and neither of the other two, so any code path that reaches for
 * it is a path where a reader's own state has silently stopped mattering.
 */
export function explicitRoleplayAllowed(mode: ContentMode, reader: ReaderAdultState) {
  return allowsExplicitRoleplay(mode) && reader.confirmedAdult && reader.adultContentEnabled;
}

/**
 * Whether this creation presents as 18+.
 *
 * The other question, and the one every badge, discovery filter and anonymous
 * gate asks. True only for adult_focused: a story that may go explicit if its
 * reader steers there is not an 18+ page, and treating it as one is the
 * conflation this module exists to end.
 */
export function presentsAsAdult(mode: ContentMode) {
  return mode === "adult_focused";
}

/**
 * Whether a logged-out visitor may read the whole page.
 *
 * Adult capability alone does not close a page. The gate is for creations
 * whose SUBJECT is adult, because that is what a stranger arriving from a
 * search result or a pasted link has not consented to see. What they may see
 * of an adult-focused creation is its card — a name, a tagline, share-safe
 * media — and an invitation to sign in and confirm their age.
 */
export function readableWithoutAccount(mode: ContentMode) {
  return !presentsAsAdult(mode);
}

/**
 * The same question for a world, which may not have been asked yet.
 *
 * A world carries no legacy flag to translate, so `null` means its creator has
 * never classified it — and an unclassified world stays out of the anonymous
 * path entirely rather than being guessed at from the creations attached to
 * it. Those come and go without its creator's involvement, and a public
 * standing that changes when somebody else attaches something is not one
 * anybody could reason about.
 */
export function worldReadableWithoutAccount(mode: ContentMode | null | undefined): mode is ContentMode {
  return mode != null && readableWithoutAccount(mode);
}

/**
 * Whether a search engine should be invited to index the full page.
 *
 * An adult-focused gate is deliberately NOT indexed. It may still produce a
 * correct link preview when somebody shares it — that is what the safe landing
 * model is for — but inviting a crawler to keep it is a separate decision, and
 * the conservative answer is the one to start from while the catalogue is
 * small enough that a mistake defines the domain.
 */
export function indexableWithoutAccount(mode: ContentMode) {
  return readableWithoutAccount(mode);
}

/**
 * Whether the full creation — its page and its chat — needs a confirmed adult
 * before it opens at all.
 *
 * Only adult_focused. An adult-capable creation opens for anybody, including a
 * reader who has confirmed nothing and a visitor with no account; what their
 * state changes is whether the writing may become explicit, which is
 * `explicitRoleplayAllowed`, not whether they may read the page. Making this
 * true for adult_capable would put the whole middle mode back behind the wall
 * and undo the distinction.
 */
export function requiresAdultConfirmation(mode: ContentMode) {
  return presentsAsAdult(mode);
}

export const contentModeLabels: Record<ContentMode, string> = {
  clean: "Clean",
  adult_capable: "Adult-capable",
  adult_focused: "Adult-focused · 18+",
};

/**
 * The badge a card shows, which only adult_focused has.
 *
 * Adult-capable deliberately carries NONE. A badge reading "18+ capable" was
 * still an 18+ badge to everybody who saw it — the same treatment, the same
 * chilling effect on who opens the page — which is the presentation this mode
 * exists to avoid. What an adult-capable creation says about itself is said in
 * prose on its own page, where there is room to say it accurately.
 */
export function contentModeBadge(mode: ContentMode) {
  return presentsAsAdult(mode) ? "18+" : "";
}

export const contentModeDescriptions: Record<ContentMode, string> = {
  clean: "No explicit sexual roleplay. Anyone can read this page, including people who are not signed in.",
  adult_capable:
    "Not primarily adult, but consensual explicit roleplay between fictional adults may happen if a reader steers the story there. The page stays publicly readable; the chat asks readers to confirm they are 18 or over.",
  adult_focused:
    "Adult content is the point of this creation. The full page and the chat are for signed-in readers who have confirmed they are 18 or over. A safe preview still appears in search results and shared links.",
};

/**
 * What a creator is told, in plain words, before they publish.
 *
 * Written to be read by somebody deciding, not to satisfy a lawyer: the
 * consequence of each choice is stated as the thing that will actually happen
 * to their work.
 */
export function publicVisibilityNotice(mode: ContentMode) {
  return readableWithoutAccount(mode)
    ? "Published publicly, this page can be read without an account and may appear in search engines and in link previews when someone shares it."
    : "Published publicly, only a safe preview — the title, the tagline and your share image — is visible without an account. The full page and the chat need a signed-in reader who has confirmed they are 18 or over.";
}

/**
 * The image an external preview may use.
 *
 * The rule is nomination, not inspection. Software cannot look at a picture and
 * decide whether it belongs in a Discord embed on somebody's work machine, and
 * "contains no nudity" is not the same question as "is suitable as an
 * unrestricted preview of an erotic story". So an image becomes a preview by
 * being chosen for that purpose — either as a dedicated share image, or by the
 * creator marking the cover share-safe — and everything else falls back to a
 * branded card that gives away nothing.
 *
 * Gallery images are never eligible, in any mode. They are inside the page.
 */
export const shareMediaStatuses = ["unreviewed", "safe", "adult", "rejected"] as const;
export type ShareMediaStatus = (typeof shareMediaStatuses)[number];

export function shareMediaStatus(value: unknown): ShareMediaStatus {
  return typeof value === "string" && (shareMediaStatuses as readonly string[]).includes(value)
    ? value as ShareMediaStatus
    // Anything unrecognised is unreviewed, never safe. A status this code does
    // not understand must not be the one that lets an image out.
    : "unreviewed";
}

export type ShareMediaSource = {
  shareImagePath?: string;
  shareImageUrl?: string;
  /** Platform classification. Only "safe" produces an image. */
  status?: ShareMediaStatus;
  avatarPath?: string;
  avatarUrl?: string;
};

export type ShareMedia =
  | { kind: "storage"; path: string }
  | { kind: "external"; url: string }
  | { kind: "fallback" };

/**
 * The image an external preview may use.
 *
 * The status is checked FIRST and once, before any candidate is considered, so
 * there is exactly one line in the product where an unreviewed image could
 * escape and it is this one. A creator nominating media does not change the
 * status — nomination is `share_image_*`, classification is
 * `share_media_status`, and only Afterglow writes the second.
 */
export function shareMedia(source: ShareMediaSource): ShareMedia {
  if (shareMediaStatus(source.status) !== "safe") return { kind: "fallback" };
  return nominatedMedia(source);
}

/**
 * WHICH image a creator has put forward, ignoring what the platform made of it.
 *
 * The order is the nomination itself: a dedicated share image wins, then a
 * share URL, and a creator who nominated neither has nominated their cover —
 * which is what makes "leave it alone" a working answer rather than a missing
 * one.
 *
 * Separated from `shareMedia` so the two questions stay apart. `shareMedia`
 * answers "may this leave Afterglow", and its answer is no for everything not
 * classified safe; this answers "what would be reviewed", which the review
 * queue and the studio both need to ask about an image that is not approved
 * yet — precisely the case where the first function returns nothing.
 */
export function nominatedMedia(source: ShareMediaSource): ShareMedia {
  const sharePath = (source.shareImagePath || "").trim();
  if (sharePath) return { kind: "storage", path: sharePath };
  const shareUrl = (source.shareImageUrl || "").trim();
  if (shareUrl) return { kind: "external", url: shareUrl };
  const avatarPath = (source.avatarPath || "").trim();
  if (avatarPath) return { kind: "storage", path: avatarPath };
  const avatarUrl = (source.avatarUrl || "").trim();
  if (avatarUrl) return { kind: "external", url: avatarUrl };
  return { kind: "fallback" };
}

/**
 * The nominated image as one comparable value.
 *
 * A classification approves AN IMAGE, not a creation — so the moment the
 * nominated image changes, the approval that was granted no longer describes
 * what would be published, and the status has to return to `unreviewed`. That
 * check needs a stable identity for "the image currently nominated", and this
 * is it: empty when nothing is nominated, and equal for two rows exactly when
 * they would publish the same file.
 *
 * The character update expresses the same collapse in SQL so the reset happens
 * inside the UPDATE rather than across a read and a write — see
 * `src/app/api/characters/[id]/route.ts`. Both orders are this one, and
 * tests/share-media-review.test.ts holds them together.
 */
export function shareMediaCandidate(source: ShareMediaSource) {
  const media = nominatedMedia(source);
  if (media.kind === "storage") return media.path;
  if (media.kind === "external") return media.url;
  return "";
}

/**
 * What a creator is told about the image they nominated.
 *
 * Written as a state of THEIR work rather than as a status code, because the
 * thing they need to know is what is happening on the outside of Afterglow
 * right now: an unreviewed image is not a failure and a rejected one is not a
 * punishment, but both mean shared links currently show the branded card.
 */
export const shareMediaStatusLabels: Record<ShareMediaStatus, string> = {
  unreviewed: "Waiting for review",
  safe: "Approved for link previews",
  adult: "Not used outside Afterglow",
  rejected: "Not approved",
};

export function shareMediaNotice(status: ShareMediaStatus) {
  if (status === "safe") return "Approved. Shared links and search results show this image on an Afterglow card.";
  if (status === "adult") return "Reviewed as adult. It stays on your page; shared links show an Afterglow card instead.";
  if (status === "rejected") return "Not approved for use outside Afterglow. It stays on your page; shared links show an Afterglow card.";
  return "Waiting for review. Until it is reviewed, shared links show an Afterglow card instead of your artwork.";
}

/**
 * The name a creation may be called OUTSIDE Afterglow.
 *
 * A title is page copy: it is written for somebody who has already chosen the
 * creation, and on an adult-focused one it is frequently the most explicit
 * string in the row. So a gated creation's real title never leaves — it is
 * `share_title` or neutral copy naming only the creator, and the fallback is
 * deliberately dull rather than descriptive.
 *
 * A creation that is readable without an account has no such problem: its
 * whole page is already public, so its own title is what a search result
 * should say.
 */
export function safeShareTitle(creation: {
  contentMode: ContentMode;
  shareTitle?: string;
  title?: string;
  name?: string;
  creatorUsername?: string;
}) {
  const nominated = (creation.shareTitle || "").trim();
  if (nominated) return nominated;
  if (readableWithoutAccount(creation.contentMode)) {
    return (creation.title || "").trim() || (creation.name || "").trim() || "Untitled creation";
  }
  const creator = (creation.creatorUsername || "").trim();
  return creator ? `18+ creation by @${creator}` : "18+ creation on Afterglow";
}
