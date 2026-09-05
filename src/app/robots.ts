import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site";

/**
 * What a crawler may walk.
 *
 * Public creation, world and creator pages are the whole of the crawlable
 * product; everything else either needs an account (and would answer with a
 * sign-in), belongs to one account (a story, a draft, the studio), or is an
 * endpoint rather than a page. Disallowing those is not a security measure —
 * authentication is — it is what keeps a crawl budget on the pages that can
 * actually bring somebody here.
 *
 * The shell's surfaces are query strings on `/` rather than paths, so they are
 * excluded as query prefixes; `/` itself stays allowed because the rule that
 * matches most of a URL wins. The editor and the cast pages under a creation
 * are paths, and are excluded as paths.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/", "/?view=", "/?chat=", "/?command=", "/characters/*/edit"],
    }],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: absoluteUrl("/"),
  };
}
