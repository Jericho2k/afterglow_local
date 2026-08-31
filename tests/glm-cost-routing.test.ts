import { afterEach, describe, expect, it, vi } from "vitest";
import { approvedProviderPool, costPolicyFor, emergencyExpensiveFallbackEnabled, modelCapabilities, providerPolicyFor, routingMode } from "@/lib/provider";
import { completionWithUsage } from "@/lib/llm";

/**
 * The price ceiling, and the three ways it could quietly stop working.
 *
 * A month of GLM traffic landed on four different upstream hosts at prices
 * differing by a factor of several, because OpenRouter's default routing is
 * price-WEIGHTED rather than price-ordered — the cheapest endpoint is strongly
 * preferred, never guaranteed. The ceiling is what turns "usually cheap" into
 * "never expensive", and these tests exist because a guard that silently stops
 * being applied is worse than no guard: it produces the same bill and a false
 * sense that the question was settled.
 *
 * Three failure modes are worth guarding by name. The ceiling could be dropped
 * on the retry path, which is where an ordinary timeout used to be able to move
 * a conversation onto the dearest endpoint in the catalogue. It could start
 * emitting `order` or `sort`, which OpenRouter documents as turning its own
 * routing off and would defeat the session stickiness the cache depends on. Or
 * it could stop being revertible, which is the property an operator needs at
 * three in the morning.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * The end-to-end half.
 *
 * Everything below the policy tests asserts on the object the adapter builds.
 * This asserts on the bytes that leave the process, because a policy that is
 * correct and then dropped on the way to `fetch` guards nothing at all.
 */
function enableOpenRouter() {
  vi.stubEnv("ENABLE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
  vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.test/api/v1");
  vi.stubEnv("ALLOWED_MODELS", "glm-4.7");
}

describe("what actually reaches OpenRouter", () => {
  it("sends the ceiling as provider.max_price, alongside the sticky session", async () => {
    enableOpenRouter();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "gen-1", model: "z-ai/glm-4.7", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    }));

    await completionWithUsage({ providerId: "openrouter", modelId: "glm-4.7" }, [{ role: "user", content: "Hi" }], { modelId: "glm-4.7", sessionId: "abc123" });

    expect(bodies[0].model).toBe("z-ai/glm-4.7");
    /*
     * THREE GUARDS IN ONE BLOCK, and each answers a question the others cannot.
     *
     * `only` is the approved pool: endpoints verified to be BOTH affordable AND
     * cache-capable. `max_price` is defence in depth, so a pool member that
     * re-prices upward still falls out without anybody editing the catalogue.
     * `data_collection` is the privacy floor, which is not an economic guard
     * and is never traded against one.
     */
    expect(bodies[0].provider).toEqual({
      only: ["deepinfra", "novita", "z-ai"],
      allow_fallbacks: true,
      max_price: { prompt: 0.65, completion: 2.25 },
      data_collection: "deny",
    });
    // The two halves of the design travel together: the ceiling bounds WHICH
    // hosts are eligible, the session keeps the conversation on whichever one
    // it landed on. Neither works alone.
    expect(bodies[0].session_id).toBe("abc123");
  });

  it("distinguishes declining reasoning from having no opinion about it", async () => {
    enableOpenRouter();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "g", model: "z-ai/glm-4.7", choices: [{ message: { content: "ok" } }], usage: {} });
    }));

    const send = (thinking: boolean | "off" | undefined) =>
      completionWithUsage({ providerId: "openrouter", modelId: "glm-4.7" }, [{ role: "user", content: "Hi" }], { modelId: "glm-4.7", thinking });

    await send(true);
    await send(false);
    await send("off");

    /*
     * THREE STATES, AND THE MIDDLE ONE IS NOT A DENIAL.
     *
     * GLM 4.7 is a hybrid reasoning model. Omitting `reasoning` accepts
     * whatever the endpoint does by default, which may well be reasoning —
     * billed as output tokens, at output prices, for a roleplay reply that
     * never shows it. The empty-reply retry in the chat route relied on `false`
     * meaning "ask for none" and so, having watched one envelope go entirely on
     * thinking, asked for precisely the same thing again.
     */
    expect(bodies[0].reasoning).toEqual({ enabled: true });
    expect(bodies[1].reasoning).toBeUndefined();
    expect(bodies[2].reasoning).toEqual({ enabled: false });
  });

  it("sends no cost policy at all when an operator reverts to auto", async () => {
    enableOpenRouter();
    vi.stubEnv("PROVIDER_ROUTING_MODE", "auto");
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "gen-2", model: "z-ai/glm-4.7", choices: [{ message: { content: "ok" } }], usage: {} });
    }));

    await completionWithUsage({ providerId: "openrouter", modelId: "glm-4.7" }, [{ role: "user", content: "Hi" }], { modelId: "glm-4.7" });
    /*
     * NO POOL, NO CEILING — AND THE PRIVACY FLOOR STAYS.
     *
     * The kill switch reverts the routing experiment, which is a decision about
     * money and availability. It is not consent, given on every reader's
     * behalf at three in the morning, to have their transcripts trained on. A
     * revert that also switched that off would be a trap laid for whoever pulls
     * it under pressure.
     */
    expect(bodies[0].provider).toEqual({ allow_fallbacks: true, data_collection: "deny" });
  });
});

describe("the GLM cost ceiling", () => {
  it("is declared on the model rather than compared by name in the request builder", () => {
    const ceiling = modelCapabilities("openrouter", "glm-4.7").costCeiling;
    expect(ceiling).toBeDefined();
    // Above Z.AI (0.60 / 2.20), the dearest of the three endpoints worth
    // keeping, and below the ~2.65/M output endpoints this exists to exclude.
    expect(ceiling?.promptUsdPerMillion).toBeGreaterThan(0.6);
    expect(ceiling?.completionUsdPerMillion).toBeGreaterThan(2.2);
    expect(ceiling?.completionUsdPerMillion).toBeLessThan(2.65);
  });

  it("leaves models that declare no ceiling exactly as they were", () => {
    // The guard is per-model data, so adding it to GLM must not have changed
    // how anything else is routed.
    expect(costPolicyFor("midnight-cherry")).toBeNull();
    // Midnight Cherry declares neither a ceiling nor a privacy floor, so it is
    // routed exactly as it was before any of this existed.
    expect(providerPolicyFor("midnight-cherry", 0, [])).toBeNull();
    expect(providerPolicyFor("mimo-v2.5", 0, [])).toEqual({ order: ["xiaomi"], allowFallbacks: true, dataCollection: "deny" });
  });
});

describe("the warm path", () => {
  it("states a ceiling and then gets out of OpenRouter's way", () => {
    const policy = providerPolicyFor("glm-4.7", 0, []);
    expect(policy?.maxPrice).toEqual({ prompt: 0.65, completion: 2.25 });
    expect(policy?.allowFallbacks).toBe(true);
    /*
     * THE POINT OF THE WHOLE DESIGN.
     *
     * OpenRouter pins a conversation to the host holding its prompt cache from
     * the `session_id` the chat route sends, and its documentation says that
     * setting `order` turns that routing off. A policy that named DeepInfra
     * first would therefore buy a cheaper LIST price by throwing away the cache
     * that makes the real price cheap — and cached input is a fifth of fresh
     * input, so that trade loses badly. The cheapest request is the one that
     * hits.
     */
    expect(policy?.order).toBeUndefined();
    expect(policy?.sort).toBeUndefined();
    /*
     * `only` IS SENT, AND `order` IS NOT, AND THE DIFFERENCE IS THE DESIGN.
     *
     * OpenRouter documents that naming an explicit `provider.order` turns its
     * own sticky routing off — which would throw away the warm cache that makes
     * a long conversation cheap. Restricting the CANDIDATE SET with `only`
     * bounds which endpoints may be chosen without stating a preference between
     * them, so whichever pool member a conversation is already warm on stays
     * warm. Two adjacent fields, opposite effects on the thing that costs
     * money.
     */
    expect(policy?.only).toEqual(["deepinfra", "novita", "z-ai"]);
  });

  it("asks for the cheapest endpoint outright only in cost_optimized", () => {
    vi.stubEnv("PROVIDER_ROUTING_MODE", "cost_optimized");
    expect(providerPolicyFor("glm-4.7", 0, [])?.sort).toBe("price");
  });
});

describe("recovery stays inside the affordable set", () => {
  it("keeps the ceiling on a retry, and still routes away from the failed host", () => {
    const retry = providerPolicyFor("glm-4.7", 1, ["z-ai"]);
    expect(retry?.ignore).toEqual(["z-ai"]);
    expect(retry?.only).toEqual(["deepinfra", "novita", "z-ai"]);
    // The bug this closes: `sort: throughput` with no ceiling could answer a
    // timeout by moving the conversation to the most expensive host serving the
    // slug, at the moment nobody was watching, and stickiness would keep it
    // there for every following turn.
    expect(retry?.maxPrice).toEqual({ prompt: 0.65, completion: 2.25 });
    // Throughput sorting is kept: this attempt has already lost its cache, so
    // the fastest AFFORDABLE host is the right answer.
    expect(retry?.sort).toBe("throughput");
  });

  it("never substitutes a different model to recover", () => {
    // Guarded here because it is the one invariant of this whole file that a
    // reader would notice and could not consent to. Every policy is a different
    // way to reach the SAME slug.
    for (const attempt of [0, 1, 2]) {
      const policy = providerPolicyFor("glm-4.7", attempt, ["deepinfra"]);
      expect(policy).not.toBeNull();
      expect(Object.keys(policy ?? {})).not.toContain("model");
    }
  });

  it("keeps the ceiling and the pool on the FINAL attempt too", () => {
    /*
     * THE CORRECTION. The previous sprint let the last attempt lift the price
     * ceiling, on the argument that one dear generation beats a failed turn
     * mid-scene. The argument is real; the DEFAULT was wrong. It converted a
     * provider outage — which happens at the hour nobody is watching — into
     * unbounded spend with no operator decision anywhere in it.
     *
     * So every attempt now stays the same model, inside the approved pool,
     * under the ceiling, and an exhausted pool produces an honest "temporarily
     * unavailable" rather than a surprise on the invoice.
     */
    const last = providerPolicyFor("glm-4.7", 2, ["deepinfra", "novita"], { finalAttempt: true });
    expect(last?.maxPrice).toEqual({ prompt: 0.65, completion: 2.25 });
    expect(last?.only).toEqual(["deepinfra", "novita", "z-ai"]);
    expect(last?.ignore).toEqual(["deepinfra", "novita"]);
    expect(last?.allowFallbacks).toBe(true);
  });

  it("defaults the emergency expensive fallback to off", () => {
    expect(emergencyExpensiveFallbackEnabled()).toBe(false);
    // A typo, an empty string or the word "yes" are all not-true, and a guard
    // that spends money must only be lifted by the exact word that lifts it.
    vi.stubEnv("GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK", "yes");
    expect(emergencyExpensiveFallbackEnabled()).toBe(false);
  });

  it("lifts the ceiling on the final attempt only when an operator has asked", () => {
    vi.stubEnv("GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK", "true");
    const last = providerPolicyFor("glm-4.7", 2, ["deepinfra"], { finalAttempt: true });
    expect(last?.maxPrice).toBeUndefined();
    expect(last?.only).toBeUndefined();
    /*
     * AND EVEN THEN, NOT THE PRIVACY FLOOR.
     *
     * An emergency that is permitted to spend more money is not thereby
     * permitted to send somebody's private roleplay to an endpoint that trains
     * on it. The two policies travel together in the request and separately in
     * the reasoning, and only one of them is economic.
     */
    expect(last?.dataCollection).toBe("deny");
  });
});

describe("the kill switch", () => {
  it("defaults to guarding rather than to trusting a deployment variable", () => {
    expect(routingMode()).toBe("cost_guarded");
    vi.stubEnv("PROVIDER_ROUTING_MODE", "nonsense-value");
    // A typo must not quietly restore the behaviour this was added to prevent.
    expect(routingMode()).toBe("cost_guarded");
    expect(providerPolicyFor("glm-4.7", 0, [])?.maxPrice).toBeDefined();
  });

  it("reverts to the pre-sprint behaviour without a deploy", () => {
    vi.stubEnv("PROVIDER_ROUTING_MODE", "auto");
    /*
     * `auto` reverts the COST policy and nothing else.
     *
     * The privacy floor stays, and that is deliberate: an operator reverting a
     * routing experiment at three in the morning is making a decision about
     * money and availability, not consenting on every reader's behalf to have
     * their transcripts trained on. A kill switch that also switched that off
     * would be a trap.
     */
    expect(providerPolicyFor("glm-4.7", 0, [])).toEqual({ allowFallbacks: true, dataCollection: "deny" });
    expect(providerPolicyFor("glm-4.7", 1, ["z-ai"])).toEqual({ ignore: ["z-ai"], allowFallbacks: true, sort: "throughput", dataCollection: "deny" });
  });
});

describe("the approved provider pool", () => {
  it("requires cache capability, not only affordability", () => {
    /*
     * WHY THE POOL EXISTS AT ALL, stated as a test so it cannot be quietly
     * dropped back to a ceiling.
     *
     * `max_price` bounds what an endpoint may LIST. It says nothing about
     * whether that endpoint discounts a prompt-cache read — and a roleplay turn
     * resends the character, world, persona and rules unchanged, so cached
     * reads are most of the bill. An endpoint that passes the ceiling and
     * charges fresh prices for every repeated byte defeats the whole objective
     * while satisfying the guard.
     */
    expect(modelCapabilities("openrouter", "glm-4.7").cacheCapableProviders).toEqual(["deepinfra", "novita", "z-ai"]);
    expect(approvedProviderPool("glm-4.7")).toEqual(["deepinfra", "novita", "z-ai"]);
  });

  it("is enforced by default, and revertible without a deploy", () => {
    expect(providerPolicyFor("glm-4.7", 0, [])?.only).toEqual(["deepinfra", "novita", "z-ai"]);
    /*
     * The risk the previous sprint named has not gone away: a slug that is
     * wrong or renamed upstream turns `only` into an outage rather than a
     * degraded route. It is answered with an escape hatch instead of a weaker
     * default — the pool goes advisory and the ceiling still guards spend.
     */
    vi.stubEnv("ENFORCE_PROVIDER_POOL", "false");
    const advisory = providerPolicyFor("glm-4.7", 0, []);
    expect(advisory?.only).toBeUndefined();
    expect(advisory?.maxPrice).toEqual({ prompt: 0.65, completion: 2.25 });
  });

  it("lets an operator replace one model's pool from the environment", () => {
    // The three-in-the-morning control: a provider is renamed or starts
    // failing, and the pool is corrected from a dashboard rather than a release.
    vi.stubEnv("PROVIDER_POOL_OVERRIDE", "glm-4.7:deepinfra|novita");
    expect(approvedProviderPool("glm-4.7")).toEqual(["deepinfra", "novita"]);
    expect(providerPolicyFor("glm-4.7", 0, [])?.only).toEqual(["deepinfra", "novita"]);
    // An override for another model does not touch this one.
    vi.stubEnv("PROVIDER_POOL_OVERRIDE", "mimo-v2.5:xiaomi");
    expect(approvedProviderPool("glm-4.7")).toEqual(["deepinfra", "novita", "z-ai"]);
  });

  it("refuses to route a private roleplay through an endpoint that trains on it", () => {
    // Sent as an OpenRouter provider preference rather than enforced by
    // comparing provider names here, so the filter keeps working when a
    // provider changes its policy — which is a thing that happens without
    // anybody telling us.
    expect(providerPolicyFor("glm-4.7", 0, [])?.dataCollection).toBe("deny");
    expect(providerPolicyFor("glm-4.7", 1, ["z-ai"])?.dataCollection).toBe("deny");
  });
});
