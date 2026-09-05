/**
 * The handful of links a creator may put on their profile.
 *
 * Creators arrive with an audience somewhere else, and a profile with nowhere
 * to point makes them choose between the two. What makes this safe rather than
 * a link farm is that both halves are bounded: how many links there may be, and
 * what a link is allowed to be.
 *
 * The protocol rule is the one that matters. An anchor's `href` is executed by
 * the browser, so `javascript:` and `data:` URLs are script delivery on a page
 * anybody can open, including a logged-out stranger who arrived from a search
 * result. Only `http` and `https` are ever stored, checked with the URL parser
 * rather than a regular expression — a parser agrees with the browser about
 * what a URL is, and a pattern only agrees with its author.
 */

export type CreatorLink = { label: string; url: string };

export const maxCreatorLinks = 6;
export const maxCreatorLinkLabel = 40;
export const maxCreatorLinkUrl = 300;

/** Protocols an anchor may carry. Everything else is refused, not rewritten. */
const allowedProtocols = new Set(["http:", "https:"]);

/**
 * One link, validated, or null.
 *
 * A bare `example.com/me` is upgraded to `https://` rather than rejected,
 * because that is what a creator types and refusing it teaches nothing. A
 * `javascript:` URL is never repaired into anything — there is no benign
 * reading of it here.
 */
export function creatorLink(value: unknown): CreatorLink | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const raw = String(entry.url ?? "").trim();
  if (!raw || raw.length > maxCreatorLinkUrl) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { return null; }
  if (!allowedProtocols.has(parsed.protocol)) return null;
  // A URL with no host is not a link to anywhere — `https:///path` parses.
  if (!parsed.hostname || !parsed.hostname.includes(".")) return null;

  const label = String(entry.label ?? "").trim().slice(0, maxCreatorLinkLabel);
  return {
    // An unlabelled link shows its host, which is more useful than "Link" and
    // is the thing a reader is actually deciding whether to click.
    label: label || parsed.hostname.replace(/^www\./, ""),
    url: parsed.toString(),
  };
}

/** A stored or submitted list, validated and bounded. */
export function creatorLinks(value: unknown): CreatorLink[] {
  if (!Array.isArray(value)) return [];
  const links: CreatorLink[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const link = creatorLink(entry);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    links.push(link);
    if (links.length >= maxCreatorLinks) break;
  }
  return links;
}

/**
 * What a rendered anchor must carry.
 *
 * `noopener` denies the opened tab a handle on this one; `noreferrer` keeps a
 * creator's audience from telling a third party which Afterglow page sent
 * them; `nofollow` and `ugc` say what the link is — somebody else's URL on a
 * page they control the contents of — so the platform is not lending its
 * ranking to whatever a profile points at.
 */
export const creatorLinkRel = "nofollow noopener noreferrer ugc";

/** The host, for display. Never the full URL, which is unbounded. */
export function creatorLinkHost(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
