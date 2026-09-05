import type { MetadataRoute } from "next";
import { publicSitemapEntries } from "@/lib/public-view";
import { absoluteUrl } from "@/lib/site";

/**
 * The catalogue, offered to search engines.
 *
 * Every entry here is a page an anonymous visitor can actually read: the SQL
 * behind `publicSitemapEntries` excludes anything private, unlisted, removed
 * or adult-focused. Submitting a URL that answers with a gate teaches a
 * crawler to distrust the rest of the file, so the two rules — what is
 * readable and what is listed — are the same rule, stated once, in the
 * database.
 *
 * A database that has not applied 0026 has none of those functions, so the
 * failure path returns the static pages alone rather than a 500: a deployment
 * mid-migration should serve a small sitemap, not a broken one.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const roots: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), changeFrequency: "daily", priority: 1 },
  ];
  const entries = await publicSitemapEntries().catch(() => []);
  return roots.concat(entries.map((entry) => {
    const path = entry.kind === "creation" ? `/characters/${entry.slug}`
      : entry.kind === "world" ? `/worlds/${entry.slug}`
      : `/creators/${encodeURIComponent(entry.slug)}`;
    return {
      url: absoluteUrl(path),
      lastModified: new Date(entry.updatedAt),
      changeFrequency: entry.kind === "creator" ? "weekly" as const : "daily" as const,
      priority: entry.kind === "creation" ? 0.8 : 0.6,
    };
  }));
}
