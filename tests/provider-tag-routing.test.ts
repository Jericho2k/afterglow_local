import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedModels, approvedProviderPool, dedicatedProviderFor, providerModelId,
  pickerModels, providerPolicyFor, resolveModel, safeProviderTag,
} from "@/lib/provider";
import { availabilityForTask, backgroundCandidate } from "@/lib/background-routing";
import { modelPricing } from "@/lib/usage";

/**
 * THE SLASH THAT SILENTLY UNPINNED TWO ROUTES.
 *
 * `safeId` rejects `/`, correctly, for the things it guards: catalogue model
 * ids, environment keys, anything that has to survive being pasted into a
 * variable or a query string. OpenRouter's upstream ROUTING TAGS are not those
 * things — they arrive from a third party's catalogue and several carry a
 * serving-profile suffix after a slash:
 *
 *   open-inference/fp8
 *   relace/fp4
 *
 * Both were rejected. That did not produce an error anywhere: it made
 * `dedicatedProviderFor` answer null and `approvedProviderPool` answer an empty
 * list, so a model deliberately pinned to one host would have been routed by
 * OpenRouter's own default policy instead — a hard pin failing OPEN, quietly,
 * in exactly the direction the pin exists to prevent.
 *
 * This suite holds three things: that the narrow validator accepts the real
 * tags, that it is narrow (a model id is still guarded by the strict rule), and
 * that the pins actually produce `provider.only` with fallbacks off.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.ALLOWED_MODELS;
  delete process.env.ENABLE_OPENROUTER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.BACKGROUND_ROUTE_VERIFIED_UPSTREAMS;
  delete process.env.PROVIDER_ROUTING_MODE;
  delete process.env.PROVIDER_POOL_OVERRIDE;
});

function withOpenRouter() {
  vi.stubEnv("ENABLE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
}

describe("upstream provider tags", () => {
  it("accepts the verified OpenRouter routing tags", () => {
    expect(safeProviderTag("open-inference/fp8")).toBe(true);
    expect(safeProviderTag("relace/fp4")).toBe(true);
  });

  it("still accepts the plain host tags everything else uses", () => {
    for (const tag of ["z-ai", "xiaomi", "deepinfra", "novita", "open-inference", "Fireworks", "together.ai", "lambda_labs"]) {
      expect(safeProviderTag(tag), tag).toBe(true);
    }
  });

  it("refuses everything a routing tag is not", () => {
    for (const bad of [
      "", "/", "/fp8", "relace/", "relace//fp4", "a/b/c/d",
      "..", "../etc", "relace/../fp4", ".hidden", "relace.",
      "open inference/fp8", "relace/fp4\n", "relace/fp4 ", "\"relace\"",
      "relace;drop", "relace|fp4", "relace,fp4", "relace:fp4", "relace?x=1", "https://relace",
      "x".repeat(121),
    ]) {
      expect(safeProviderTag(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  /**
   * THE VALIDATOR IS NARROW, and this is the assertion that keeps it that way.
   *
   * Widening `safeId` would have let a slash into every place it guards, to fix
   * a problem in one of them. `ALLOWED_MODELS` is the visible one: a model id
   * ends up in a catalogue lookup and in an environment variable, and a slashed
   * entry there is still dropped.
   */
  it("does not loosen the identifier rule anywhere else", () => {
    vi.stubEnv("ALLOWED_MODELS", "deepseek-v4-flash,open-inference/fp8,../etc,deepseek-v4-pro");
    expect(allowedModels()).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });
});

describe("the host-pinned 0731 routes", () => {
  it("carries the exact verified tags", () => {
    withOpenRouter();
    expect(dedicatedProviderFor("deepseek-v4-flash-0731-openinference")).toBe("open-inference/fp8");
    expect(dedicatedProviderFor("deepseek-v4-flash-0731-relace")).toBe("relace/fp4");
    // The candidate list and the catalogue must never drift apart: the selector
    // is what unlocks a tag and the catalogue is what sends it.
    expect(backgroundCandidate("deepseek_0731_openinference")?.upstreamProvider).toBe("open-inference/fp8");
    expect(backgroundCandidate("deepseek_0731_relace")?.upstreamProvider).toBe("relace/fp4");
  });

  it("resolves to the one underlying OpenRouter model", () => {
    withOpenRouter();
    for (const id of ["deepseek-v4-flash-0731-openinference", "deepseek-v4-flash-0731-relace"]) {
      expect(resolveModel("openrouter", id), id).toBeTruthy();
      // Three catalogue ids, one upstream slug. The ids differ so that usage,
      // cost and quality separate by host without a join.
      expect(providerModelId("openrouter", id)).toBe("deepseek/deepseek-v4-flash-0731");
    }
  });

  it("routes each one to its host and nowhere else, on every attempt", () => {
    withOpenRouter();
    for (const [id, tag] of [
      ["deepseek-v4-flash-0731-openinference", "open-inference/fp8"],
      ["deepseek-v4-flash-0731-relace", "relace/fp4"],
    ]) {
      expect(approvedProviderPool(id)).toEqual([tag]);
      /*
       * The three properties the brief asks to be kept, asserted on the first
       * attempt AND on the last: a dedicated route does not widen under
       * recovery, which is the whole difference between a pool and a pin.
       */
      for (const attempt of [0, 1, 2]) {
        const policy = providerPolicyFor(id, attempt, ["some-other-host"], { finalAttempt: attempt === 2 });
        expect(policy?.only, `${id} attempt ${attempt}`).toEqual([tag]);
        expect(policy?.allowFallbacks).toBe(false);
        // No `order` and no `sort`: both are ways of choosing between
        // candidates, there is one candidate, and either turns OpenRouter's own
        // sticky session routing — which the prompt cache depends on — off.
        expect(policy?.order).toBeUndefined();
        expect(policy?.sort).toBeUndefined();
        // The guards travel with the pin and are unchanged.
        expect(policy?.maxPrice).toEqual({ prompt: 0.10, completion: 0.40 });
        expect(policy?.dataCollection).toBe("deny");
      }
    }
  });

  it("does not let an emergency or a cost mode re-open the other hosts", () => {
    withOpenRouter();
    // Both of the levers that widen an ordinary route's candidate set.
    vi.stubEnv("GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK", "true");
    vi.stubEnv("PROVIDER_ROUTING_MODE", "auto");
    const policy = providerPolicyFor("deepseek-v4-flash-0731-relace", 2, [], { finalAttempt: true });
    expect(policy?.only).toEqual(["relace/fp4"]);
    expect(policy?.allowFallbacks).toBe(false);
  });

  it("prices each host at what that host actually charges", () => {
    /*
     * A pinned route is one endpoint, so there is exactly one price it can be
     * served at. Without an entry, a response that arrived without
     * `usage.cost` would be stored as unpriced and counted as costing nothing —
     * and since the entire purpose of these two routes is a cost comparison, a
     * candidate that silently read as free would win it.
     */
    expect(modelPricing["deepseek-v4-flash-0731-openinference"]).toEqual({ cacheHit: 0.013, cacheMiss: 0.05, output: 0.16 });
    expect(modelPricing["deepseek-v4-flash-0731-relace"]).toEqual({ cacheHit: 0.016, cacheMiss: 0.065, output: 0.18 });
  });

  it("stays resolvable everywhere and invisible in the writer picker", () => {
    withOpenRouter();
    /*
     * One model appearing three times is a meaningful distinction for a memory
     * A/B and pure noise for somebody choosing who writes their story. So the
     * routes resolve normally — they have to, or the job they serve cannot run
     * — and are simply not offered.
     */
    for (const id of ["deepseek-v4-flash-0731-openinference", "deepseek-v4-flash-0731-relace"]) {
      expect(allowedModels(), id).toContain(id);
      expect(pickerModels().map((model) => model.id), id).not.toContain(id);
    }
    expect(availabilityForTask("memory_consolidation").map((entry) => entry.candidate.id))
      .toEqual(expect.arrayContaining(["deepseek_0731_openinference", "deepseek_0731_relace"]));
  });
});

describe("the environment line that unlocks them", () => {
  it("unlocks both candidates with the exact verified tags", () => {
    withOpenRouter();
    vi.stubEnv("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS", "open-inference/fp8,relace/fp4");
    for (const id of ["deepseek_0731_openinference", "deepseek_0731_relace"]) {
      const entry = availabilityForTask("memory_consolidation").find((candidate) => candidate.candidate.id === id);
      expect(entry?.selectable, id).toBe(true);
      expect(entry?.reason).toBe("");
    }
  });

  it("tolerates the spacing a human pastes into a dashboard", () => {
    withOpenRouter();
    vi.stubEnv("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS", " open-inference/fp8 , RELACE/FP4 ");
    for (const id of ["deepseek_0731_openinference", "deepseek_0731_relace"]) {
      expect(availabilityForTask("memory_consolidation").find((candidate) => candidate.candidate.id === id)?.selectable, id).toBe(true);
    }
  });

  it("refuses a bare host name, because the suffix is part of the route", () => {
    withOpenRouter();
    // `fp8` and `fp4` name the quantisation the host serves this model at,
    // which is precisely the difference the per-host comparison exists to
    // measure. Opting into "relace" is not opting into a precision.
    vi.stubEnv("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS", "relace,open-inference");
    for (const id of ["deepseek_0731_openinference", "deepseek_0731_relace"]) {
      expect(availabilityForTask("memory_consolidation").find((candidate) => candidate.candidate.id === id)?.selectable, id).toBe(false);
    }
  });
});
