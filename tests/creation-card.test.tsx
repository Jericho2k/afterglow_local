import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CreationCard } from "@/components/feed/CreationCard";
import { CreationGrid } from "@/components/feed/CreationGrid";
import styles from "@/components/feed/feed.module.css";
import type { CreationSummary } from "@/lib/types";

/**
 * The feed card.
 *
 * A card represents a Creation, which may be a character, a defined cast or a
 * scenario with no primary character at all. These assert the properties the
 * whole feed rests on: the title is the creation's own, nothing invents a
 * character that was never authored, one long title cannot deform the grid,
 * and the public metrics are messages and saves — never a like.
 */

const base: CreationSummary = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "Seraphine",
  title: "Seraphine",
  creationType: "character",
  profileType: "single",
  tagline: "The girl who writes your name in the margins of her poetry.",
  avatarUrl: "https://cdn.example/seraphine.png",
  avatarPath: "",
  accent: "#e879a9",
  tags: ["Poetic", "Drama", "Enemies to Lovers"],
  hashtags: ["darkacademia"],
  contentMode: "clean", nsfwEnabled: false,
  messageCount: 2_100_000,
  chatCount: 4210,
  saveCount: 48_200,
  savedByViewer: false,
  creator: { id: "u1", username: "nova", displayName: "Nova", avatarPath: "" },
  ownedByViewer: false,
  publishedAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function render(creation: Partial<CreationSummary>, onToggleSave?: (creation: CreationSummary) => void) {
  return renderToStaticMarkup(<CreationCard creation={{ ...base, ...creation }} onToggleSave={onToggleSave} />);
}

/** Text with the markup stripped, so a clamp or a wrapper cannot hide a failure. */
function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("character creation", () => {
  it("renders the title, cover, tagline, tags and both public metrics", () => {
    const html = render({});
    expect(text(html)).toContain("Seraphine");
    expect(html).toContain(`src="${base.avatarUrl}"`);
    expect(text(html)).toContain("The girl who writes your name in the margins of her poetry.");
    expect(text(html)).toContain("Poetic");
    expect(text(html)).toContain("by @nova");
    // Compact counts, from the one shared formatter.
    expect(text(html)).toContain("2.1M");
    expect(text(html)).toContain("48.2K");
  });

  it("opens the public creation page rather than a chat", () => {
    expect(render({})).toContain(`href="/characters/${base.id}"`);
  });

  it("labels its metrics for assistive technology", () => {
    const html = render({});
    expect(text(html)).toContain("2.1M messages");
    expect(text(html)).toContain("48.2K saves");
  });
});

describe("scenario creation with no primary character", () => {
  const finalWar: Partial<CreationSummary> = {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    // A scenario reuses its title internally and defines nobody in particular.
    name: "The Final War",
    title: "The Final War",
    creationType: "scenario",
    profileType: "ensemble",
    tagline: "The heroes are running out of options.",
    tags: ["MHA", "Action", "Superhero"],
    creator: null,
    avatarUrl: "",
    avatarPath: "",
  };

  it("renders from creation metadata alone", () => {
    const html = render(finalWar);
    const body = text(html);
    expect(body).toContain("The Final War");
    expect(body).toContain("The heroes are running out of options.");
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("null");
  });

  it("leaves no empty character slot when there is no artwork and no creator", () => {
    const html = render(finalWar);
    // The stand-in is the creation's own initials, not a missing person.
    expect(html).toContain(styles.coverFallback);
    expect(html).toContain(">TF<");
    expect(html).not.toContain(styles.byline);
  });

  it("marks the structure subtly rather than shouting it", () => {
    expect(text(render(finalWar))).toContain("Scenario");
    // A character card says nothing about being a character.
    expect(text(render({}))).not.toContain("Character");
  });
});

describe("cast creation", () => {
  it("titles itself with the creation, never with one of its members", () => {
    const html = render({
      name: "Roommates From Hell",
      title: "Roommates From Hell",
      creationType: "cast",
      profileType: "ensemble",
      tagline: "Three roommates. One apartment. Absolutely no peace.",
    });
    expect(text(html)).toContain("Roommates From Hell");
    expect(text(html)).toContain("Cast");
  });

  it("falls back to the character name only for a creation authored before titles existed", () => {
    expect(text(render({ title: "", name: "Mara" }))).toContain("Mara");
  });
});

describe("layout stability", () => {
  it("clamps a long title to two lines instead of letting it grow", () => {
    const long = "Medieval Fantasy World RP: The Long Winter of the Seven Vales and Everything After";
    const html = render({ title: long, name: long });
    expect(text(html)).toContain(long);
    expect(html).toContain(styles.cardTitle);
    const css = readFileSync(new URL("../src/components/feed/feed.module.css", import.meta.url), "utf8");
    const rule = css.slice(css.indexOf(".cardTitle {"), css.indexOf(".tagline {"));
    expect(rule).toContain("-webkit-line-clamp: 2");
    expect(rule).toContain("overflow: hidden");
  });

  it("shows a bounded number of platform tags and counts the rest", () => {
    const html = render({ tags: ["Fantasy", "AnyPOV", "Adventure", "Slow Burn", "Royal Court", "Angst"] });
    const body = text(html);
    expect(body).toContain("Fantasy");
    expect(body).toContain("AnyPOV");
    expect(body).toContain("+4");
    // The tags beyond the visible two are counted, not rendered.
    expect(body).not.toContain("Royal Court");
    // One row that cannot wrap, so tag count cannot change the card's height.
    const css = readFileSync(new URL("../src/components/feed/feed.module.css", import.meta.url), "utf8");
    expect(css.slice(css.indexOf(".tags {"), css.indexOf(".tags li"))).toContain("flex-wrap: nowrap");
  });

  it("keeps hashtags off the compact card so the two tag systems stay distinct", () => {
    const html = render({ tags: ["Fantasy"], hashtags: ["mha", "villainau"] });
    expect(text(html)).toContain("Fantasy");
    expect(html).not.toContain("#mha");
    expect(html).not.toContain("villainau");
  });

  it("lays the grid out two per row on a phone", () => {
    const css = readFileSync(new URL("../src/components/feed/feed.module.css", import.meta.url), "utf8");
    const grid = css.slice(css.indexOf(".grid {"), css.indexOf(".card {"));
    expect(grid).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    // Nothing below the tablet breakpoint may drop it back to a single column.
    const beforeFirstBreakpoint = css.slice(0, css.indexOf("@media (min-width: 501px)"));
    expect(beforeFirstBreakpoint).not.toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*1fr/);
  });
});

describe("content rating", () => {
  it("marks an adult creation from its real setting", () => {
    expect(text(render({ contentMode: "adult_focused", nsfwEnabled: true }))).toContain("18+");
  });

  it("shows no rating badge on a creation its creator did not mark", () => {
    expect(text(render({ contentMode: "clean", nsfwEnabled: false }))).not.toContain("18+");
  });
});

describe("saving", () => {
  it("offers a save control with an explicit state", () => {
    const html = render({}, () => undefined);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Save Seraphine");
  });

  it("says so, in words, when the viewer has already saved it", () => {
    const html = render({ savedByViewer: true }, () => undefined);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Remove Seraphine from your saved creations");
    // Not colour alone: the icon is filled and the button carries a state class.
    expect(html).toContain(styles.saveButtonSaved);
  });

  it("gives a creation the viewer owns no save control, because saving it is not allowed", () => {
    const html = renderToStaticMarkup(<CreationGrid creations={[{ ...base, ownedByViewer: true }]} onToggleSave={() => undefined} />);
    expect(html).not.toContain(styles.saveButton);
    // It is otherwise the same public card.
    expect(text(html)).toContain("Seraphine");
    expect(text(html)).toContain("48.2K");
  });
});

describe("no likes", () => {
  it("renders no like metric or heart anywhere on the card", () => {
    const html = render({ savedByViewer: true }, () => undefined);
    expect(html.toLowerCase()).not.toContain("like");
    expect(html.toLowerCase()).not.toContain("heart");
    expect(html).not.toContain("♥");
  });
});
