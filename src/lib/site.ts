import { avatarSource } from "./storage";
import type { ShareMedia } from "./content-mode";

/**
 * Where this deployment lives, as an absolute origin.
 *
 * Canonical URLs, sitemap entries and link previews all need one, and none of
 * them can be built from a relative path: a crawler resolving a preview image
 * has no page context to resolve it against. Railway and Vercel both publish
 * their own hostname, so a correct default exists on both without the operator
 * setting anything; `NEXT_PUBLIC_SITE_URL` overrides for a custom domain,
 * which is the case that matters once a deployment has one.
 */
export function siteOrigin() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
    || process.env.RAILWAY_PUBLIC_DOMAIN
    || process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL;
  if (!configured) return "http://localhost:3000";
  const trimmed = configured.trim().replace(/\/$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function absoluteUrl(path: string) {
  return `${siteOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The image a link preview should load.
 *
 * `shareMedia` has already decided WHETHER there is one; this turns that
 * decision into a URL, and turns "no" into the branded card rather than into a
 * missing image. The fallback is a real route so that a preview always has
 * something to show — an embed with a broken image reads as a broken product,
 * and the whole point of the fallback is that a creation with nothing nominated
 * still shares cleanly.
 */
export function shareImageUrl(media: ShareMedia, bucket: string, accent?: string) {
  if (media.kind === "storage") {
    const resolved = avatarSource(bucket, media.path, "");
    if (resolved) return resolved;
  }
  if (media.kind === "external" && media.url) return media.url;
  const accentParam = accent && /^#[0-9a-f]{3,8}$/i.test(accent) ? `?accent=${encodeURIComponent(accent)}` : "";
  return absoluteUrl(`/api/og/card${accentParam}`);
}

/** One line of prose for a page description, collapsed and bounded. */
export function metaDescription(...parts: (string | undefined)[]) {
  const text = parts.map((part) => (part || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" — ");
  if (text.length <= 160) return text;
  return `${text.slice(0, 157).trimEnd()}…`;
}
