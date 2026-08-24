import { describe, expect, it } from "vitest";
import {
  accentLuminance, accentVariables, defaultAccent, hasCustomAccent,
  normalizeAccent, readableAccent,
} from "@/lib/accent";

/**
 * Creation accent colour.
 *
 * The setting existed and did nothing, so making it visible is the point —
 * but a creator-supplied colour reaches the page as CSS, and two things must
 * remain true at every value they can pick: nothing they type becomes CSS
 * syntax, and nothing they pick makes the product unreadable.
 */

describe("only a colour gets through", () => {
  it("accepts the hex forms the picker produces", () => {
    expect(normalizeAccent("#e879a9")).toBe("#e879a9");
    expect(normalizeAccent("#E879A9")).toBe("#e879a9");
    expect(normalizeAccent("#f0a")).toBe("#ff00aa");
    expect(normalizeAccent("  #b892f0  ")).toBe("#b892f0");
  });

  it("refuses everything that is not one", () => {
    for (const attempt of [
      "url(https://evil.example/x.png)",
      "var(--secret)",
      "calc(100% - 10px)",
      "#e879a9; background: url(x)",
      "red",
      "rgb(255,0,0)",
      "expression(alert(1))",
      "#12345",
      "",
      "   ",
      null,
      undefined,
      42 as unknown as string,
    ]) {
      expect(normalizeAccent(attempt as string)).toBe(defaultAccent);
    }
  });

  it("emits only colours, never syntax a creator supplied", () => {
    const variables = accentVariables("#e879a9; background: url(evil)");
    for (const value of Object.values(variables)) {
      expect(value).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/);
    }
  });

  it("falls back to the product accent for a creation that never set one", () => {
    expect(accentVariables("")["--creation-accent"]).toBe(defaultAccent);
    expect(accentVariables(undefined)["--creation-accent"]).toBe(defaultAccent);
    expect(hasCustomAccent("")).toBe(false);
    expect(hasCustomAccent("#b892f0")).toBe(true);
  });
});

describe("no colour can make the product unreadable", () => {
  it("lifts a near-black accent until it carries on a dark surface", () => {
    const lifted = readableAccent("#000000");
    expect(accentLuminance(lifted)).toBeGreaterThan(0.5);
    expect(lifted).not.toBe("#000000");
  });

  it("lifts a very dark colour proportionally rather than to white", () => {
    const lifted = readableAccent("#1a0d20");
    expect(accentLuminance(lifted)).toBeGreaterThan(accentLuminance("#1a0d20"));
    expect(lifted).not.toBe("#ffffff");
  });

  it("leaves a bright accent exactly as chosen", () => {
    for (const bright of ["#ffffff", "#ffe066", "#7fffd4"]) {
      expect(readableAccent(bright)).toBe(bright);
    }
  });

  it("keeps every accent readable, whatever it is", () => {
    for (const accent of ["#000000", "#010101", "#1a0d20", "#e879a9", "#ffffff", "#ffe066", "#00204a", "#7fffd4"]) {
      expect(accentLuminance(readableAccent(accent))).toBeGreaterThanOrEqual(0.45);
    }
  });
});

describe("the accent stays a seed rather than a theme", () => {
  it("derives every variant from the one stored colour", () => {
    const variables = accentVariables("#7fffd4");
    expect(Object.keys(variables).sort()).toEqual([
      "--creation-accent",
      "--creation-accent-border",
      "--creation-accent-glow",
      "--creation-accent-readable",
      "--creation-accent-soft",
    ]);
    // Nothing derived is fully opaque except the colour itself and the
    // readable variant: edges and glows are alpha, so an accent tints the
    // product rather than covering it.
    expect(variables["--creation-accent-border"]).toContain("0.34");
    expect(variables["--creation-accent-glow"]).toContain("0.22");
  });

  it("pulls the soft variant toward Afterglow's own violet", () => {
    // A pure green accent must not produce a pure green surface: the soft
    // variant is what keeps an arbitrary hue looking like this product.
    const soft = accentVariables("#00ff00")["--creation-accent-soft"];
    expect(soft).not.toBe("#00ff00");
    const [r, , b] = [soft.slice(1, 3), soft.slice(3, 5), soft.slice(5, 7)].map((part) => Number.parseInt(part, 16));
    expect(r).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });
});
