import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterSheet } from "@/components/feed/FilterSheet";
import { emptyDiscoveryQuery, activeFilterCount, discoverySearchParams, isFilteredQuery, type DiscoveryQuery } from "@/lib/discovery";
import { adultTags, platformTagCategories } from "@/lib/tags";

/**
 * The discovery filter sheet.
 *
 * Adult content is opt-in, and the control has to say so: the switch reads as
 * something to turn on to see more, not as something to turn on to see less.
 * These also cover the state the two systems can otherwise contradict each
 * other in — an adult tag chosen while adult content is excluded — which used
 * to be a silent zero-result feed.
 */

const query = (changes: Partial<DiscoveryQuery> = {}): DiscoveryQuery => ({ ...emptyDiscoveryQuery, ...changes });

function render(current: DiscoveryQuery) {
  return renderToStaticMarkup(<FilterSheet query={current} onApply={() => {}} onClose={() => {}} />);
}
/** Rendered text with the markup stripped and entities decoded back to characters. */
function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#x27;|&apos;/g, "'")
    .replace(/&ldquo;/g, "\u201c").replace(/&rdquo;/g, "\u201d")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the 18+ control", () => {
  it("is phrased as including adult content, not as hiding it", () => {
    const html = text(render(query()));
    expect(html).toContain("Include 18+ creations");
    expect(html).not.toContain("Hide 18+");
  });

  it("is off by default, which is the state that excludes adult creations", () => {
    expect(emptyDiscoveryQuery.includeAdult).toBe(false);
    const html = render(query());
    // An unchecked box is the safe feed; nothing has to be turned on to be safe.
    expect(html).not.toContain('checked=""');
  });

  it("is on only when the reader opted in", () => {
    expect(render(query({ includeAdult: true }))).toContain('checked=""');
  });

  it("says it is a browsing filter rather than an account setting", () => {
    const html = text(render(query()));
    expect(html).toContain("your account settings are unchanged".toLowerCase());
  });

  it("explains both directions of the switch", () => {
    const html = text(render(query()));
    expect(html).toContain("adult creations are left out");
    expect(html).toContain("they appear alongside everything else");
  });
});

describe("an adult tag with adult content excluded", () => {
  it("tells the reader why the filter would find nothing", () => {
    const html = text(render(query({ tags: ["BDSM"], includeAdult: false })));
    expect(html).toContain("BDSM");
    expect(html).toContain("adult tag");
    expect(html).toContain("this filter will find nothing");
    expect(html).toContain("Include 18+ creations");
  });

  it("counts several adult tags rather than naming only the first", () => {
    const html = text(render(query({ tags: ["BDSM", "Breeding", "Romance"], includeAdult: false })));
    expect(html).toContain("2 adult tags are selected");
  });

  it("says nothing when the two agree", () => {
    for (const current of [query({ tags: ["BDSM"], includeAdult: true }), query({ tags: ["Romance"] })]) {
      expect(text(render(current))).not.toContain("will find nothing");
    }
  });
});

describe("adult tags are identifiable as adult", () => {
  it("marks every adult category and every chip inside it", () => {
    const html = render(query());
    const adultCategory = platformTagCategories.find((category) => category.adult)!;
    expect(text(html)).toContain(adultCategory.label);
    // Once per chip plus once for each category heading.
    const marks = html.match(/>18\+</g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(adultTags.length);
  });

  it("carries the restriction in the accessible name, not only in a colour", () => {
    const html = render(query());
    expect(html).toContain('aria-label="BDSM, 18+"');
    expect(html).toContain('aria-label="CNC / Non-consent Fantasy, 18+"');
    // A safe tag gets no such label, so the marking means something.
    expect(html).not.toContain('aria-label="Romance, 18+"');
  });

  it("names the non-consent tag as a fiction label wherever it is shown", () => {
    expect(text(render(query()))).toContain("CNC / Non-consent Fantasy");
  });
});

describe("the sheet keeps working as the list grows", () => {
  it("still offers every category, in taxonomy order", () => {
    const html = text(render(query()));
    let cursor = -1;
    for (const category of platformTagCategories) {
      const at = html.indexOf(category.label);
      expect(at, `${category.label} is missing from the sheet`).toBeGreaterThan(-1);
      expect(at, `${category.label} is out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("keeps the kind-of-creation control and the sticky actions", () => {
    const html = text(render(query()));
    expect(html).toContain("Filters");
    expect(html).toContain("Kind of creation");
    expect(html).toContain("Clear");
    expect(html).toContain("Show creations");
    expect(render(query())).toContain('aria-label="Close filters"');
  });

  it("keeps a scrollable body with room beneath the last row for the sticky footer", () => {
    const css = readFileSync(new URL("../src/components/feed/feed.module.css", import.meta.url), "utf8");
    const body = css.slice(css.indexOf(".sheetBody {"), css.indexOf("}", css.indexOf(".sheetBody {")));
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("min-height: 0");
    expect(body).toMatch(/padding: [^;]*\d+px;/);
    const foot = css.slice(css.indexOf(".sheetFoot {"), css.indexOf("}", css.indexOf(".sheetFoot {")));
    expect(foot).toContain("env(safe-area-inset-bottom)");
  });

  it("lets a long adult label wrap instead of shrinking or overflowing", () => {
    const css = readFileSync(new URL("../src/components/feed/feed.module.css", import.meta.url), "utf8");
    expect(css).toContain("white-space: normal");
    expect(css).toContain("max-width: 100%");
    // The chip keeps its full type size; only the box grows.
    const chip = css.slice(css.indexOf(".chip {"), css.indexOf("}", css.indexOf(".chip {")));
    expect(chip).toContain("font-size: 12px");
    expect(chip).toMatch(/padding: \d+px \d+px/);
  });

  it("counts the tags, kinds and the adult opt-in on the filter button", () => {
    expect(activeFilterCount(query())).toBe(0);
    expect(activeFilterCount(query({ tags: ["BDSM"], includeAdult: true }))).toBe(2);
    expect(activeFilterCount(query({ types: ["cast"], tags: ["Romance"] }))).toBe(1 + 1);
  });

  it("does not blame an empty feed on having included adult content", () => {
    // Including adult content widens the feed, so it is not a narrowing filter
    // and "try fewer filters" must not be offered because of it.
    expect(isFilteredQuery(query({ includeAdult: true }))).toBe(false);
    expect(isFilteredQuery(query({ tags: ["Romance"] }))).toBe(true);
  });

  it("keeps the opt-in shareable in the URL, and absent when it is off", () => {
    expect(discoverySearchParams(query({ includeAdult: true })).get("adult")).toBe("include");
    expect(discoverySearchParams(query()).get("adult")).toBeNull();
  });
});

describe("hashtags stay out of the sheet", () => {
  it("offers no hashtag anywhere in it", () => {
    const html = render(query());
    // Hashtags are searched, not browsed; folding them in here would merge the
    // two discovery systems.
    expect(html).not.toContain("#");
    expect(text(html).toLowerCase()).not.toContain("hashtag");
  });
});
