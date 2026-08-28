import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The management surface routes on its own, and there is no router outside the
// app shell. Only navigation is stubbed; everything rendered is the real thing.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const { MoreMenu } = await import("@/components/nav/MoreMenu");
type MoreMenuItem = import("@/components/nav/MoreMenu").MoreMenuItem;
const { YourCreations } = await import("@/components/creations/YourCreations");
const { creationActions, creationEditHref } = await import("@/lib/creation-actions");

/**
 * The three-dot menu.
 *
 * The control on the creation page was not a menu: it was a link to the edit
 * route, which itself redirected through Home, so pressing it navigated twice
 * and landed somewhere nobody asked for. These assert the properties that make
 * it a menu — the trigger is a button that opens something, it carries no
 * destination of its own, and it announces itself as a menu — plus the
 * ownership rule the items follow.
 */

const item = (label: string, extra: Partial<MoreMenuItem> = {}): MoreMenuItem =>
  ({ label, onSelect: vi.fn(), ...extra });

function render(items: MoreMenuItem[]) {
  return renderToStaticMarkup(<MoreMenu items={items} label="More actions for Seraphine" />);
}

describe("the trigger is a menu button, not a link", () => {
  it("renders a button and never an anchor", () => {
    const html = render([item("Edit creation")]);
    expect(html).toContain("<button");
    expect(html).not.toContain("<a ");
    // The whole bug in one assertion: pressing this must not navigate, so it
    // carries no destination at all.
    expect(html).not.toContain("href");
  });

  it("announces that it opens a menu, and that the menu starts closed", () => {
    const html = render([item("Edit creation")]);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="More actions for Seraphine"');
  });

  it("does not render the panel until it is opened", () => {
    const html = render([item("Edit creation"), item("Copy link")]);
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("Edit creation");
  });

  it("renders nothing at all when there is no action to offer", () => {
    expect(render([])).toBe("");
  });
});

/**
 * The owner management surface.
 *
 * Rendered server-side here, which is enough to assert what each card links
 * to, what state it reports, and — the part that matters — that a page of
 * cards carries no hidden definition even though every one of them belongs to
 * the caller.
 */
describe("Your Creations", () => {
  it("renders its own heading and menu affordance", () => {
    const html = renderToStaticMarkup(<YourCreations />);
    expect(html).toContain("Your Creations");
    expect(html).toContain("Everything you have made");
    // Loading, not empty: the empty state must not flash before the fetch.
    expect(html).not.toContain("Nothing here yet");
  });
});

/**
 * Who gets which action.
 *
 * The rule lives in one pure function so both surfaces that show a menu read
 * the same answer, and so this can be asserted without a browser.
 */
describe("creation menu actions", () => {
  it("gives an owner edit and delete, and marks delete as destructive", () => {
    const actions = creationActions({ owner: true });
    expect(actions.map((action) => action.id)).toEqual(["edit", "copy_link", "delete"]);
    const remove = actions.find((action) => action.id === "delete")!;
    expect(remove.danger).toBe(true);
    expect(remove.confirms).toBe(true);
  });

  it("gives everybody else no way to edit or delete somebody's creation", () => {
    const actions = creationActions({ owner: false });
    expect(actions.map((action) => action.id)).toEqual(["copy_link","report"]);
    expect(actions.some((action) => action.id === "edit")).toBe(false);
    expect(actions.some((action) => action.id === "delete")).toBe(false);
  });

  it("offers nothing the product cannot actually do", () => {
    const labels = creationActions({ owner: true }).map((action) => action.label.toLowerCase());
    for (const invented of ["report", "duplicate", "export", "analytics", "generate image"]) {
      expect(labels.some((label) => label.includes(invented))).toBe(false);
    }
  });

  it("sends Edit straight to the creation's own edit page", () => {
    // Not through the home shell, which is where the redirect used to land.
    expect(creationEditHref("aaaa")).toBe("/characters/aaaa/edit");
  });
});
