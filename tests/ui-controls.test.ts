import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const select = readFileSync("src/components/ui/SelectField.tsx", "utf8");
const ui = readFileSync("src/components/ui/ui.module.css", "utf8");
const shell = readFileSync("src/components/shell/AppShell.tsx", "utf8");
const settings = readFileSync("src/components/shell/SettingsSheet.tsx", "utf8");
const rankings = readFileSync("src/components/rankings/RankingsView.tsx", "utf8");
const profile = readFileSync("src/app/creators/[username]/profile.tsx", "utf8");

describe("the shared choice control", () => {
  it("replaces app-level native selects on the sprint surfaces", () => {
    for (const source of [shell, settings, rankings, profile]) expect(source).not.toContain("<select");
    expect([shell, settings, rankings, profile].every((source) => source.includes("SelectField"))).toBe(true);
  });

  it("portals, flips and clamps its menu outside scroll containers", () => {
    expect(select).toContain("createPortal(");
    expect(select).toContain("window.innerHeight - rect.bottom");
    expect(select).toContain("above > below");
    expect(select).toContain("Math.min(Math.max(gutter, rect.left)");
    expect(ui).toContain("position: fixed");
    expect(ui).toContain("overflow: auto");
  });

  it("supports the expected keyboard contract and focus treatment", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape", "Tab"]) {
      expect(select).toContain(`event.key === "${key}"`);
    }
    expect(select).toContain('role="listbox"');
    expect(select).toContain('role="option"');
    expect(ui).toContain(".selectTrigger:focus-visible");
  });
});

describe("chat control consistency", () => {
  it("uses the shared icon action and settings rows", () => {
    expect(shell).toContain("<IconButton className={`composer-plus");
    expect(shell.match(/<SettingsChoiceRow/g)?.length).toBeGreaterThanOrEqual(5);
    expect(shell).toContain("<SelectField\n            row");
  });
});
