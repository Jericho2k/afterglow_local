import { afterEach, describe, expect, it, vi } from "vitest";
import { approvedProviderPool, availableModels, catalogModelIds, dedicatedProviderFor, modelCapabilities, providerPolicyFor } from "@/lib/provider";
import { classifyProviderFailure, publicErrorMessage, ProviderError } from "@/lib/provider-errors";
import { completionWithUsage } from "@/lib/llm";

/**
 * ONE GLM 5.3 FLASH, SERVED BY ONE HOST.
 *
 * The catalogue used to offer this model twice — "Fast" and "Economy" — as two
 * serving profiles of identical weights behind an identical slug, and each of
 * them routed across a pool of several upstream hosts. Two things were wrong
 * with that at once, and this file exists to stop either coming back quietly.
 *
 *   THE CHOICE WAS UNANSWERABLE. The premise separating the profiles — one host
 *   cheap-and-slow, another dear-and-fast — was never measured from this
 *   deployment, so a reader picking between them was picking between two
 *   sentences. The shelves, the labels and the picker tag all implied a
 *   difference nobody could describe.
 *
 *   THE WRITER WAS NOT STABLE. A pool of five hosts serving one slug is five
 *   quantisations, samplers and truncation behaviours, chosen per request by
 *   somebody else's router. "Why did this reply come out differently" had no
 *   answer, and neither did "which writer wrote my story".
 *
 * So: one catalogue entry, `provider.only: ["z-ai"]`, fallbacks off, and no
 * `order` or `sort` on any attempt. When Z.AI cannot serve the model, the model
 * is unavailable and the reader is told so — which is the assertion at the
 * bottom of this file, and the one that costs something to keep.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function enableOpenRouter() {
  vi.stubEnv("ENABLE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
  vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.test/api/v1");
  vi.stubEnv("ALLOWED_MODELS", "glm-5.3-flash");
}

/** Collects every request body the adapter sends, and answers each one. */
function captureRequests(respond: (attempt: number) => Response) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return respond(bodies.length - 1);
  }));
  return bodies;
}

const ok = () => Response.json({
  id: "gen-1", model: "z-ai/glm-5.3-flash", provider: "Z.AI",
  choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 },
});

describe("the catalogue exposes exactly one GLM 5.3", () => {
  it("has one entry, one label, and no serving profile anywhere near it", () => {
    expect(catalogModelIds().filter((id) => id.startsWith("glm-5.3"))).toEqual(["glm-5.3-flash"]);
    enableOpenRouter();
    vi.stubEnv("ALLOWED_MODELS", "");
    const glm53 = availableModels().filter((model) => model.label.includes("GLM 5.3"));
    expect(glm53.map((model) => model.label)).toEqual(["GLM 5.3 Flash"]);
    // The picker rendered a "Fast"/"Economy" tag from this field. Both the tag
    // and the field are gone, so a reader is never asked about an endpoint.
    expect(glm53[0]).not.toHaveProperty("speedProfile");
  });

  it("keeps the properties a long story depends on", () => {
    const capabilities = modelCapabilities("openrouter", "glm-5.3-flash");
    // Prompt caching is worth MORE under a single host than it was under a
    // pool: one host is one cache, so the sticky session has somewhere to stick.
    expect(capabilities.promptCaching).toBe(true);
    // The model reasons before it speaks, with a measured time to first token
    // in the tens of seconds. `thinking` says the endpoint accepts the
    // parameter; `reasoningDefault` says what production sends.
    expect(capabilities.thinking).toBe(true);
    expect(capabilities.reasoningDefault).toBe("off");
    // The ceiling stays as defence in depth, from the LIST price rather than
    // the launch discount that expires.
    expect(capabilities.costCeiling).toEqual({ promptUsdPerMillion: 0.20, completionUsdPerMillion: 0.60 });
    expect(capabilities.dataPolicy).toEqual({ dataCollection: "deny" });
    expect(capabilities.contextTokens).toBe(1_310_720);
  });
});

describe("production routing is Z.AI and nothing else", () => {
  it("sends only, with fallbacks off, and neither order nor sort", () => {
    expect(dedicatedProviderFor("glm-5.3-flash")).toBe("z-ai");
    expect(approvedProviderPool("glm-5.3-flash")).toEqual(["z-ai"]);

    const policy = providerPolicyFor("glm-5.3-flash", 0, []);
    expect(policy?.only).toEqual(["z-ai"]);
    expect(policy?.allowFallbacks).toBe(false);
    /*
     * `order` AND `sort` ARE BOTH WAYS OF CHOOSING BETWEEN CANDIDATES.
     *
     * There is one candidate, so neither can express anything — and OpenRouter
     * documents that either turns its own sticky session routing off, which is
     * the routing the prompt cache depends on. Sending them would cost the
     * cache to say nothing.
     */
    expect(policy?.order).toBeUndefined();
    expect(policy?.sort).toBeUndefined();
    // The guards travel with it. Neither can widen the route; both can still
    // refuse it, which is the direction a guard may fail in.
    expect(policy?.maxPrice).toEqual({ prompt: 0.20, completion: 0.60 });
    expect(policy?.dataCollection).toBe("deny");
  });

  it("stays on Z.AI for every attempt, and never excludes the only host it has", () => {
    for (const attempt of [0, 1, 2]) {
      const policy = providerPolicyFor("glm-5.3-flash", attempt, ["z-ai"], { finalAttempt: attempt === 2 });
      expect(policy?.only, `attempt ${attempt}`).toEqual(["z-ai"]);
      expect(policy?.allowFallbacks, `attempt ${attempt}`).toBe(false);
      expect(policy?.sort, `attempt ${attempt}`).toBeUndefined();
      /*
       * `ignore` WOULD TURN A RETRY INTO A GUARANTEED FAILURE.
       *
       * Excluding the host that just failed is the right move when others
       * serve the model. Here it would empty the candidate set, so the retry
       * could only ever come back "no allowed providers" — a self-inflicted
       * outage in the name of recovering from one. Retrying the same host is
       * what a transient 5xx deserves.
       */
      expect(policy?.ignore, `attempt ${attempt}`).toBeUndefined();
    }
  });

  it("is not a cost policy, and no cost switch may re-open the other hosts", () => {
    /*
     * THE ESCAPE HATCHES ARE ABOUT MONEY AND AVAILABILITY. Which writer wrote
     * somebody's story is neither. An operator reverting the price ceiling at
     * three in the morning is not deciding that a different serving profile may
     * answer under the same name, and none of these may make that decision for
     * them.
     */
    vi.stubEnv("PROVIDER_ROUTING_MODE", "auto");
    expect(providerPolicyFor("glm-5.3-flash", 0, [])).toEqual({ only: ["z-ai"], allowFallbacks: false, dataCollection: "deny" });

    vi.stubEnv("PROVIDER_ROUTING_MODE", "cost_optimized");
    const optimized = providerPolicyFor("glm-5.3-flash", 0, []);
    // Even the mode that asks for the cheapest endpoint outright has nothing to
    // sort: one candidate is one price.
    expect(optimized?.sort).toBeUndefined();
    expect(optimized?.only).toEqual(["z-ai"]);

    vi.stubEnv("PROVIDER_ROUTING_MODE", "cost_guarded");
    vi.stubEnv("ENFORCE_PROVIDER_POOL", "false");
    expect(providerPolicyFor("glm-5.3-flash", 0, [])?.only).toEqual(["z-ai"]);

    vi.stubEnv("GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK", "true");
    const emergency = providerPolicyFor("glm-5.3-flash", 2, ["z-ai"], { finalAttempt: true });
    expect(emergency?.only).toEqual(["z-ai"]);
    expect(emergency?.allowFallbacks).toBe(false);
  });

  it("still lets a benchmark measure another host, deliberately and only then", () => {
    // Preserved on purpose: comparing Z.AI against an alternative means being
    // able to reach the alternative. It takes TWO variables set together, so a
    // pin left behind in a deployment is inert.
    vi.stubEnv("PIN_UPSTREAM_PROVIDER", "glm-5.3-flash:novita");
    expect(providerPolicyFor("glm-5.3-flash", 0, [])?.only).toEqual(["z-ai"]);

    vi.stubEnv("PROVIDER_ROUTING_MODE", "benchmark");
    expect(providerPolicyFor("glm-5.3-flash", 0, [])).toEqual({ only: ["novita"], allowFallbacks: false });
  });

  it("lets an operator move the host without a deploy, still exclusively", () => {
    // The three-in-the-morning control: Z.AI is renamed or down for a day, and
    // the route is corrected from a dashboard. It is still ONE host with
    // fallbacks off — an override moves the dedication, it does not dissolve it.
    vi.stubEnv("PROVIDER_POOL_OVERRIDE", "glm-5.3-flash:novita");
    expect(providerPolicyFor("glm-5.3-flash", 0, [])).toMatchObject({ only: ["novita"], allowFallbacks: false });
  });

  it("leaves every pooled model exactly as it was", () => {
    // The dedication is per-model data, so adding it must not have changed how
    // anything else is routed.
    expect(dedicatedProviderFor("glm-4.7")).toBeNull();
    expect(providerPolicyFor("glm-4.7", 0, [])).toEqual({
      only: ["deepinfra", "novita", "z-ai"], allowFallbacks: true,
      maxPrice: { prompt: 0.65, completion: 2.25 }, dataCollection: "deny",
    });
    expect(providerPolicyFor("mimo-v2.5", 0, [])).toEqual({ order: ["xiaomi"], allowFallbacks: true, dataCollection: "deny" });
  });
});

describe("what actually leaves the process", () => {
  it("puts Z.AI, no fallbacks, and the sticky session on the wire", async () => {
    enableOpenRouter();
    const bodies = captureRequests(ok);

    await completionWithUsage({ providerId: "openrouter", modelId: "glm-5.3-flash" },
      [{ role: "user", content: "Hi" }], { modelId: "glm-5.3-flash", sessionId: "conversation-42", thinking: "off" });

    expect(bodies[0].model).toBe("z-ai/glm-5.3-flash");
    expect(bodies[0].provider).toEqual({
      only: ["z-ai"],
      allow_fallbacks: false,
      max_price: { prompt: 0.20, completion: 0.60 },
      data_collection: "deny",
    });
    // A policy object that is correct and then dropped on the way to `fetch`
    // guards nothing, so the absence of these two is asserted on the bytes.
    expect(bodies[0].provider).not.toHaveProperty("order");
    expect(bodies[0].provider).not.toHaveProperty("sort");
    /*
     * THE SESSION SURVIVED THE SIMPLIFICATION.
     *
     * `session_id` is what keeps a conversation on the host holding its prompt
     * cache, and a roleplay turn resends the character, world, persona and
     * rules unchanged — so the cached read is most of what a long story pays.
     * A single host makes it matter more, not less.
     */
    expect(bodies[0].session_id).toBe("conversation-42");
    expect(bodies[0].reasoning).toEqual({ enabled: false });
  });

  it("keeps the same host across the retries it is allowed", async () => {
    enableOpenRouter();
    const bodies = captureRequests((attempt) => attempt === 0
      ? new Response(JSON.stringify({ error: { message: "upstream busy" } }), { status: 503 })
      : ok());

    await completionWithUsage({ providerId: "openrouter", modelId: "glm-5.3-flash" },
      [{ role: "user", content: "Hi" }], { modelId: "glm-5.3-flash" });

    expect(bodies).toHaveLength(2);
    // The retry is the same model on the same host. It is emphatically not a
    // second chance for another serving profile to answer.
    expect(bodies[1].model).toBe(bodies[0].model);
    expect(bodies[1].provider).toEqual(bodies[0].provider);
  });
});

describe("when Z.AI cannot serve it", () => {
  /*
   * THE POINT OF ALL OF THE ABOVE, AND THE PART THAT COSTS SOMETHING.
   *
   * `only: ["z-ai"]` with fallbacks off means an outage at one host is an
   * outage for the model. That is the deliberate trade: the alternative is a
   * different writer answering under the same name, which is cheaper for us and
   * a substitution the reader never agreed to.
   *
   * What it must never be is an ugly failure. OpenRouter answers 404 with "No
   * allowed providers are available for the selected model", which has to
   * classify as temporarily-unavailable rather than as a malformed request —
   * the two are the same status code and only the body tells them apart.
   */
  const noProviders = JSON.stringify({
    error: { message: "No allowed providers are available for the selected model.", code: 404 },
  });

  it("reads as temporarily unavailable rather than as a bug", () => {
    expect(classifyProviderFailure(404, noProviders)).toBe("upstream_unavailable");
    expect(new ProviderError("upstream_unavailable").retryable).toBe(true);
  });

  it("tells the reader one calm sentence and never names infrastructure", async () => {
    enableOpenRouter();
    captureRequests(() => new Response(noProviders, { status: 404 }));

    const failure = await completionWithUsage({ providerId: "openrouter", modelId: "glm-5.3-flash" },
      [{ role: "user", content: "Hi" }], { modelId: "glm-5.3-flash" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).category).toBe("upstream_unavailable");
    expect(publicErrorMessage(failure)).toBe("The model is temporarily unavailable. Please try again in a moment.");
    // The upstream body is diagnostic only. "z-ai", "providers" and a status
    // code are the operator's business and never the reader's.
    expect(publicErrorMessage(failure)).not.toMatch(/z-ai|provider|404/i);
  });
});
