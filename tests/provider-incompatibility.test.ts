import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adaptableRejection, classifyProviderFailure, providerSpecificRejection } from "@/lib/provider-errors";
import { approvedProviderPool, costPolicyFor, dataPolicyFor, defaultReasoningFor, modelCapabilities, providerModelId, providerPolicyFor, reasoningIsMandatoryFor } from "@/lib/provider";
import { streamCompletion } from "@/lib/llm";

/**
 * A 400 is not always a bug in the request.
 *
 * OpenRouter routes one model across many upstreams and they do not accept the
 * same parameters, so a host that does not implement `reasoning` answers 400
 * for a request the host beside it serves happily. Treating every 400 as
 * "Afterglow sent something malformed" turns one incompatible endpoint into an
 * outage for the whole model — and hands the reader "Something went wrong while
 * generating the response" for a request that had somewhere perfectly good to go.
 */

describe("telling a host's refusal from a malformed request", () => {
  const relayed = (message: string) => JSON.stringify({
    error: { message: "Provider returned error", code: 400, metadata: { provider_name: "SomeHost", raw: message } },
  });

  it("retries elsewhere for a relayed capability complaint", () => {
    for (const body of [
      relayed("reasoning is not supported by this deployment"),
      relayed("unknown parameter: reasoning"),
      relayed("Extra inputs are not permitted"),
      relayed("model does not accept the `reasoning` field"),
    ]) {
      expect(providerSpecificRejection(400, body), body).toBe(true);
      // The category is unchanged: it is still a bad request, and the reader
      // still gets the bad-request sentence if every host refuses.
      expect(classifyProviderFailure(400, body)).toBe("bad_request");
    }
  });

  it("does not retry a request Afterglow itself built wrongly", () => {
    for (const body of [
      // OpenRouter's own validation. No upstream identity anywhere in it.
      JSON.stringify({ error: { message: "messages: field required", code: 400 } }),
      JSON.stringify({ error: { message: "max_tokens must be a positive integer", code: 400 } }),
      "",
    ]) {
      expect(providerSpecificRejection(400, body), body).toBe(false);
    }
  });

  it("does not retry a relayed refusal that is not about parameters", () => {
    // A content policy refusal comes from an upstream too, and asking a
    // different upstream the same question is a waste of the reader's time.
    expect(providerSpecificRejection(400, relayed("content violates usage policy"))).toBe(false);
  });

  it("leaves statuses that already have a retry answer alone", () => {
    for (const status of [401, 402, 429, 500, 503]) {
      expect(providerSpecificRejection(status, JSON.stringify({ provider_name: "X", message: "not supported" }))).toBe(false);
    }
  });
});

describe("what a model says about reasoning is what gets sent", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  /*
   * `defaultReasoningFor` shipped with the model expansion and was called by
   * nothing at all, so a `reasoningDefault` added because a model reasons
   * before it speaks — a measured time-to-first-token in the tens of seconds —
   * had no effect on any request. The chat route now consults it; this is the
   * contract it consults.
   */
  it("declines reasoning for the models that declare they should", () => {
    expect(defaultReasoningFor("qwen3.8-flash")).toBe("off");
  });

  /*
   * AND ASKS FOR THE LEAST, WHERE NONE IS NOT ON OFFER.
   *
   * Z.AI answered GLM 5.3 Flash's `reasoning: {enabled:false}` with 400
   * "Reasoning is mandatory for this endpoint and cannot be disabled". The
   * adapter then dropped the parameter and asked again, which takes the
   * ENDPOINT'S default — the most reasoning, not the least — so the catalogue's
   * intention was inverted at the cost of two requests and a reader's wait,
   * every single turn. An effort level is the same intention in a shape this
   * endpoint will serve, and it is served on the FIRST attempt.
   */
  it("names an effort where an endpoint refuses to be told no", () => {
    expect(defaultReasoningFor("glm-5.3-flash")).toBe("low");
    expect(reasoningIsMandatoryFor("glm-5.3-flash")).toBe(true);
    // And nowhere else: this is one endpoint's contract, not a house style.
    expect(reasoningIsMandatoryFor("qwen3.8-flash")).toBe(false);
    expect(reasoningIsMandatoryFor("glm-4.7")).toBe(false);
  });

  it("says nothing for a model that declares no default", () => {
    expect(defaultReasoningFor("glm-4.7")).toBe(null);
  });

  it("still lets a deployment decline reasoning everywhere it can be declined", () => {
    vi.stubEnv("RP_REASONING", "off");
    expect(defaultReasoningFor("glm-4.7")).toBe("off");
    expect(defaultReasoningFor("qwen3.8-flash")).toBe("off");
    /*
     * EXCEPT WHERE THE ENDPOINT HAS ALREADY REFUSED.
     *
     * The switch is an operator saying "spend nothing on thinking"; it is not
     * an operator asking to send a request we know answers 400 and recovers by
     * taking the endpoint's own maximum. Honouring it literally here would
     * rebuild the exact failure `reasoningMandatory` records, so the model's
     * declared floor — the least this endpoint serves — stands instead.
     */
    expect(defaultReasoningFor("glm-5.3-flash")).toBe("low");
  });

  it("lets a deployment put the request shape back without a deploy", () => {
    /*
     * Wiring `reasoningDefault` in changed what leaves the process: a
     * `reasoning` key now appears in requests to GLM 5.3 Flash that previously
     * carried none. An endpoint that rejects a parameter it does not implement
     * answers 400, which reaches a reader as "Something went wrong while
     * generating the response" — so the change needs an off switch that does
     * not need a release, exactly like every other routing switch here.
     */
    vi.stubEnv("RP_REASONING", "auto");
    expect(defaultReasoningFor("glm-5.3-flash")).toBe(null);
    expect(defaultReasoningFor("qwen3.8-flash")).toBe(null);
    // And a model that never declared one is unaffected either way.
    expect(defaultReasoningFor("glm-4.7")).toBe(null);
  });

  it("ignores a value it does not recognise rather than guessing", () => {
    // A typo in a deployment variable must not silently change behaviour.
    vi.stubEnv("RP_REASONING", "yes");
    expect(defaultReasoningFor("glm-5.3-flash")).toBe("low");
    expect(defaultReasoningFor("qwen3.8-flash")).toBe("off");
  });
});


/**
 * THE BISECT HARNESS MEASURES WHAT PRODUCTION SENDS, OR IT MEASURES NOTHING.
 *
 * `scripts/provider-constraint-bisect.mjs` adds one routing constraint at a
 * time to find the first that turns a working request into a failing one, and
 * it has to run from a plain Node with no build step — so it cannot import
 * `src/lib/provider.ts`, and mirrors the catalogue by hand instead.
 *
 * A hand mirror that drifts is worse than no harness: it produces a confident
 * answer about a policy nobody ships. So the mirror is checked here, field by
 * field, against the catalogue itself.
 */
describe("the constraint bisect mirrors the real routing policy", () => {
  /*
   * `providerModelId` answers about an ENABLED model, so the catalogue has to be
   * switched on for the comparison to have anything to compare against. Per
   * test rather than per suite, because the file-level `afterEach` unstubs.
   */
  beforeEach(() => {
    vi.stubEnv("ENABLE_OPENROUTER", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
    vi.stubEnv("ALLOWED_MODELS", "glm-5.3-flash,glm-4.7");
  });

  const script = readFileSync(new URL("../scripts/provider-constraint-bisect.mjs", import.meta.url), "utf8");
  const body = script.slice(script.indexOf("export const constraints = {"));
  type MirroredConstraints = {
    upstreamModel: string; reasoning: string | null; dataCollection: string | null; zdr: boolean;
    maxPrice: { prompt: number; completion: number }; only: string[]; order: string[]; allowFallbacks: boolean;
  };

  function evalConstraints(source: string): Record<string, MirroredConstraints> {
    const literal = source.slice(source.indexOf("{"), source.indexOf("\n};") + 2);
    return Function(`"use strict"; return (${literal});`)() as Record<string, MirroredConstraints>;
  }

  const mirrored = evalConstraints(body);

  it("mirrors at least the models the sprint is debugging", () => {
    for (const id of ["glm-5.3-flash", "glm-4.7"]) {
      expect(Object.keys(mirrored)).toContain(id);
    }
  });

  for (const [id, entry] of Object.entries(mirrored)) {
    it(`${id} matches the catalogue`, () => {
      expect(entry.upstreamModel).toBe(providerModelId("openrouter", id));
      expect(entry.reasoning).toBe(defaultReasoningFor(id));
      expect(entry.dataCollection).toBe(dataPolicyFor(id)?.dataCollection ?? null);
      expect(entry.zdr).toBe(Boolean(dataPolicyFor(id)?.zdr));
      expect(entry.maxPrice).toEqual(costPolicyFor(id)?.maxPrice);
      expect(entry.only).toEqual(approvedProviderPool(id));
      expect(entry.order).toEqual(modelCapabilities("openrouter", id).preferredProviders ?? []);
      /*
       * A dedicated model's whole point is the field the mirror could not see
       * before: `allow_fallbacks: false`. An arm that pinned `only: ["z-ai"]`
       * while still permitting fallbacks would measure a policy production does
       * not ship, and would come back green on exactly the outage this routing
       * exists to surface.
       */
      expect(entry.allowFallbacks).toBe(providerPolicyFor(id, 0, [])?.allowFallbacks ?? true);
    });
  }
});


/**
 * THE REJECTION THAT REACHED PRODUCTION, VERBATIM.
 *
 * Wiring `reasoningDefault` in made Afterglow send `reasoning: {enabled:false}`
 * to GLM 5.3 Flash where it had previously sent no such key. One endpoint
 * answered:
 *
 *   {"error":{"message":"Reasoning is mandatory for this endpoint and cannot be
 *    disabled.","code":400,"metadata":{"provider_name":null}}}
 *
 * Two separate things then went wrong, and both are asserted here.
 *
 * The wording was not in the capability-complaint list, which only ever
 * described a parameter an endpoint does not SUPPORT — never one it REQUIRES —
 * so the attempt loop broke on attempt 1 and the reader got "Something went
 * wrong while generating the response" for a request other hosts would serve.
 *
 * And failover was the wrong remedy anyway. The endpoint is not refusing to
 * serve the model, it is refusing one parameter; every other host may refuse it
 * too. The answer is to ask again without it.
 */
const mandatoryReasoning = JSON.stringify({
  error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled.", code: 400, metadata: { provider_name: null } },
});

describe("an endpoint that requires the parameter we declined", () => {
  it("is recognised as a capability complaint, not a malformed request", () => {
    expect(providerSpecificRejection(400, mandatoryReasoning)).toBe(true);
    // The category is unchanged; what changed is that the loop no longer stops.
    expect(classifyProviderFailure(400, mandatoryReasoning)).toBe("bad_request");
  });

  it("is answered by dropping the parameter rather than changing host", () => {
    expect(adaptableRejection(400, mandatoryReasoning, true)).toBe("drop_reasoning");
  });

  it("is not adapted when we never sent the parameter", () => {
    // Then the complaint is about something else and dropping nothing helps.
    expect(adaptableRejection(400, mandatoryReasoning, false)).toBe(null);
  });

  it("adapts to the other direction of the same disagreement", () => {
    for (const message of [
      "reasoning is not supported by this deployment",
      "unknown parameter: reasoning",
      "thinking must be enabled for this endpoint",
    ]) {
      expect(adaptableRejection(400, JSON.stringify({ error: { message } }), true), message).toBe("drop_reasoning");
    }
  });

  it("does not adapt a rejection that has nothing to do with reasoning", () => {
    for (const [status, message] of [
      [400, "messages: field required"],
      [400, "content violates usage policy"],
      [402, "insufficient credits"],
      [429, "rate limited"],
    ] as const) {
      expect(adaptableRejection(status, JSON.stringify({ error: { message } }), true), message).toBe(null);
    }
  });
});

/*
 * THE SAFETY NET, NOT THE PRODUCTION PATH — AND THE DISTINCTION IS THE SPRINT.
 *
 * Everything below drives the adaptation deliberately, by passing `thinking:
 * "off"` to the adapter itself. It has to keep working for an endpoint nobody
 * has met yet. What it must no longer BE is how GLM 5.3 Flash gets served: the
 * catalogue now names an effort level, so the first request is valid and this
 * path never fires on that model. See the reasoning contract suite above, and
 * tests/glm-5.3-reasoning.test.ts for the assertion on what production builds.
 */
describe("what the adapter actually sends after being refused", () => {
  function enableOpenRouter() {
    vi.stubEnv("ENABLE_OPENROUTER", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
    vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.test/api/v1");
    vi.stubEnv("ALLOWED_MODELS", "glm-5.3-flash");
  }

  it("retries the same model, same host, without the reasoning key", async () => {
    enableOpenRouter();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      // The endpoint refuses the parameter, once, exactly as production did.
      if ("reasoning" in body) return new Response(mandatoryReasoning, { status: 400 });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));

    await streamCompletion({ providerId: "openrouter", modelId: "glm-5.3-flash" },
      [{ role: "user", content: "Hi" }],
      { modelId: "glm-5.3-flash", thinking: "off", sessionId: "abc123" });

    expect(bodies).toHaveLength(2);
    // Attempt one asked to decline reasoning, because this caller asked it to.
    expect(bodies[0].reasoning).toEqual({ enabled: false });
    // Attempt two dropped it entirely — NOT `enabled: true`, which would be
    // asking for something nobody requested. Absent takes the endpoint's own
    // default, which on an endpoint that mandates reasoning is reasoning.
    expect("reasoning" in bodies[1]).toBe(false);
    // Everything else is identical: same model, same session, same messages.
    expect(bodies[1].model).toBe(bodies[0].model);
    expect(bodies[1].session_id).toBe(bodies[0].session_id);
    expect(bodies[1].messages).toEqual(bodies[0].messages);
  });

  it("does not blame the host for a parameter Afterglow chose", async () => {
    enableOpenRouter();
    const providers: Array<unknown> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { reasoning?: unknown; provider?: { ignore?: unknown } };
      providers.push(body.provider?.ignore);
      if ("reasoning" in body) {
        return new Response(mandatoryReasoning, { status: 400, headers: { "x-openrouter-provider": "relace" } });
      }
      return new Response("data: [DONE]\n\n", { status: 200 });
    }));

    await streamCompletion({ providerId: "openrouter", modelId: "glm-5.3-flash" },
      [{ role: "user", content: "Hi" }], { modelId: "glm-5.3-flash", thinking: "off" });

    // The retry does not exclude the endpoint that refused: it was never the
    // problem, and excluding it would throw away the preferred host over a
    // parameter we are no longer sending.
    expect(providers[1]).toBeUndefined();
  });

  it("still gives up on a genuinely malformed request", async () => {
    enableOpenRouter();
    const calls = vi.fn(async () => new Response(JSON.stringify({ error: { message: "messages: field required", code: 400 } }), { status: 400 }));
    vi.stubGlobal("fetch", calls);

    await expect(streamCompletion({ providerId: "openrouter", modelId: "glm-5.3-flash" },
      [{ role: "user", content: "Hi" }], { modelId: "glm-5.3-flash", thinking: "off" })).rejects.toThrow();
    // One attempt. A bug is not fixed by asking three times.
    expect(calls).toHaveBeenCalledTimes(1);
  });
});
