import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Messages / Saves / Chats module.
 *
 * It was laid out in four fixed columns while only three stats have ever
 * rendered — rank is not computed and is correctly absent — so a quarter of
 * the block was permanently empty and the row read as misaligned. These assert
 * the fix and the constraints around it: the metrics themselves are unchanged,
 * nothing invented was added to fill the space, and zero is a value rather
 * than a defect.
 */

const page = readFileSync(new URL("../src/app/characters/[id]/profile.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/app/characters/[id]/profile.module.css", import.meta.url), "utf8");

describe("the row is sized to what it holds", () => {
  it("no longer hard-codes four columns for three stats", () => {
    expect(css).not.toContain("grid-template-columns: repeat(4, 1fr)");
    expect(css).toContain("repeat(var(--stat-count, 3), minmax(0, 1fr))");
  });

  it("tells the grid how many cells it is rendering", () => {
    expect(page).toContain('"--stat-count": visibleStats.length');
  });

  it("gives every cell an equal fraction that cannot be widened by its content", () => {
    // `minmax(0, 1fr)` rather than `1fr`: a long label must wrap inside its
    // column instead of stretching it and skewing the row.
    const stats = css.slice(css.indexOf(".stats {"), css.indexOf(".unavailable"));
    expect(stats).toContain("minmax(0, 1fr)");
    expect(stats).toContain("overflow-wrap: anywhere");
  });

  it("aligns the values on a shared baseline with tabular figures", () => {
    // Digits of differing widths would otherwise make three centred values
    // look subtly off from one another.
    expect(css).toContain("font-variant-numeric: tabular-nums");
  });
});

describe("the metrics are unchanged", () => {
  it("shows exactly messages, saves and chats", () => {
    const block = page.slice(page.indexOf("const visibleStats"), page.indexOf("];", page.indexOf("const visibleStats")));
    expect(block).toContain('label: "Messages"');
    expect(block).toContain('label: "Saves"');
    expect(block).toContain('label: "Chats"');
    expect(block).toContain("stats.messages");
    expect(block).toContain("stats.saves");
    expect(block).toContain("stats.chats");
  });

  it("does not reintroduce likes or invent a rank", () => {
    const block = page.slice(page.indexOf("const visibleStats"), page.indexOf("];", page.indexOf("const visibleStats")));
    expect(block).not.toContain("Likes");
    expect(block).not.toContain("Rank");
    expect(block).not.toContain("rankCategory");
  });

  it("still distinguishes a metric that is zero from one that is unavailable", () => {
    // Null renders as an em dash, because "we cannot answer that" and "it is
    // zero" are different facts and a new creation is the second one.
    expect(page).toContain("value ?? <span className={styles.unavailable}>—</span>");
    expect(page).toContain("stats.messages === null ? null : compactCount(stats.messages)");
  });
});

describe("it survives a phone", () => {
  it("drops to the icon alone at the narrowest widths rather than wrapping badly", () => {
    expect(css).toContain("@media (max-width: 359px)");
    const narrow = css.slice(css.indexOf("@media (max-width: 359px)"));
    expect(narrow).toContain(".statLabel span { display: none; }");
  });

  it("keeps the icon from being squeezed by a wrapping label", () => {
    expect(css).toContain(".statLabel svg { flex: none;");
  });
});
