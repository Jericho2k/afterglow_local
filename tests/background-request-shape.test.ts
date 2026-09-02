import { afterEach, describe, expect, it, vi } from "vitest";
import { completionWithUsage } from "@/lib/llm";
import { backgroundReasoningFor, modelCapabilities, supportsStructuredOutput } from "@/lib/provider";
import { ProviderError } from "@/lib/provider-errors";
import { consolidationInstructions } from "@/lib/prompts";

/**
 * WHAT A BACKGROUND JOB ACTUALLY PUTS ON THE WIRE.
 *
 * Two production failures, one symptom, and neither was visible from the code
 * that caused it:
 *
 *   LING 3.0 FLASH answered a run of Scene Ledger extractions with
 *   `empty_response`. Its catalogue entry claimed `jsonMode: true`, and the
 *   adapter emitted `response_format: {type:"json_object"}` on `json: true`
 *   unconditionally — to an endpoint OpenRouter documents as not supporting it.
 *
 *   DEEPSEEK V4 FLASH 0731 answered memory consolidations with
 *   `empty_response`. Background calls sent no `reasoning` key at all, which is
 *   not "off" — it is declining to have an opinion, and a reasoning-capable
 *   endpoint's own default is to reason. Reasoning tokens are billed as
 *   completion tokens, so they come out of the same 3,600-token envelope as the
 *   JSON.
 *
 * Both are wire-shape bugs. A test that mocks the adapter cannot see either, so
 * this suite mocks `fetch` and reads the body that was actually sent.
 */

const consolidationRequest = [
  { role: "system" as const, content: `You are a precise continuity editor and episodic-memory curator. Output JSON only.\n\n${consolidationInstructions()}` },
  { role: "user" as const, content: "Existing summary:\nNone\n\nNew transcript:\nTurn." },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.ENABLE_OPENROUTER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
});

function enableOpenRouter() {
  process.env.ENABLE_OPENROUTER = "true";
  process.env.OPENROUTER_API_KEY = "or-test-secret";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
}

/** Captures every request body the adapter sends, then answers with `reply`. */
function captureBodies(reply: unknown = { id: "gen-1", model: "m", choices: [{ message: { content: "{\"summary\":\"ok\"}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json(reply);
  }));
  return bodies;
}

/** Exactly the options a background extraction sends. See src/lib/memory.ts. */
function backgroundOptions(modelId: string) {
  return {
    json: true, maxTokens: 3600, temperature: 0.2,
    modelId,
    thinking: backgroundReasoningFor(modelId),
    strictReasoning: true,
    sessionId: "session-abcdef",
  };
}

describe("Ling 3.0 Flash — structured output it does not implement", () => {
  it("declares no structured output in the catalogue", () => {
    enableOpenRouter();
    // The capability is now load-bearing rather than decorative, so it is
    // asserted directly: the adapter reads it before emitting the parameter.
    expect(modelCapabilities("openrouter", "ling-3.0-flash").jsonMode).toBe(false);
    expect(modelCapabilities("openrouter", "ling-3.0-flash-free").jsonMode).toBe(false);
    expect(supportsStructuredOutput("openrouter", "ling-3.0-flash")).toBe(false);
  });

  it("never receives response_format, even when the caller asks for JSON", async () => {
    enableOpenRouter();
    const bodies = captureBodies();
    await completionWithUsage({ providerId: "openrouter", modelId: "ling-3.0-flash" }, consolidationRequest, backgroundOptions("ling-3.0-flash"));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(bodies[0].model).toBe("inclusionai/ling-3.0-flash");
  });

  it("still asks for JSON in words, and parses what comes back", async () => {
    /*
     * The half of the contract that does not depend on a parameter. A model
     * that cannot be told to emit JSON by `response_format` is still ASKED for
     * it by the instruction block, and its reply goes through the same parse.
     * Losing the parameter must not quietly become losing the requirement.
     */
    enableOpenRouter();
    const bodies = captureBodies({
      id: "gen-2", model: "inclusionai/ling-3.0-flash",
      choices: [{ message: { content: "{\"location\":{\"place\":\"the flat\",\"sub\":\"kitchen\",\"confidence\":\"stated\"}}" } }],
      usage: { prompt_tokens: 40, completion_tokens: 12 },
    });
    const result = await completionWithUsage({ providerId: "openrouter", modelId: "ling-3.0-flash" }, consolidationRequest, backgroundOptions("ling-3.0-flash"));
    const system = String((bodies[0].messages as Array<{ content: string }>)[0].content);
    expect(system).toContain("Output JSON only");
    expect(JSON.parse(result.content)).toMatchObject({ location: { place: "the flat" } });
  });

  it("sends no reasoning key at all, because the endpoint does not take one", () => {
    // Ling declares no reasoning support. Sending `reasoning: {enabled:false}`
    // to an endpoint that has never heard of the parameter is a 400 with a
    // background job attached to it, so silence is the correct answer.
    expect(backgroundReasoningFor("ling-3.0-flash")).toBeUndefined();
  });
});

describe("DeepSeek V4 Flash 0731 — reasoning it was never told to skip", () => {
  it("keeps receiving response_format, because it supports it", async () => {
    enableOpenRouter();
    expect(modelCapabilities("openrouter", "deepseek-v4-flash-0731").jsonMode).toBe(true);
    const bodies = captureBodies();
    await completionWithUsage({ providerId: "openrouter", modelId: "deepseek-v4-flash-0731" }, consolidationRequest, backgroundOptions("deepseek-v4-flash-0731"));
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
  });

  it("explicitly disables reasoning, in the shape OpenRouter documents", async () => {
    enableOpenRouter();
    const bodies = captureBodies();
    await completionWithUsage({ providerId: "openrouter", modelId: "deepseek-v4-flash-0731" }, consolidationRequest, backgroundOptions("deepseek-v4-flash-0731"));
    /*
     * `{ enabled: false }` and an ABSENT key are the two things that used to be
     * confused. Omitting the parameter takes the endpoint's own default, which
     * on a reasoning-capable model is to reason — inside an envelope sized for
     * JSON and nothing else.
     */
    expect(bodies[0].reasoning).toEqual({ enabled: false });
    expect(backgroundReasoningFor("deepseek-v4-flash-0731")).toBe("off");
  });

  it("keeps the routing, session and caching work that the cost sprint bought", async () => {
    enableOpenRouter();
    const bodies = captureBodies();
    await completionWithUsage(
      { providerId: "openrouter", modelId: "deepseek-v4-flash-0731-relace" },
      consolidationRequest,
      backgroundOptions("deepseek-v4-flash-0731-relace"),
    );
    // The pin, the fallbacks-off semantics, the privacy floor and the price
    // ceiling all still travel with a background request.
    expect(bodies[0].provider).toMatchObject({
      only: ["relace/fp4"], allow_fallbacks: false, data_collection: "deny",
    });
    expect(bodies[0].session_id).toBe("session-abcdef");
    expect(bodies[0].usage).toEqual({ include: true });
  });

  it("treats an endpoint that refuses reasoning-disabled as incompatible", async () => {
    /*
     * The adapter's one negotiation — drop `reasoning` and retry — is right for
     * a roleplay turn and wrong here: it hands back the endpoint's own default,
     * which is MORE thinking in the same small envelope, reproducing the exact
     * failure the parameter was sent to prevent one attempt later.
     */
    enableOpenRouter();
    const attempts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      attempts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("{\"error\":{\"message\":\"Reasoning is mandatory for this endpoint and cannot be disabled\"}}", { status: 400 });
    }));
    const failure = await completionWithUsage(
      { providerId: "openrouter", modelId: "deepseek-v4-flash-0731-relace" },
      consolidationRequest,
      backgroundOptions("deepseek-v4-flash-0731-relace"),
    ).catch((error) => error as ProviderError);

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).category).toBe("bad_request");
    expect((failure as ProviderError).diagnostic.detail).toContain("will not run with endpoint-default reasoning");
    // One attempt. It did NOT quietly retry without the parameter.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].reasoning).toEqual({ enabled: false });
  });
});

describe("Direct DeepSeek is unchanged", () => {
  it("still disables thinking on its own non-streaming path", async () => {
    process.env.DEEPSEEK_API_KEY = "ds-test-secret";
    process.env.DEEPSEEK_BASE_URL = "https://deepseek.test";
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: "{\"summary\":\"ok\"}" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    }));
    await completionWithUsage({ providerId: "deepseek", modelId: "deepseek-v4-flash" }, consolidationRequest, backgroundOptions("deepseek-v4-flash"));

    /*
     * DeepSeek's own adapter has always sent this, which is exactly why Direct
     * DeepSeek never had the 0731 problem. Its spelling is its own — the
     * OpenRouter `reasoning` block is not a thing this endpoint understands —
     * and the point of the change is that the two providers now AGREE about
     * background extraction rather than that they send the same bytes.
     */
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
    expect(bodies[0]).not.toHaveProperty("reasoning");
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[0].model).toBe("deepseek-v4-flash");
  });
});

describe("the writer's reasoning is untouched", () => {
  it("sends whatever the engine and the catalogue asked for, and no background policy", async () => {
    /*
     * `backgroundReasoningFor` is deliberately a separate function from
     * `defaultReasoningFor`: one serves structured extraction and the other
     * serves roleplay and is steered by `RP_REASONING`. This asserts the
     * streaming writer path still emits exactly what it was told to, including
     * an effort level, which no background job ever sends.
     */
    enableOpenRouter();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }));
    const { streamCompletion } = await import("@/lib/llm");

    await streamCompletion({ providerId: "openrouter", modelId: "glm-5.3-flash" }, [{ role: "user", content: "Hi" }], { thinking: "minimal", maxTokens: 1800 });
    expect(bodies[0].reasoning).toEqual({ effort: "minimal" });
    expect(bodies[0]).not.toHaveProperty("response_format");

    await streamCompletion({ providerId: "openrouter", modelId: "mimo-v2.5" }, [{ role: "user", content: "Hi" }], { thinking: true, maxTokens: 1800 });
    expect(bodies[1].reasoning).toEqual({ enabled: true });

    // And "no opinion" still means no key, which is the writer's fourth state.
    await streamCompletion({ providerId: "openrouter", modelId: "mimo-v2.5" }, [{ role: "user", content: "Hi" }], { maxTokens: 1800 });
    expect(bodies[2]).not.toHaveProperty("reasoning");
  });
});
