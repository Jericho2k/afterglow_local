import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The creator profile's own contracts.
 *
 * Layout was verified in a real browser at 375, 390, 430, 768, 1280 and 1440
 * — that is where the two defects it had were found, and neither could have
 * been caught by reading the file. What CAN be held here is the set of
 * decisions those measurements depend on, so a later edit that quietly
 * reintroduces one is a failing test rather than a discovery.
 */

const page = readFileSync(new URL("../src/app/creators/[username]/profile.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/app/creators/[username]/profile.module.css", import.meta.url), "utf8");
const identityCss = readFileSync(new URL("../src/components/creator/creator.module.css", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/app/api/creators/[username]/route.ts", import.meta.url), "utf8");
const library = readFileSync(new URL("../src/lib/creator-profile.ts", import.meta.url), "utf8");

describe("the phone gets the work, not a squeezed sidebar", () => {
  it("starts as one column and only becomes two with room for it", () => {
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    const wide = css.slice(css.indexOf("@media (min-width: 1024px)"));
    expect(wide).toContain("grid-template-columns: minmax(0, 1fr) 330px");
  });

  it("puts the side column after the work in source order, so it stacks below", () => {
    expect(page.indexOf('className={styles.primary}')).toBeLessThan(page.indexOf('className={styles.side}'));
  });

  it("measures the whole page against one width and one gutter", () => {
    // The identity row was centred at 1180 while the cards were pinned to the
    // gutter, which put a fifty-pixel step between the name and the numbers
    // under it. One measure, used by every band.
    expect(css).toContain("--page-measure:");
    expect(css).toContain("--page-gutter:");
    for (const band of [".identity", ".bio", ".stats", ".achievements", ".body"]) {
      const rule = css.slice(css.indexOf(`${band} {`), css.indexOf("}", css.indexOf(`${band} {`)));
      expect(rule, `${band} uses the shared measure`).toContain("var(--page-measure)");
    }
  });

  it("keeps the badge row's hidden labels inside the row that scrolls", () => {
    // An absolutely positioned element whose containing block sits outside a
    // scroll container is not clipped by it, which is how a screen-reader label
    // on the fourth badge made the whole document scroll sideways.
    const badge = identityCss.slice(identityCss.indexOf(".badge {"), identityCss.indexOf("}", identityCss.indexOf(".badge {")));
    expect(badge).toContain("position: relative");
  });
});

describe("keyboard and assistive use", () => {
  it("builds the tabs as a real tablist", () => {
    expect(page).toContain('role="tablist"');
    expect(page).toContain('role="tab"');
    expect(page).toContain('role="tabpanel"');
    expect(page).toContain("aria-selected={tab === item.id}");
    expect(page).toContain("aria-controls={`panel-${item.id}`}");
  });

  it("moves between tabs with the arrow keys and keeps one stop in the ring", () => {
    expect(page).toContain('event.key === "ArrowRight"');
    expect(page).toContain("tabIndex={tab === item.id ? 0 : -1}");
  });

  it("states the follow button's state rather than implying it from the label", () => {
    expect(page).toContain("aria-pressed={isFollowing}");
    expect(page).toContain("`Stop following ${displayName}`");
  });

  it("gives every interactive control a visible focus ring", () => {
    for (const control of [".primaryAction", ".sectionLink", ".chip", ".sortField select", ".tabs button"]) {
      expect(css, `${control} has a focus ring`).toContain(`${control}:focus-visible`);
    }
  });

  it("honours a reader who has asked for less motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(identityCss).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("the page is one request, and it carries nothing hidden", () => {
  it("asks for everything at once", () => {
    expect(page).toContain("fetch(`/api/creators/${encodeURIComponent(username)}?sort=${sort}&filter=${filter}`)");
    // One endpoint. Six requests to fill a page in is how a rich page becomes
    // a slow one.
    expect(page.match(/fetch\(/g)?.length).toBe(2); // the profile, and the follow write
  });

  it("sorts and filters on the server rather than re-ordering one page of results", () => {
    expect(library).toContain("c.user_message_count DESC");
    expect(library).toContain("LIMIT ${creationsPerPage} OFFSET $3");
  });

  it("selects only public work", () => {
    const publicOnly = library.match(/visibility\s*=\s*'public'/g) ?? [];
    expect(publicOnly.length).toBeGreaterThanOrEqual(4);
    expect(library).not.toContain("visibility IN ('public','unlisted')");
  });

  it("never selects a hidden definition or a world's lore", () => {
    // The QUERIES, not the prose around them: this file's own comment names
    // the fields it is careful to leave out, and matching that would be
    // testing the documentation rather than the code.
    const queries = (library.match(/`[^`]*SELECT[^`]*`/gs) ?? []).join("\n");
    expect(queries.length).toBeGreaterThan(200);
    for (const hidden of ["greeting", "personality", "response_directive", "boundaries", "source_material", "w.content", "cast_members"]) {
      expect(queries, `${hidden} is not a profile column`).not.toContain(hidden);
    }
  });

  it("requires a username, which is the creator's own opt-in to being public", () => {
    expect(route).toContain("WHERE username=$1");
    expect(route).toContain("/^[a-z0-9][a-z0-9_-]{2,29}$/.test(handle)");
  });
});

describe("nothing on the page is invented", () => {
  it("draws the rank card only when there is a rank", () => {
    expect(page).toContain("{payload.rank.position !== null && <section");
  });

  it("draws the activity and top-character panels only when they have content", () => {
    expect(page).toContain("{payload.activity.length > 0 &&");
    expect(page).toContain("{payload.topCharacters.length > 0 &&");
  });

  it("says what the ranking rule is, on the page itself", () => {
    expect(page).toContain("Ranked by the messages readers have sent to published creations");
  });
});
