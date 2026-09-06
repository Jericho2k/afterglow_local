import { describe, expect, it } from "vitest";
import { ogCardElement, ogCardHeight, ogCardWidth } from "@/lib/og-card-render";
import type { OgCardModel } from "@/lib/og-card";

/**
 * The card actually rasters.
 *
 * Satori is not a browser: it supports a subset of CSS, it needs `display:
 * flex` on every container with more than one child, and it throws on the rest
 * rather than ignoring it. A composition that is wrong in one of those ways
 * fails at render time, in production, on somebody else's shared link — and the
 * route's own fallback would quietly serve an SVG for every creation while
 * looking healthy.
 *
 * So each shape the model can take is rendered here, at the real size, and the
 * bytes are checked for being a PNG. It is the cheapest possible guard against
 * the failure mode that has no other signal.
 */

const base: OgCardModel = {
  title: "Seraphine of the Long Quay",
  handle: "@alice",
  type: "Character",
  tagline: "A quiet, unhurried romance on a harbour that never sleeps.",
  artwork: "",
  accent: "#e879a9",
  adult: false,
  monogram: "S",
};

// An inline image, so the render makes no network request of its own.
const artwork = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="#c65a7a"/></svg>',
).toString("base64")}`;

const shapes: Record<string, OgCardModel> = {
  "approved artwork": { ...base, artwork },
  "branded fallback": { ...base, artwork: "", monogram: "S" },
  "gated creation": { ...base, title: "18+ creation by @vale", tagline: "", adult: true, monogram: "", accent: "#c2185b" },
  // No creator handle, no tagline, no monogram: the sparsest card the model can
  // produce, and the one most likely to leave an empty flex child behind.
  "bare minimum": { ...base, handle: "", tagline: "", monogram: "", title: "Untitled creation" },
};

describe("every shape of card renders", () => {
  for (const [name, card] of Object.entries(shapes)) {
    it(`rasters the ${name}`, async () => {
      const { ImageResponse } = await import("next/og");
      const response = new ImageResponse(ogCardElement(card), { width: ogCardWidth, height: ogCardHeight });
      const bytes = new Uint8Array(await response.arrayBuffer());
      // PNG magic. A thrown Satori error would never reach this line.
      expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(bytes.byteLength).toBeGreaterThan(2_000);
    }, 30_000);
  }
});
