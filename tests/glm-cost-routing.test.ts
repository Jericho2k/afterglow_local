import { afterEach, describe, expect, it, vi } from "vitest";
import { costPolicyFor, modelCapabilities, providerPolicyFor, routingMode } from "@/lib/provider";
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
    expect(bodies[0].provider).toEqual({ allow_fallbacks: true, max_price: { prompt: 0.65, completion: 2.25 } });
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

  it("sends no provider block at all when an operator reverts to auto", async () => {
    enableOpenRouter();
    vi.stubEnv("PROVIDER_ROUTING_MODE", "auto");
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "gen-2", model: "z-ai/glm-4.7", choices: [{ message: { content: "ok" } }], usage: {} });
    }));

    await completionWithUsage({ providerId: "openrouter", modelId: "glm-4.7" }, [{ role: "user", content: "Hi" }], { modelId: "glm-4.7" });
    expect(bodies[0].provider).toBeUndefined();
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
    expect(providerPolicyFor("midnight-cherry", 0, [])).toBeNull();
    expect(providerPolicyFor("mimo-v2.5", 0, [])).toEqual({ order: ["xiaomi"], allowFallbacks: true });
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
    expect(policy?.only).toBeUndefined();
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

  it("lifts the ceiling only on the final attempt, as an emergency", () => {
    // Two attempts have already been spent inside the affordable set, so
    // reaching here means every endpoint under the ceiling failed or went
    // quiet. One dear generation beats a failed turn mid-scene.
    const last = providerPolicyFor("glm-4.7", 2, ["deepinfra", "novita"], { finalAttempt: true });
    expect(last?.maxPrice).toBeUndefined();
    expect(last?.ignore).toEqual(["deepinfra", "novita"]);
    expect(last?.allowFallbacks).toBe(true);
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
    // Byte-for-byte what GLM got before: no policy at all on the warm path.
    expect(providerPolicyFor("glm-4.7", 0, [])).toBeNull();
    expect(providerPolicyFor("glm-4.7", 1, ["z-ai"])).toEqual({ ignore: ["z-ai"], allowFallbacks: true, sort: "throughput" });
  });
});

describe("the provider allowlist", () => {
  it("stays advisory until an operator has verified the slugs", () => {
    // These could not be checked against OpenRouter's live endpoint list from
    // the build environment, and a wrong slug in `provider.only` is not a
    // degraded route — it is every GLM request failing.
    expect(modelCapabilities("openrouter", "glm-4.7").affordableProviders).toEqual(["deepinfra", "novita", "z-ai"]);
    expect(providerPolicyFor("glm-4.7", 0, [])?.only).toBeUndefined();
  });

  it("becomes a hard restriction when one has", () => {
    vi.stubEnv("ENFORCE_PROVIDER_ALLOWLIST", "true");
    const policy = providerPolicyFor("glm-4.7", 0, []);
    expect(policy?.only).toEqual(["deepinfra", "novita", "z-ai"]);
    // Belt and braces: the ceiling stays on, so a re-priced endpoint inside the
    // allowlist is still excluded.
    expect(policy?.maxPrice).toBeDefined();
  });
});
