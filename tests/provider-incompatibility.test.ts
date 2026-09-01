import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { classifyProviderFailure, providerSpecificRejection } from "@/lib/provider-errors";
import { approvedProviderPool, costPolicyFor, dataPolicyFor, defaultReasoningFor, modelCapabilities, providerModelId } from "@/lib/provider";

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
   * nothing at all, so GLM 5.3 Flash's `reasoningDefault: "off"` — added
   * because that model reasons before it speaks, with a measured
   * time-to-first-token in the tens of seconds — had no effect on any request.
   * The chat route now consults it; this is the contract it consults.
   */
  it("declines reasoning for the models that declare they should", () => {
    expect(defaultReasoningFor("glm-5.3-flash")).toBe("off");
    expect(defaultReasoningFor("glm-5.3-flash-economy")).toBe("off");
  });

  it("says nothing for a model that declares no default", () => {
    expect(defaultReasoningFor("glm-4.7")).toBe(null);
  });

  it("still lets a deployment decline reasoning everywhere", () => {
    vi.stubEnv("RP_REASONING", "off");
    expect(defaultReasoningFor("glm-4.7")).toBe("off");
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
    vi.stubEnv("ALLOWED_MODELS", "glm-5.3-flash,glm-5.3-flash-economy,glm-4.7");
  });

  const script = readFileSync(new URL("../scripts/provider-constraint-bisect.mjs", import.meta.url), "utf8");
  const body = script.slice(script.indexOf("export const constraints = {"));
  type MirroredConstraints = {
    upstreamModel: string; reasoning: string | null; dataCollection: string | null; zdr: boolean;
    maxPrice: { prompt: number; completion: number }; only: string[]; order: string[];
  };

  function evalConstraints(source: string): Record<string, MirroredConstraints> {
    const literal = source.slice(source.indexOf("{"), source.indexOf("\n};") + 2);
    return Function(`"use strict"; return (${literal});`)() as Record<string, MirroredConstraints>;
  }

  const mirrored = evalConstraints(body);

  it("mirrors at least the models the sprint is debugging", () => {
    for (const id of ["glm-5.3-flash", "glm-5.3-flash-economy", "glm-4.7"]) {
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
    });
  }
});
