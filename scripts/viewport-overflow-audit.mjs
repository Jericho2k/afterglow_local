#!/usr/bin/env node
/**
 * WHICH ELEMENT IS WIDER THAN THE PHONE, MEASURED RATHER THAN GUESSED.
 *
 * The report is "some chats are perfectly aligned, others are visibly stretched
 * to the right". That is a content-driven overflow, and the only honest way to
 * find one is to render the real markup with the real stylesheet and walk the
 * tree asking each element whether it is wider than the box it sits in. Reading
 * the CSS and reasoning about it is how the previous fix ended up capping the
 * title against the VIEWPORT instead of against its container, which is a cap
 * that is correct on most screens and wrong on the ones people reported.
 *
 * `overflow-x: hidden` is deliberately never applied anywhere in here. Hiding
 * the overflow would make this script pass and the product no better.
 *
 * USAGE
 *   node scripts/viewport-overflow-audit.mjs [--width 393] [--json]
 *
 * It needs a Chromium and `playwright-core`, neither of which is a dependency
 * of the app:
 *   npm i --no-save playwright-core
 *   PLAYWRIGHT_CHROMIUM=/path/to/chromium node scripts/viewport-overflow-audit.mjs
 *
 * It renders FIXTURES rather than the running app, so it needs no database, no
 * account and no provider. The fixtures are the exact class structure the
 * components emit; if a component's structure changes, the fixture has to
 * change with it, and that is the cost of a check that runs in five seconds.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const globals = readFileSync(`${root}src/app/globals.css`, "utf8");
/*
 * The creation page is a CSS module, so its class names are hashed at build
 * time. The FILE'S selectors are literal, though, and the fixture below uses
 * those literal names — so this measures the real rules against the real
 * structure without needing a build.
 */
const creationCss = readFileSync(`${root}src/app/characters/[id]/profile.module.css`, "utf8");

const widths = [375, 390, 393, 430, 768, 1024, 1280, 1440];

/** Titles chosen to break different things: length, no break opportunity, script. */
const titles = {
  short: "Maya",
  long: "Maya Vance and the Cartographers of the Drowned Coast",
  unbroken: "Mayavanceandthecartographersofthedrownedcoastwhoneverstopwalking",
  cyrillic: "Мая Вэнс и картографы затонувшего побережья, которые никогда не останавливаются",
  emoji: "🌙✨ Maya Vance ✨🌙 — Cartographer of the Drowned Coast 🗺️🌊🏚️🕯️",
  descenders: "Peggy Jaggy Gypsy Quaggy Jyggy",
};

function chatShell(title) {
  return `
<div class="app-shell">
  <aside class="sidebar"></aside>
  <section class="chat-panel">
    <header class="chat-header">
      <div class="chat-identity">
        <button class="icon-button chat-menu-button"><span>≡</span></button>
        <button class="identity-profile">
          <span class="avatar large"><span>M</span></span>
          <span>
            <span class="eyebrow conversation-preview">${title}</span>
            <strong>${title}</strong>
            <small>Chatting as You</small>
          </span>
        </button>
      </div>
      <div class="header-actions">
        <button class="icon-button labeled"><span>◧</span><span>Story</span></button>
        <button class="icon-button labeled"><span>◨</span><span>Memories</span><b>12</b></button>
        <button class="icon-button labeled"><span>◩</span><span>Edit</span></button>
      </div>
    </header>
    <div class="messages">
      <div class="message"><div class="message-stack"><div class="bubble">${title} ${title}</div></div></div>
      <div class="message user"><div class="message-stack"><div class="bubble">A reply with a verylongunbrokenwordthatcannotwrapanywhereatall in it.</div></div></div>
    </div>
    <div class="composer-wrap">
      <div class="composer"><textarea rows="1"></textarea><button class="send-button">↑</button></div>
    </div>
  </section>
</div>`;
}

/**
 * The creation page's cast section, and the fixed lower action bar with it —
 * the two things reported as escaping the right edge on a phone.
 */
function creationPage(title) {
  const member = (name, role, tagline) => `
    <li class="castCard">
      <a class="castLink" href="#">
        <span class="castAvatar">M</span>
        <span class="castCopy">
          <strong>${name}</strong>
          <small>${role}</small>
          <p>${tagline}</p>
        </span>
      </a>
    </li>`;
  return `
<main class="page">
  <div class="body">
    <section class="card">
      <header><h2>Cast</h2><em class="count">4</em></header>
      <ul class="castList">
        ${member(title, title, `${title} ${title}`)}
        ${member("Kel", "her brother", "A quiet cartographer with an unbroken habit of Averyveryverylongunbrokenwordindeed.")}
        ${member("Ферро", "архивариус побережья, который никогда не спит", "Хранитель карт затонувшего побережья и всех его историй.")}
        ${member("🌙 Lune 🌊", "🗺️ the tide-reader 🕯️", "🌊🌊🌊 Reads the tide and the stars, in that order. 🌙🌙🌙")}
      </ul>
    </section>
  </div>
  <div class="actionBar">
    <button class="primaryCta"><span>Continue Chat</span></button>
    <button class="ghostButton"><span class="ghostLabel">Save</span></button>
  </div>
</main>`;
}

const surfaces = {
  chat: (title) => `<style>${globals}</style><body class="shell-locked">${chatShell(title)}</body>`,
  creation: (title) => `<style>${globals}</style><style>${creationCss}</style><body>${creationPage(title)}</body>`,
};

const page = (surface, title) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
</head>${surfaces[surface](title)}</html>`;

/**
 * The FIRST element whose content is wider than its own box, in document order.
 *
 * First, not every one: an overflow propagates, so the deepest reported
 * offender is usually a symptom of an ancestor that could not shrink. Fixing a
 * descendant of the real cause is how this class of bug survives three sprints.
 */
const findOverflow = `() => {
  const offenders = [];
  const root = document.documentElement;
  const viewport = root.clientWidth;
  for (const node of document.querySelectorAll("html, body, .app-shell, .app-shell *, .page, .page *")) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const overflowsSelf = node.scrollWidth - node.clientWidth > 1 && style.overflowX === "visible";
    const rect = node.getBoundingClientRect();
    const past = rect.right - viewport > 1 || rect.left < -1;
    if (overflowsSelf || past) {
      offenders.push({
        selector: node.tagName.toLowerCase() + (node.className && typeof node.className === "string" ? "." + node.className.trim().split(/\\s+/).join(".") : ""),
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        right: Math.round(rect.right), left: Math.round(rect.left), viewport,
      });
    }
  }
  return { documentScrollWidth: root.scrollWidth, viewport, offenders: offenders.slice(0, 6) };
}`;

/**
 * Where the browser is.
 *
 * `PLAYWRIGHT_CHROMIUM` wins; otherwise the first Chromium under
 * `PLAYWRIGHT_BROWSERS_PATH` (or /opt/pw-browsers), which is where a
 * pre-provisioned image usually keeps one; otherwise playwright-core's own
 * default, which is what a laptop with `npx playwright install` will have.
 */
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
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const only = args.includes("--width") ? [Number(args[args.indexOf("--width") + 1])] : widths;
  const chosen = args.includes("--surface") ? [args[args.indexOf("--surface") + 1]] : Object.keys(surfaces);

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
  });
  const results = [];
  try {
    for (const surface of chosen) {
      for (const width of only) {
        for (const [label, title] of Object.entries(titles)) {
          const context = await browser.newContext({ viewport: { width, height: 780 }, deviceScaleFactor: 2 });
          const tab = await context.newPage();
          await tab.setContent(page(surface, title), { waitUntil: "load" });
          const measured = await tab.evaluate(`(${findOverflow})()`);
          results.push({ surface, width, title: label, ...measured });
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => result.offenders.length || result.documentScrollWidth > result.viewport + 1);
  if (asJson) { console.log(JSON.stringify({ results, failures }, null, 2)); }
  else {
    for (const result of results) {
      const status = result.offenders.length ? "OVERFLOW" : "ok";
      console.log(`${result.surface.padEnd(9)}${String(result.width).padStart(5)}  ${result.title.padEnd(12)}  doc=${String(result.documentScrollWidth).padStart(5)}  ${status}`);
      for (const offender of result.offenders) {
        console.log(`         ${offender.selector}  scrollWidth=${offender.scrollWidth} clientWidth=${offender.clientWidth} right=${offender.right}/${offender.viewport}`);
      }
    }
  }
  console.log(failures.length ? `\n${failures.length} of ${results.length} combinations overflow.` : `\nAll ${results.length} combinations fit.`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
