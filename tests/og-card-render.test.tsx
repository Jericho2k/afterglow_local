import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultArtworkPosition } from "@/lib/og-card";
import { ogCardElement, ogCardHeight, ogCardWidth } from "@/lib/og-card-render";
import type { OgCardModel } from "@/lib/og-card";

/**
 * The card actually rasters, and is worth looking at when it does.
 *
 * Satori is not a browser: it supports a subset of CSS, it needs `display:
 * flex` on every container with more than one child, and it throws on the rest
 * rather than ignoring it. A composition that is wrong in one of those ways
 * fails at render time, in production, on somebody else's shared link — and the
 * route's own fallback would quietly serve an SVG for every creation while
 * looking healthy. So each shape the model can take is rendered here, at the
 * real size, and the bytes are checked for being a PNG.
 *
 * The second job is judgement, which no assertion makes. Set
 * `OG_CARD_PREVIEW_DIR` and every shape below is written out at 1200×630 AND at
 * 400×210 — roughly what Discord and Telegram paint — so the card can be looked
 * at as a reader sees it rather than reasoned about:
 *
 *   OG_CARD_PREVIEW_DIR=/tmp/og npx vitest run tests/og-card-render.test.tsx
 *
 * The thumbnail is the same PNG painted small, which is what those clients do,
 * rather than a second composition at a smaller size.
 */

const previewDir = process.env.OG_CARD_PREVIEW_DIR || "";

/** Inline artwork, so a render makes no network request of its own. */
function svg(markup: string) {
  return `data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}`;
}

// A portrait character sheet — the commonest upload, and the shape a centred
// crop turns into a torso. The head sits at roughly 45% across, 22% down.
const portrait = svg(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a1230"/><stop offset="1" stop-color="#0d0410"/></linearGradient></defs>
  <rect width="900" height="1200" fill="url(#g)"/>
  <circle cx="405" cy="264" r="130" fill="#e8b6a0"/>
  <rect x="285" y="400" width="240" height="500" rx="60" fill="#8a3f6a"/>
  <circle cx="700" cy="900" r="90" fill="#2a5f7a" opacity="0.7"/>
</svg>`);

// Wide key art, which needs no crop vertically and every crop horizontally.
const landscape = svg(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
  <defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#123a52"/><stop offset="1" stop-color="#07131c"/></linearGradient></defs>
  <rect width="1600" height="900" fill="url(#h)"/>
  <circle cx="1120" cy="250" r="150" fill="#6fd0e8" opacity="0.5"/>
  <polygon points="200,860 520,220 840,860" fill="#1d5f77"/>
  <polygon points="620,860 940,380 1260,860" fill="#2a7f9b"/>
</svg>`);

/*
 * A near-white upload, which is the case the scrim is FOR.
 *
 * A dark card over a dark photograph is easy. The card that decides how heavy
 * the treatment has to be is this one: pale, high-key artwork under a tagline
 * drawn in the faintest colour on the composition.
 */
const bright = svg(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">
  <rect width="1000" height="1000" fill="#f4ece0"/>
  <circle cx="450" cy="260" r="150" fill="#e0a070"/>
  <rect x="300" y="430" width="300" height="500" rx="70" fill="#cfd8e8"/>
  <circle cx="820" cy="180" r="110" fill="#ffd9a0"/>
</svg>`);

const avatar = svg(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <rect width="256" height="256" fill="#20101c"/>
  <circle cx="128" cy="104" r="58" fill="#f0cba8"/>
  <path d="M20 256 C40 170 216 170 236 256 Z" fill="#c56aa0"/>
</svg>`);

const base: OgCardModel = {
  title: "Aethelgard Online",
  handle: "@santos",
  type: "Scenario",
  tagline: "A full-dive VRMMORPG where logging out stopped working three days ago.",
  artwork: "",
  artworkPosition: defaultArtworkPosition,
  accent: "#e879a9",
  adult: false,
  creatorAvatar: avatar,
};

const shapes: Record<string, OgCardModel> = {
  // The four the release is judged on.
  "clean-portrait-artwork": { ...base, artwork: portrait, artworkPosition: "45% 22%" },
  "clean-landscape-artwork": {
    ...base, artwork: landscape, artworkPosition: "38% 30%", accent: "#66ccff",
    title: "The Ninth Expedition", type: "Cast", handle: "@marlow",
    tagline: "Six strangers, one ridge, and a season that will not hold.",
  },
  "adult-focused-without-approved-art": {
    ...base, artwork: "", adult: true, accent: "#c2185b",
    title: "18+ creation by @vale", handle: "@vale", type: "Character",
    tagline: "A slow, deliberate story for readers who already know what they want.",
  },
  "no-creator-picture": { ...base, artwork: portrait, artworkPosition: "45% 22%", creatorAvatar: "" },
  // And the ones that break a composition rather than illustrate it.
  "bright-artwork": { ...base, artwork: bright, artworkPosition: "45% 26%" },
  "unframed-artwork": { ...base, artwork: portrait },
  // No handle, no tagline, no avatar: the sparsest card the model can produce,
  // and the one most likely to leave an empty flex child behind.
  "bare-minimum": { ...base, handle: "", tagline: "", title: "Untitled creation", creatorAvatar: "" },
};

describe("every shape of card renders", () => {
  for (const [name, card] of Object.entries(shapes)) {
    it(`rasters the ${name.replace(/-/g, " ")}`, async () => {
      const { ImageResponse } = await import("next/og");
      const response = new ImageResponse(ogCardElement(card), { width: ogCardWidth, height: ogCardHeight });
      const bytes = Buffer.from(await response.arrayBuffer());
      // PNG magic. A thrown Satori error would never reach this line.
      expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(bytes.byteLength).toBeGreaterThan(2_000);

      if (!previewDir) return;
      mkdirSync(previewDir, { recursive: true });
      writeFileSync(`${previewDir}/${name}.png`, bytes);
      const thumbnail = new ImageResponse(
        <div style={{ display: "flex", width: 400, height: 210 }}>
          <img src={`data:image/png;base64,${bytes.toString("base64")}`} alt="" width={400} height={210} />
        </div>,
        { width: 400, height: 210 },
      );
      writeFileSync(`${previewDir}/${name}-thumbnail.png`, Buffer.from(await thumbnail.arrayBuffer()));
    }, 30_000);
  }
});
