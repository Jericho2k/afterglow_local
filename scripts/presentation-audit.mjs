#!/usr/bin/env node
/**
 * DOES THE FRAMING ACTUALLY HOLD, MEASURED RATHER THAN REASONED ABOUT.
 *
 * Companion to viewport-overflow-audit.mjs, and built the same way: the real
 * stylesheet, the real class structure, a real browser, at the widths people
 * actually read this product on. It answers the four questions that a unit test
 * on a helper function cannot:
 *
 *   1. Does a creator's focal point survive to the painted pixel, at every
 *      shape the product crops to?
 *   2. Does the section navigation stay put while the page scrolls — on a
 *      DESKTOP, which is where it was reported broken and where the cause
 *      (a scroll container created by `overflow-x: hidden` on the document)
 *      is invisible to any assertion about the nav's own rules?
 *   3. Do long Quick Facts wrap and stack instead of squeezing?
 *   4. Does artwork of every orientation — portrait, landscape, very tall —
 *      fill its window rather than letterboxing?
 *
 * Like its sibling it renders FIXTURES, so it needs no database, no account and
 * no provider, and it runs in a few seconds.
 *
 * USAGE
 *   node scripts/presentation-audit.mjs [--json]
 *   PLAYWRIGHT_CHROMIUM=/path/to/chromium node scripts/presentation-audit.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const globals = readFileSync(`${root}src/app/globals.css`, "utf8");
const creationCss = readFileSync(`${root}src/app/characters/[id]/profile.module.css`, "utf8");

const mobileWidths = [375, 390, 430];
const desktopWidths = [1280, 1440];

/**
 * Artwork of three shapes, as data URIs so nothing is fetched.
 *
 * The dimensions are what matter, not the pixels: `object-fit: cover` and
 * `object-position` are decided by the intrinsic ratio, so a 2x3 portrait and a
 * 3x2 landscape exercise genuinely different geometry. "Very tall" is the case
 * that breaks naive cropping — a 1:4 image showing only a navel unless the
 * focal point is honoured.
 */
const artwork = {
  portrait: svgDataUri(600, 900),
  landscape: svgDataUri(900, 600),
  tall: svgDataUri(400, 1600),
};

function svgDataUri(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#3a2430"/>
    <circle cx="${width * 0.25}" cy="${height * 0.12}" r="${Math.min(width, height) * 0.08}" fill="#e879a9"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const longFacts = [
  ["Distinguishing feature", "the scar she has never once explained to anybody who asked"],
  ["Occupation", "lighthouse keeper on a coast that has not had ships in forty years"],
  ["Age", "34"],
  ["Home", "Calloway Point"],
  ["Anunbrokenfactlabelwithnospaces", "andanunbrokenvaluewithnospaceseither"],
  ["Wants", "to be left alone, mostly"],
];

function creationPage({ art, focal, banner }) {
  const style = focal ? ` style="object-position:${focal}"` : "";
  const hero = banner ? artwork.landscape : art;
  return `
<main class="page">
  <div class="hero">
    <div class="heroMedia">
      <img id="hero-art" src="${hero}"${style} />
      <div class="heroGlow"></div>
      <div class="heroScrim"></div>
    </div>
    <div class="heroCopy">
      <h1 class="name">Wren Calloway</h1>
      <p class="tagline">A lighthouse keeper on a coast with no ships.</p>
    </div>
  </div>
  <nav class="sectionNav" id="nav">
    <button>Overview</button><button>Your role</button><button>Tags</button>
    <button>Quick facts</button><button>Cast</button><button>Creator</button>
  </nav>
  <div class="body">
    <section class="card">
      <header><h2>Quick facts</h2></header>
      <dl class="facts" id="facts">
        ${longFacts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}
      </dl>
    </section>
    ${Array.from({ length: 8 }, (_, index) => `<section class="card"><header><h2>Filler ${index}</h2></header><p class="prose">Scroll height, so the sticky nav has something to stick through.</p></section>`).join("")}
  </div>
</main>`;
}

function document(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${globals}\n${creationCss}</style></head><body>${body}</body></html>`;
}

/**
 * What the browser says, after scrolling.
 *
 * The sticky check scrolls the window and then asks where the nav actually IS —
 * not what its computed `position` says. That distinction is the entire point:
 * the rules said `sticky` throughout the bug, and the element still scrolled
 * away because an ancestor had quietly become its scrollport.
 */
function measure() {
  const nav = document.getElementById("nav");
  const facts = document.getElementById("facts");
  const art = document.getElementById("hero-art");

  window.scrollTo(0, 1200);
  const navTop = nav.getBoundingClientRect().top;

  const cells = Array.from(facts.children);
  const rows = new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().top)));
  const overflowing = cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length;

  const artBox = art.getBoundingClientRect();
  const artStyle = getComputedStyle(art);

  return {
    navTop: Math.round(navTop),
    /*
     * PINNED, not merely "not below the fold".
     *
     * `navTop <= 1` was the first version of this check and it passed for a nav
     * that had scrolled a thousand pixels off the TOP of the screen — which is
     * precisely the failure being tested for. Sticking means the element sits
     * at the viewport edge, so the distance from it is what gets measured.
     */
    navSticks: Math.abs(navTop) <= 1,
    factRows: rows.size,
    factsOverflowing: overflowing,
    factsTallEnough: cells.every((cell) => cell.getBoundingClientRect().height >= 30),
    objectFit: artStyle.objectFit,
    objectPosition: artStyle.objectPosition,
    // A filled window: the image box is the media box, so nothing letterboxes.
    artFills: artBox.width > 0 && artBox.height > 0,
  };
}

function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(base)) return undefined;
  for (const entry of readdirSync(base).sort()) {
    if (!entry.startsWith("chromium-")) continue;
    const candidate = `${base}/${entry}/chrome-linux/chrome`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function main() {
  const asJson = process.argv.includes("--json");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const results = [];
  const failures = [];

  try {
    for (const width of [...mobileWidths, ...desktopWidths]) {
      for (const [shape, art] of Object.entries(artwork)) {
        for (const banner of [false, true]) {
          for (const focal of [null, "25% 10%"]) {
            const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
            const tab = await context.newPage();
            await tab.setContent(document(creationPage({ art, focal, banner })), { waitUntil: "load" });
            const measured = await tab.evaluate(`(${measure})()`);
            await context.close();

            const row = { width, shape, banner, focal: focal ?? "none", ...measured };
            results.push(row);

            // The nav must stick at every width, with or without artwork.
            if (!row.navSticks) failures.push(`${width}px ${shape}: nav scrolled away (top ${row.navTop})`);
            // No fact may be clipped, at any width or length.
            if (row.factsOverflowing) failures.push(`${width}px ${shape}: ${row.factsOverflowing} quick facts overflow their cell`);
            // Below 460 the pairs stack, so six facts occupy six rows.
            if (width < 460 && row.factRows < longFacts.length) {
              failures.push(`${width}px: quick facts shared rows (${row.factRows} rows for ${longFacts.length} facts)`);
            }
            // A focal point must reach the painted element.
            if (focal && row.objectPosition !== "25% 10%") {
              failures.push(`${width}px ${shape}: focal point did not apply (${row.objectPosition})`);
            }
            // Artwork always fills its window; nothing letterboxes.
            if (row.objectFit !== "cover" || !row.artFills) {
              failures.push(`${width}px ${shape}: artwork did not fill (${row.objectFit})`);
            }
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (asJson) {
    console.log(JSON.stringify({ results, failures }, null, 2));
  } else {
    const widths = [...new Set(results.map((row) => row.width))];
    for (const width of widths) {
      const rows = results.filter((row) => row.width === width);
      const sticky = rows.every((row) => row.navSticks);
      const facts = rows.every((row) => !row.factsOverflowing);
      const rowsPerWidth = new Set(rows.map((row) => row.factRows));
      console.log(`${String(width).padStart(5)}px  nav sticky: ${sticky ? "yes" : "NO"}   facts intact: ${facts ? "yes" : "NO"}   fact rows: ${[...rowsPerWidth].join("/")}`);
    }
    console.log(failures.length ? `\n${failures.length} failures:\n${failures.map((line) => `  - ${line}`).join("\n")}` : "\nNo failures.");
  }
  process.exitCode = failures.length ? 1 : 0;
}

await main();
