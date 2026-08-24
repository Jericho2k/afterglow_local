import { describe, expect, it } from "vitest";
import {
  accentLuminance, accentSaturation, accentVariables, defaultAccent, hasCustomAccent,
  normalizeAccent, readableAccent, temperedAccent,
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
      "--creation-accent-bright",
      "--creation-accent-deep",
      "--creation-accent-glow",
      "--creation-accent-glow-strong",
      "--creation-accent-ink",
      "--creation-accent-readable",
      "--creation-accent-soft",
      "--creation-accent-surface",
    ]);
    // Nothing derived is fully opaque except the colour itself and the
    // readable variant: edges and glows are alpha, so an accent tints the
    // product rather than covering it.
    expect(variables["--creation-accent-border"]).toContain("0.34");
    for (const key of ["--creation-accent-glow", "--creation-accent-glow-strong"] as const) {
      const alpha = Number(variables[key].match(/,\s*([\d.]+)\)$/)?.[1]);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(0.45);
    }
  });

  it("quiets an aggressive colour instead of letting it take the page over", () => {
    // Pure green used to produce a neon page, which is the one register the
    // product is not. The further a colour is from grey, the further it is
    // pulled toward Afterglow's own violet and the quieter its ambient wash.
    const neon = accentVariables("#00ff00");
    const crimson = accentVariables("#c2185b");

    expect(temperedAccent("#00ff00")).not.toBe("#00ff00");
    expect(accentSaturation(temperedAccent("#00ff00"))).toBeLessThan(accentSaturation("#00ff00"));
    const neonGlow = Number(neon["--creation-accent-glow"].match(/,\s*([\d.]+)\)$/)?.[1]);
    const crimsonGlow = Number(crimson["--creation-accent-glow"].match(/,\s*([\d.]+)\)$/)?.[1]);
    expect(neonGlow).toBeLessThan(crimsonGlow);

    // And the colours people actually choose are left essentially alone.
    for (const accent of ["#c2185b", "#1a237e", "#ffe066", "#e879a9"]) {
      const moved = Math.abs(accentLuminance(temperedAccent(accent)) - accentLuminance(accent));
      expect(moved, `${accent} moved too far`).toBeLessThan(0.06);
    }
  });

  it("keeps a tinted surface overwhelmingly near-black at any hue", () => {
    // The rule that stops the feed becoming a rainbow: a card or panel tinted
    // by an accent must still read as an Afterglow surface, not as a coloured
    // box, whichever colour the creator picked.
    for (const accent of ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ffffff"]) {
      expect(accentLuminance(accentVariables(accent)["--creation-accent-surface"])).toBeLessThan(0.2);
    }
  });

  it("gives a gradient two ends that are actually different", () => {
    for (const accent of ["#ff0000", "#1c1c3a", "#ffe066"]) {
      const variables = accentVariables(accent);
      expect(accentLuminance(variables["--creation-accent-bright"]))
        .toBeGreaterThan(accentLuminance(variables["--creation-accent-deep"]));
    }
  });

  it("writes on a solid accent in whichever ink survives it", () => {
    // Yellow needs dark text, navy needs light text. Neither may be written in
    // the accent itself.
    expect(accentVariables("#ffe066")["--creation-accent-ink"]).toBe("#180f16");
    expect(accentVariables("#1c1c3a")["--creation-accent-ink"]).toBe("#fdf6fa");
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
