import { afterEach, describe, expect, it } from "vitest";
import { availableCatalog, defaultEngine, providerModelId, resolveEngine, resolveModel, taskModelSelection } from "@/lib/provider";

afterEach(() => {
  delete process.env.ALLOWED_MODELS;
  delete process.env.DEFAULT_RP_ENGINE;
  delete process.env.DEFAULT_LLM_PROVIDER;
  delete process.env.DEFAULT_LLM_MODEL;
  delete process.env.ENABLE_OPENROUTER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.RP_MODEL_ROUTE;
  delete process.env.MEMORY_CONSOLIDATION_MODEL_ROUTE;
  delete process.env.MEMORY_CURATION_MODEL_ROUTE;
  delete process.env.CHARACTER_IMPORT_MODEL_ROUTE;
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

  it("feature-gates OpenRouter and keeps private upstream slugs out of the public catalog", () => {
    expect(availableCatalog().providers.some((item) => item.id === "openrouter")).toBe(false);
    process.env.ENABLE_OPENROUTER = "true";
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.ALLOWED_MODELS = "deepseek-v4-flash,passion-fruit,kimi-k2.5";
    const catalog = availableCatalog();
    expect(catalog.providers.some((item) => item.id === "openrouter")).toBe(true);
    expect(catalog.models.find((item) => item.id === "passion-fruit")?.label).toContain("Passion Fruit");
    expect(JSON.stringify(catalog)).not.toContain("thedrummer/cydonia-24b-v4.1");
    expect(providerModelId("openrouter","passion-fruit")).toBe("thedrummer/cydonia-24b-v4.1");
  });

  it("routes background work independently from the conversation writer", () => {
    process.env.ENABLE_OPENROUTER = "true";
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.ALLOWED_MODELS = "deepseek-v4-flash,passion-fruit,glm-4.7";
    process.env.MEMORY_CONSOLIDATION_MODEL_ROUTE = "deepseek:deepseek-v4-flash";
    process.env.CHARACTER_IMPORT_MODEL_ROUTE = "openrouter:glm-4.7";
    expect(taskModelSelection("rp_generation",{ providerId:"openrouter",modelId:"passion-fruit" })).toEqual({ providerId:"openrouter",modelId:"passion-fruit" });
    expect(taskModelSelection("memory_consolidation")).toEqual({ providerId:"deepseek",modelId:"deepseek-v4-flash" });
    expect(taskModelSelection("character_import")).toEqual({ providerId:"openrouter",modelId:"glm-4.7" });
  });
});
