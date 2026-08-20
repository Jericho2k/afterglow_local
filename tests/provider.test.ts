import { afterEach, describe, expect, it } from "vitest";
import { availableCatalog, defaultEngine, resolveEngine, resolveModel } from "@/lib/provider";

afterEach(() => {
  delete process.env.ALLOWED_MODELS;
  delete process.env.DEFAULT_RP_ENGINE;
});

describe("inference catalog", () => {
  it("keeps providers, base models, and RP engines as separate definitions", () => {
    const catalog = availableCatalog();
    expect(catalog.providers.some((item) => item.id === "deepseek")).toBe(true);
    expect(catalog.models.every((item) => Boolean(item.providerId) && item.id !== item.providerId)).toBe(true);
    expect(catalog.engines.some((item) => item.id === "immersive")).toBe(true);
    expect(resolveModel("deepseek", "deepseek-v4-flash")?.providerId).toBe("deepseek");
    expect(resolveModel("unknown", "deepseek-v4-flash")).toBeNull();
    expect(resolveEngine("cinematic")?.thinking).toBe(false);
    expect(resolveEngine("kink_aware")).toMatchObject({ adult: true, tags: expect.arrayContaining(["kink"]) });
    expect(resolveEngine("multi_clarity")?.description).toContain("distinct voices");
  });

  it("uses a deployment-owned engine default", () => {
    process.env.DEFAULT_RP_ENGINE = "deliberate";
    expect(defaultEngine()).toBe("deliberate");
    process.env.DEFAULT_RP_ENGINE = "unregistered";
    expect(defaultEngine()).toBe("immersive");
  });
});
