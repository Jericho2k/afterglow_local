import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema, query, setPoolForTesting } from "@/lib/db";
import { curatedCatalog, curatedModels, routeGenerationAllowed } from "@/lib/curated-routes";
import { healthState, recordRouteOutcome, routeHealth } from "@/lib/route-health";
import { isFreeModel, modelCapabilities, modelCategory } from "@/lib/provider";

/**
 * THE CATALOGUE, AND THE TWO THINGS IT MUST NEVER DO.
 *
 * It must never require a deploy to withdraw a dead free route — OpenRouter's
 * free lineup changes weekly, and a route that 404s for every reader who chose
 * it cannot wait for a release. And it must never delete a route because one
 * provider had a bad hour, because that loses the curation work and the
 * reader's chosen writer along with it.
 *
 * Those pull in opposite directions, and the resolution is that WITHDRAWAL IS A
 * HUMAN DECISION written to `curated_model_routes`, while HEALTH IS A ROLLING
 * OBSERVATION that can only ever say "busy" or "temporarily unavailable".
 */

const freeRoute = "ling-3.0-flash-free";

function enableOpenRouter() {
  vi.stubEnv("ENABLE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
}

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  enableOpenRouter();
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("what the picker is allowed to show", () => {
  it("puts every model on a product shelf, never on a vendor one", () => {
    /*
     * Provider infrastructure is not a product category. A reader choosing how
     * their story is written has no opinion about a quantisation or an endpoint,
     * and the two shelves that exist because endpoints differ — Economy and
     * Fast — are named after the experience rather than after the host.
     */
    expect(modelCategory("glm-4.7")).toBe("recommended");
    expect(modelCategory("glm-5.3-flash")).toBe("recommended");
    expect(modelCategory("glm-5.3-flash-economy")).toBe("economy");
    expect(modelCategory("ling-3.0-flash")).toBe("economy");
    expect(modelCategory("qwen3.8-flash")).toBe("experimental");
    expect(modelCategory(freeRoute)).toBe("free");
    // A model this build has never heard of is not "recommended".
    expect(modelCategory("something-nobody-declared")).toBe("experimental");
  });

  it("offers the same writer as two serving profiles, not as two characters", () => {
    /*
     * One model, one slug, one set of weights. What differs is the endpoint
     * underneath, which is why the Economy profile prefers a different host and
     * why neither profile is described to a reader as a different writer.
     */
    const fast = modelCapabilities("openrouter", "glm-5.3-flash");
    const economy = modelCapabilities("openrouter", "glm-5.3-flash-economy");
    expect(economy.preferredProviders).toEqual(["relace"]);
    expect(fast.preferredProviders).toBeUndefined();
    expect(economy.contextTokens).toBe(fast.contextTokens);
    expect(economy.costCeiling).toEqual(fast.costCeiling);
  });

  it("declines reasoning by default where a model thinks before it speaks", () => {
    /*
     * The one behavioural claim in this sprint with independent measurement
     * behind it: GLM 5.3 Flash reasons before answering, and independent
     * benchmarking put its median time-to-first-token on a reasoning-heavy
     * suite in the tens of seconds. A reader mid-scene will have switched tabs.
     * Coding-oriented reasoning is not known to help roleplay at all, so the
     * default is off and an engine that explicitly wants thinking still wins.
     */
    expect(modelCapabilities("openrouter", "glm-5.3-flash").reasoningDefault).toBe("off");
    expect(modelCapabilities("openrouter", "qwen3.8-flash").reasoningDefault).toBe("off");
    expect(modelCapabilities("openrouter", "glm-4.7").reasoningDefault).toBeUndefined();
  });

  it("sends every free route with a privacy floor, because free is not the same as safe", () => {
    /*
     * OpenRouter's account settings distinguish free endpoints that may TRAIN on
     * inputs from free endpoints that may PUBLISH prompts. "It costs nothing"
     * and "it is safe to put a private roleplay through it" are therefore
     * entirely separate questions, and a route that answers the first without
     * the second has no business being an ordinary chat model here.
     */
    for (const id of [freeRoute, "minimax-m2.5-free"]) {
      expect(isFreeModel(id)).toBe(true);
      expect(modelCapabilities("openrouter", id).dataPolicy).toEqual({ dataCollection: "deny" });
    }
  });

  it("withdraws a dead route without a deploy, and puts it back the same way", async () => {
    const before = await curatedModels();
    expect(before.some((model) => model.id === freeRoute)).toBe(true);

    await query("INSERT INTO curated_model_routes (model_id,enabled) VALUES ($1,false)", [freeRoute]);
    const after = await curatedModels();
    expect(after.some((model) => model.id === freeRoute)).toBe(false);
    // And the generation path agrees, because a picker's answer is minutes old
    // and a free endpoint's lifetime is measured in hours.
    await expect(routeGenerationAllowed(freeRoute)).resolves.toEqual({ allowed: false, reason: "disabled" });

    await query("UPDATE curated_model_routes SET enabled=true WHERE model_id=$1", [freeRoute]);
    expect((await curatedModels()).some((model) => model.id === freeRoute)).toBe(true);
  });

  it("can demote a route to another shelf without touching the code", async () => {
    await query("INSERT INTO curated_model_routes (model_id,category,notice) VALUES ($1,'experimental',$2)",
      [freeRoute, "Under review."]);
    const entry = (await curatedModels()).find((model) => model.id === freeRoute);
    expect(entry?.category).toBe("experimental");
    expect(entry?.notice).toBe("Under review.");
  });

  it("cannot conjure a model the code has never heard of", async () => {
    // The line that keeps this from being a CMS. A row naming an unknown model
    // is ignored, because what a model can be asked for — its context, its
    // request body, its privacy floor — is an engineering decision.
    await query("INSERT INTO curated_model_routes (model_id,enabled) VALUES ($1,true)", ["invented/by-a-database-row"]);
    expect((await curatedModels()).some((model) => model.id === "invented/by-a-database-row")).toBe(false);
  });

  it("drops a provider group once nothing on it is left to offer", async () => {
    vi.stubEnv("ALLOWED_MODELS", `deepseek-v4-flash,${freeRoute}`);
    await query("INSERT INTO curated_model_routes (model_id,enabled) VALUES ($1,false)", [freeRoute]);
    const catalog = await curatedCatalog();
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["deepseek"]);
  });
});

describe("health, which reports and never retires", () => {
  it("treats no evidence as available rather than as broken", () => {
    // Otherwise a newly curated route could never be tried at all.
    expect(healthState({ successes: 0, failures: 0, capacityErrors: 0, lastSuccessAt: null, lastFailureAt: null })).toBe("available");
  });

  it("lets a recent success outweigh older failures", () => {
    // This is what makes a busy endpoint recover the moment it recovers, rather
    // than after its counters age out of the window.
    expect(healthState({
      successes: 1, failures: 9, capacityErrors: 9,
      lastFailureAt: "2026-08-31T09:00:00.000Z", lastSuccessAt: "2026-08-31T09:05:00.000Z",
    })).toBe("available");
  });

  it("tells a busy route apart from a broken one", () => {
    const failing = { successes: 0, failures: 6, lastSuccessAt: null, lastFailureAt: "2026-08-31T09:00:00.000Z" };
    /*
     * Two states rather than one, because they send a reader to different
     * remedies. "Busy" is what a free endpoint does at peak and is worth
     * waiting out; "unavailable" is something being wrong with the route.
     * Conflating them is how a product tells somebody a model is broken when it
     * is merely popular.
     */
    expect(healthState({ ...failing, capacityErrors: 6 })).toBe("busy");
    expect(healthState({ ...failing, capacityErrors: 0 })).toBe("unavailable");
  });

  it("does not call a route down while it is still answering most of the time", () => {
    expect(healthState({
      successes: 7, failures: 3, capacityErrors: 3,
      lastSuccessAt: "2026-08-31T09:00:00.000Z", lastFailureAt: "2026-08-31T09:10:00.000Z",
    })).toBe("available");
  });

  it("hides a route that takes longer than the interactive floor to say anything", async () => {
    vi.stubEnv("ROUTE_MAX_TTFT_MS", "30000");
    await recordRouteOutcome({ modelId: freeRoute, ok: true, ttftMs: 42_000, outputTokens: 400, generationMs: 8_000 });
    const health = (await routeHealth([freeRoute])).get(freeRoute);
    expect(health?.belowInteractiveFloor).toBe(true);
    /*
     * THE ONLY RULE THAT REMOVES A ROW, and it removes it from the picker
     * rather than from the database: the route returns the moment its measured
     * latency does. Thirty seconds before a reader sees anything is not slow,
     * it is a tab they have already left.
     */
    expect((await curatedModels()).some((model) => model.id === freeRoute)).toBe(false);
    await expect(routeGenerationAllowed(freeRoute)).resolves.toEqual({ allowed: false, reason: "unavailable" });
  });

  it("keeps a slow-streaming route and sinks it instead", async () => {
    vi.stubEnv("ROUTE_MIN_THROUGHPUT_TPS", "15");
    // Fast to start, then four tokens a second. Unpleasant to read along with,
    // and still a working model somebody may prefer to no model at all.
    await recordRouteOutcome({ modelId: freeRoute, ok: true, ttftMs: 900, outputTokens: 40, generationMs: 10_000 });
    const entries = await curatedModels();
    const entry = entries.find((model) => model.id === freeRoute);
    expect(entry).toBeDefined();
    expect(entry?.deprioritized).toBe(true);
    expect(entries[entries.length - 1].id).toBe(freeRoute);
  });

  it("still lets a busy route be tried", async () => {
    await recordRouteOutcome({ modelId: freeRoute, ok: false, capacity: true });
    await recordRouteOutcome({ modelId: freeRoute, ok: false, capacity: true });
    const health = (await routeHealth([freeRoute])).get(freeRoute);
    expect(health?.state).toBe("busy");
    /*
     * Health summarises the last hour; it is not a live capacity check, and
     * free endpoints recover in minutes. Refusing on "busy" would make the
     * product slower to recover than the provider is.
     */
    await expect(routeGenerationAllowed(freeRoute)).resolves.toEqual({ allowed: true });
    const entry = (await curatedModels()).find((model) => model.id === freeRoute);
    expect(entry?.availability).toBe("busy");
    expect(entry?.notice).toContain("Busy");
  });

  it("leaves paid models out of the availability question entirely", async () => {
    await recordRouteOutcome({ modelId: "glm-4.7", ok: false });
    const entry = (await curatedModels()).find((model) => model.id === "glm-4.7");
    // A paid model's availability is a provider incident, handled by failover
    // and by the retirement message. Decorating every row with a status dot
    // would train readers to ignore the one place the dot means something.
    expect(entry?.availability).toBeUndefined();
    await expect(routeGenerationAllowed("glm-4.7")).resolves.toEqual({ allowed: true });
  });
});
