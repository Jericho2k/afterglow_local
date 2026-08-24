import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorldCard, type WorldCardWorld } from "@/components/world";

/**
 * The world card.
 *
 * Worlds appear attached to a creation and on the Worlds page, and they are the
 * same thing in both places, so these assert that one component serves both and
 * that neither surface has quietly grown a second design. The fade is checked
 * against the stylesheet itself, because the bug it fixes was a gradient that
 * started around the middle of the artwork and dimmed it long before the text
 * needed it to.
 */

const world: WorldCardWorld = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  name: "Tower of Babel",
  description: "A city that climbed too far, and the languages it lost on the way up.",
  coverPath: "",
  coverUrl: "https://cdn.example/babel.png",
  content: "Long canon about the tower.",
};

const css = readFileSync(new URL("../src/components/world/world.module.css", import.meta.url), "utf8");

function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}
function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("presentation", () => {
  it("renders the cover, title and description as a media card", () => {
    const html = render(<WorldCard world={world} />);
    expect(html).toContain(`src="${world.coverUrl}"`);
    expect(text(html)).toContain("Tower of Babel");
    expect(text(html)).toContain("A city that climbed too far");
  });

  it("opens the world's own page", () => {
    const html = render(<WorldCard world={world} />);
    expect(html).toContain(`href="/worlds/${world.id}"`);
  });

  it("still renders a world with no cover art rather than an empty box", () => {
    const html = render(<WorldCard world={{ ...world, coverUrl: "", coverPath: "" }} />);
    expect(html).not.toContain("<img");
    expect(text(html)).toContain("Tower of Babel");
    // The fallback is a real element, so the card keeps its shape.
    expect(html).toContain("fallback");
  });

  it("renders a world with no description without leaving an empty paragraph", () => {
    const html = render(<WorldCard world={{ ...world, description: "" }} />);
    expect(text(html)).toBe("Tower of Babel");
  });

  it("shows the metadata the surface passes in", () => {
    const html = render(<WorldCard world={world} variant="feature" meta={<span>used by 3 creations</span>} />);
    expect(text(html)).toContain("used by 3 creations");
  });

  it("keeps an owner action out of the link, so opening and editing stay separate", () => {
    const html = render(<WorldCard world={world} variant="feature" action={<button>Edit</button>} />);
    const link = html.slice(html.indexOf("<a"), html.indexOf("</a>"));
    expect(link).not.toContain("<button");
    expect(text(html)).toContain("Edit");
  });
});

describe("one card, both surfaces", () => {
  it("differs between the attached and feature variants only by size", () => {
    const attached = render(<WorldCard world={world} variant="attached" />);
    const feature = render(<WorldCard world={world} variant="feature" />);
    for (const html of [attached, feature]) {
      expect(html).toContain(`href="/worlds/${world.id}"`);
      expect(text(html)).toContain("Tower of Babel");
      expect(html).toContain("scrim");
    }
    // The same structural classes, so the two surfaces cannot drift apart.
    const classes = (html: string) => Array.from(html.matchAll(/class="([^"]+)"/g)).map((match) => match[1]).join(" ");
    for (const shared of ["link", "media", "scrim", "copy", "name"]) {
      expect(classes(attached)).toContain(shared);
      expect(classes(feature)).toContain(shared);
    }
  });

  it("is the only world card implementation left in the app", () => {
    // The creation page used to carry its own markup and its own gradient.
    const creationPage = readFileSync(new URL("../src/app/characters/[id]/profile.tsx", import.meta.url), "utf8");
    const creationCss = readFileSync(new URL("../src/app/characters/[id]/profile.module.css", import.meta.url), "utf8");
    expect(creationPage).toContain("WorldCard");
    expect(creationCss).not.toContain(".worldScrim");
    expect(creationCss).not.toContain(".worldCard");

    // And so did the Worlds page, as generic document rows. It is now the
    // Worlds hub, which renders the same card on all three of its tabs.
    const hub = readFileSync(new URL("../src/components/worlds/WorldsHub.tsx", import.meta.url), "utf8");
    expect(hub).toContain("<WorldCard");
    const shell = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
    expect(shell).not.toContain("document-card\"><span className=\"document-icon\">▤</span>");
  });
});

describe("the fade", () => {
  /** Every colour stop in `.scrim`, as [alpha, position] pairs read from the CSS. */
  function stops() {
    const block = css.slice(css.indexOf(".scrim {"), css.indexOf("}", css.indexOf(".scrim {")));
    return Array.from(block.matchAll(/rgba\([^)]*?,\s*([\d.]+)\)\s+([\d.]+)%/g))
      .map(([, alpha, position]) => ({ alpha: Number(alpha), position: Number(position) }));
  }

  it("fades upward from the bottom of the artwork", () => {
    const block = css.slice(css.indexOf(".scrim {"), css.indexOf("}", css.indexOf(".scrim {")));
    expect(block).toContain("linear-gradient(to top");
    expect(stops().length).toBeGreaterThan(3);
  });

  it("is anchored to the text rather than to the card, so it cannot creep up the artwork", () => {
    // This is the whole fix. The old card faded a share of the image, so a tall
    // card was dimmed from around its middle. The fade now fills `.copy`, which
    // is only as tall as the text plus its run-up, at any card height.
    const markup = render(<WorldCard world={world} />);
    const copyAt = markup.indexOf("copy");
    expect(markup.indexOf("scrim")).toBeGreaterThan(copyAt);
    // The card's height lives on the link; the copy must stay content-sized, or
    // the fade would fill the card again.
    const copy = css.slice(css.indexOf(".copy {"), css.indexOf("}", css.indexOf(".copy {")));
    expect(copy).not.toContain("min-height");
    expect(css).toContain(".feature .link { min-height:");
    expect(css).toContain(".attached .link { min-height:");
    // And nothing paints a gradient across the whole card any more.
    const media = css.slice(css.indexOf(".media {"), css.indexOf("}", css.indexOf(".media {")));
    expect(media).not.toContain("gradient");
  });

  it("starts well above the title rather than at it, so there is a run-up", () => {
    const copy = css.slice(css.indexOf(".copy {"), css.indexOf("}", css.indexOf(".copy {")));
    const padding = copy.match(/padding:\s*(\d+)px/);
    expect(padding).not.toBeNull();
    // Enough room above the first line for the gradient to arrive gradually.
    expect(Number(padding![1])).toBeGreaterThanOrEqual(48);
  });

  it("is clear at the top of its band and strong behind the text", () => {
    const ordered = [...stops()].sort((a, b) => a.position - b.position);
    // Fully transparent where the band meets the artwork.
    expect(ordered[ordered.length - 1].position).toBe(100);
    expect(ordered[ordered.length - 1].alpha).toBe(0);
    // Dense where the title and description sit.
    expect(ordered[0].position).toBe(0);
    expect(ordered[0].alpha).toBeGreaterThanOrEqual(0.9);
    // And genuinely faint across the upper third of the band.
    for (const stop of ordered.filter((entry) => entry.position >= 78)) {
      expect(stop.alpha).toBeLessThanOrEqual(0.25);
    }
  });

  it("ramps rather than stepping, so there is no hard black edge", () => {
    const ordered = [...stops()].sort((a, b) => a.position - b.position);
    for (let index = 1; index < ordered.length; index += 1) {
      const drop = ordered[index - 1].alpha - ordered[index].alpha;
      // A single stop never removes more than a third of the darkening, which
      // is what would read as a visible boundary across the image.
      expect(drop).toBeLessThanOrEqual(0.34);
      expect(ordered[index].alpha).toBeLessThanOrEqual(ordered[index - 1].alpha);
    }
  });

  it("does not darken one side of the artwork", () => {
    const block = css.slice(css.indexOf(".scrim {"), css.indexOf("}", css.indexOf(".scrim {")));
    expect(block).not.toContain("to right");
    expect(block).not.toContain("to left");
  });

  it("overlays the artwork rather than altering the uploaded image", () => {
    // The fade is its own layer above the image; the image itself carries no
    // filter, so nothing that was uploaded is changed.
    expect(css).toContain(".scrim {");
    const mediaBlock = css.slice(css.indexOf(".media img"), css.indexOf("}", css.indexOf(".media img")));
    expect(mediaBlock).not.toContain("filter");
    expect(mediaBlock).toContain("object-fit: cover");
  });
});

describe("responsive and accessible", () => {
  it("sizes itself for phones first and grows on wider screens", () => {
    expect(css).toContain("@media (min-width: 560px)");
    // No fixed pixel width anywhere: the card fills whatever column holds it.
    expect(css).not.toMatch(/\.card\s*{[^}]*width:\s*\d+px/);
  });

  it("gives the whole card a visible keyboard focus state", () => {
    expect(css).toContain(".link:focus-visible");
    expect(css.slice(css.indexOf(".link:focus-visible"))).toContain("outline");
  });

  it("marks the cover as decorative, since the title already names the world", () => {
    expect(render(<WorldCard world={world} />)).toContain('alt=""');
  });

  it("honours a reduced-motion preference", () => {
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("the page is called Worlds", () => {
  const shell = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const hub = readFileSync(new URL("../src/components/worlds/WorldsHub.tsx", import.meta.url), "utf8");
  const worldPage = readFileSync(new URL("../src/app/worlds/[id]/profile.tsx", import.meta.url), "utf8");

  it("names the collection in the navigation and in its own heading", () => {
    expect(shell).toContain("<strong>Worlds</strong>");
    expect(hub).toContain(">Worlds</h1>");
    // The singular heading it replaced is gone from both.
    expect(shell).not.toContain("<strong>World</strong>");
    expect(hub).not.toContain(">World</h1>");
  });

  it("does not call it a library, lore or anything else", () => {
    for (const wrong of ["World Library", "World library", "Lore</h1>", "Worldbuilding"]) {
      expect(shell).not.toContain(wrong);
      expect(hub).not.toContain(wrong);
    }
  });

  it("sends a reader on a world page back to Worlds rather than to the app root", () => {
    expect(worldPage).toContain("backFallbacks.worlds");
    expect(worldPage).toContain("Return to Worlds");
    // No page composes its own Back route any more.
    expect(worldPage).not.toContain('href="/" className={styles.circleButton}');
  });

  it("leaves the database and the API named as they were", () => {
    // A user-facing rename only: the endpoints existing clients call are
    // untouched, and so is every table behind them.
    expect(shell).toContain("/api/worlds");
    expect(worldPage).toContain("/api/worlds/");
  });
});
