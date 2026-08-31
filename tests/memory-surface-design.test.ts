import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declarationsFor } from "./helpers/css";

const styles = readFileSync(new URL("../src/components/shell/shell.module.css", import.meta.url), "utf8");
const library = readFileSync(new URL("../src/components/shell/MemoryLibrary.tsx", import.meta.url), "utf8");

/**
 * The memory surface was the last screen still built in the first-generation
 * material: flat white-alpha cards on a flat ground, every memory identical to
 * every other, and controls that read as a settings form rather than an
 * archive. Everything around it had moved to the near-black ground with its
 * warm violet undertone, so opening Memory felt like leaving the app.
 *
 * SEMANTICS ARE NOT PART OF THE REDESIGN, and the second block below is what
 * says so: add, edit, remove-by-supersession, pin, kind, status and scope all
 * survive it unchanged.
 */

describe("the memory surface belongs to the current app", () => {
  it("grounds a memory card in the app's surface token, not flat white alpha", () => {
    const item = declarationsFor(styles, ".memoryItem");
    expect(item.background).toContain("var(--surface");
    expect(Number.parseInt(item["border-radius"], 10)).toBeGreaterThanOrEqual(14);
  });

  it("gives every kind its own tint, so the list is scannable", () => {
    for (const kind of ["Identity", "Relationship", "Event", "Promise", "Preference", "Boundary", "OpenLoop"]) {
      expect(declarationsFor(styles, `.kind${kind}`)["--kind-tint"]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // And the component actually applies them.
    for (const kind of ["identity", "relationship", "event", "promise", "preference", "boundary", "open_loop"]) {
      expect(library).toContain(`${kind}: styles.kind`);
    }
  });

  it("marks a pinned memory structurally rather than with a word alone", () => {
    expect(declarationsFor(styles, ".memoryItemPinned")["border-color"]).toContain("232, 121, 169");
    expect(library).toContain("styles.memoryItemPinned");
  });

  it("uses the app's accent for its highlights", () => {
    expect(declarationsFor(styles, ".memoryPinned").background).toContain("var(--accent)");
    expect(declarationsFor(styles, ".memoryToggle")["border-radius"]).toBe("999px");
  });

  it("gives the metadata discrete chips instead of one run-on line", () => {
    const chip = declarationsFor(styles, ".memoryMeta > span");
    expect(chip["border-radius"]).toBe("999px");
    // The old rule joined them with typographic dots.
    expect(styles).not.toContain('.memoryMeta > span + span::before { content: "·"');
  });

  it("keeps every control a comfortable touch target, and comfortable on a phone", () => {
    // `declarationsFor` merges in source order, so this is the phone value; the
    // base rule is checked directly below it.
    expect(Number.parseInt(declarationsFor(styles, ".memoryActions button")["min-height"], 10)).toBeGreaterThanOrEqual(34);
    expect(styles).toMatch(/\.memoryActions button \{[^}]*min-height: 34px/);
    expect(styles).toContain("@media (max-width: 480px)");
    expect(styles).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.memoryActions button \{[^}]*min-height: 38px/);
  });

  it("declares one rule per class, so an edit cannot land on the losing copy", () => {
    expect((styles.match(/^\.memoryDerived \{/gm) ?? []).length).toBe(1);
    expect((styles.match(/^\.memoryItem \{/gm) ?? []).length).toBe(1);
  });
});

describe("nothing about what a memory means changed", () => {
  it("keeps add, edit, pin and remove", () => {
    expect(library).toContain("Add a memory");
    expect(library).toContain("setEditingId(memory.id)");
    expect(library).toContain("pinned: !memory.pinned");
    expect(library).toContain("Yes, remove");
  });

  it("keeps removal as supersession, and still says so", () => {
    expect(library).toContain("She stops recalling this from now on. Replies that already used it keep saying so.");
  });

  it("keeps kind, status, scope and importance where they were", () => {
    expect(library).toContain("kindLabel(memory.kind)");
    expect(library).toContain('memory.status === "resolved"');
    expect(library).toContain('memory.conversationId ? "This story" : "Every story"');
    expect(library).toContain("importance");
  });

  it("keeps the read-only derived layers visible", () => {
    expect(library).toContain("Core canon");
    expect(library).toContain("Story so far");
    expect(library).toContain("Chapters");
  });
});
