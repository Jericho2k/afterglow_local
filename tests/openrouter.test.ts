import { readFileSync } from "node:fs";
import { afterEach,describe,expect,it,vi } from "vitest";
import { providerHeadersTimeoutMs } from "@/lib/openrouter";
import { completionWithUsage,embeddingWithUsage,streamCompletion } from "@/lib/llm";
import { ProviderError } from "@/lib/provider-errors";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ENABLE_OPENROUTER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENROUTER_APP_NAME;
  delete process.env.OPENROUTER_SITE_URL;
  delete process.env.ALLOWED_MODELS;
});

function enable() {
  process.env.ENABLE_OPENROUTER = "true";
  process.env.OPENROUTER_API_KEY = "or-test-secret";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
  process.env.OPENROUTER_APP_NAME = "Afterglow Test";
  process.env.OPENROUTER_SITE_URL = "https://afterglow.test";
  process.env.ALLOWED_MODELS = "passion-fruit,kimi-k2.5";
}

describe("OpenRouter provider", () => {
  it("maps the private upstream model and records native response metadata", async () => {
    enable();
    vi.stubGlobal("fetch",vi.fn(async (url:string,init?:RequestInit) => {
      expect(url).toBe("https://openrouter.test/api/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer or-test-secret");
      expect(headers.get("X-Title")).toBe("Afterglow Test");
      expect(headers.get("HTTP-Referer")).toBe("https://afterglow.test");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model:"thedrummer/cydonia-24b-v4.1",max_tokens:2048,temperature:1 });
      expect(String(init?.body)).not.toContain("or-test-secret");
      return Response.json({
        id:"gen-123",model:"thedrummer/cydonia-24b-v4.1",
        choices:[{ message:{ content:"reply" } }],
        usage:{ prompt_tokens:120,completion_tokens:30,cost:0.000051,prompt_tokens_details:{ cached_tokens:20 } },
      });
    }));
    const result = await completionWithUsage({ providerId:"openrouter",modelId:"passion-fruit" },[{ role:"user",content:"Hi" }],{ maxTokens:2048,temperature:1 });
    expect(result.content).toBe("reply");
    expect(result.usage).toMatchObject({ provider_request_id:"gen-123",actual_model:"thedrummer/cydonia-24b-v4.1",cost:0.000051 });
  });

  it("preserves OpenAI-compatible streaming for chat", async () => {
    enable();
    vi.stubGlobal("fetch",vi.fn(async (_url:string,init?:RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model:"moonshotai/kimi-k2.5",stream:true });
      return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n',{ headers:{ "Content-Type":"text/event-stream" } });
    }));
    const stream = await streamCompletion({ providerId:"openrouter",modelId:"kimi-k2.5" },[{ role:"user",content:"Hi" }]);
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it("fails over a temporary 429 to another provider serving the SAME model", async () => {
    enable();
    process.env.ALLOWED_MODELS = "midnight-cherry,kimi-k2.5";
    const models:string[]=[];
    const fetchMock=vi.fn(async (_url:string,init?:RequestInit) => {
      const body=JSON.parse(String(init?.body));
      models.push(String(body.model));
      if (models.length === 1) {
        // The exact shape that used to reach a reader's screen.
        return new Response('{"error":{"message":"Provider Parasail returned 429 from shared pool","metadata":{"provider_name":"Parasail"}}}',{status:429});
      }
      // The second attempt explicitly permits another host for the same model.
      expect(body.provider).toEqual({allow_fallbacks:true,sort:"throughput"});
      return new Response('data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\ndata: [DONE]\n\n');
    });
    vi.stubGlobal("fetch",fetchMock);
    await streamCompletion({providerId:"openrouter",modelId:"midnight-cherry"},[{role:"user",content:"Hi"}]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Provider failover is not model failover: the reader's chosen writer is
    // identical on both attempts, and there is exactly one generation.
    expect(new Set(models)).toEqual(new Set(["thedrummer/skyfall-36b-v2"]));
  });

  it("never retries a credential, billing or malformed-request failure", async () => {
    enable();
    for (const [status,category] of [[401,"auth"],[402,"billing"],[400,"bad_request"]] as const) {
      const fetchMock=vi.fn(async () => new Response('{"error":{"message":"nope"}}',{status}));
      vi.stubGlobal("fetch",fetchMock);
      const failure = await streamCompletion({providerId:"openrouter",modelId:"kimi-k2.5"},[{role:"user",content:"Hi"}]).catch((error) => error);
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).category).toBe(category);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after a bounded number of attempts rather than cascading", async () => {
    enable();
    const fetchMock=vi.fn(async () => new Response('{"error":{"message":"busy"}}',{status:429}));
    vi.stubGlobal("fetch",fetchMock);
    const failure = await streamCompletion({providerId:"openrouter",modelId:"kimi-k2.5"},[{role:"user",content:"Hi"}]).catch((error) => error);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect((failure as ProviderError).message).toBe("The model is temporarily busy. Please try again in a moment.");
    // The upstream body is kept for the operator and only for the operator.
    expect((failure as ProviderError).diagnostic.detail).toContain("busy");
  });

  it("asks for usage accounting and sends a session id only when given one", async () => {
    enable();
    const bodies:Record<string,unknown>[]=[];
    vi.stubGlobal("fetch",vi.fn(async (_url:string,init?:RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n');
    }));
    await streamCompletion({providerId:"openrouter",modelId:"kimi-k2.5"},[{role:"user",content:"Hi"}],{sessionId:"abc123"});
    await streamCompletion({providerId:"openrouter",modelId:"kimi-k2.5"},[{role:"user",content:"Hi"}]);

    // Without this, a streamed generation reports no tokens, no cost and no
    // cached-token counts at all — which is what made caching unmeasurable.
    expect(bodies[0]).toMatchObject({ usage:{ include:true }, session_id:"abc123" });
    expect(bodies[1]).toMatchObject({ usage:{ include:true } });
    expect(bodies[1]).not.toHaveProperty("session_id");
  });

  it("carries cached-token and provider metadata through to usage", async () => {
    enable();
    vi.stubGlobal("fetch",vi.fn(async () => Response.json({
      id:"gen-9",model:"moonshotai/kimi-k2.5",provider:"Moonshot AI",
      choices:[{ message:{ content:"reply" } }],
      usage:{ prompt_tokens:9000,completion_tokens:200,cost:0.0031,
        prompt_tokens_details:{ cached_tokens:7400,cache_write_tokens:1600 } },
    })));
    const result = await completionWithUsage({ providerId:"openrouter",modelId:"kimi-k2.5" },[{ role:"user",content:"Hi" }]);
    expect(result.usage).toMatchObject({
      actual_model:"moonshotai/kimi-k2.5", upstream_provider:"Moonshot AI", cost:0.0031,
      prompt_tokens_details:{ cached_tokens:7400,cache_write_tokens:1600 },
    });
  });

  it("retries a stale provider deployment through a healthy fallback", async () => {
    enable();
    const fetchMock=vi.fn(async (_url:string,init?:RequestInit) => {
      const body=JSON.parse(String(init?.body));
      if (fetchMock.mock.calls.length === 1) return new Response('{"error":{"message":"Provider returned error: deployment does not exist"}}',{status:404});
      expect(body.provider).toEqual({allow_fallbacks:true,sort:"throughput"});
      return new Response('data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\ndata: [DONE]\n\n');
    });
    vi.stubGlobal("fetch",fetchMock);
    await streamCompletion({providerId:"openrouter",modelId:"passion-fruit"},[{role:"user",content:"Hi"}]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exposes a separate reduced-dimension embedding capability", async () => {
    enable();
    vi.stubGlobal("fetch",vi.fn(async (url:string,init?:RequestInit) => {
      expect(url).toBe("https://openrouter.test/api/v1/embeddings");
      expect(JSON.parse(String(init?.body))).toEqual({
        model:"qwen/qwen3-embedding-8b",input:["memory","query"],dimensions:1024,encoding_format:"float",
      });
      return Response.json({ id:"emb-1",model:"qwen/qwen3-embedding-8b",data:[{ embedding:[0.1,0.2] },{ embedding:[0.3,0.4] }],usage:{ prompt_tokens:4,cost:0.00000004 } });
    }));
    const result = await embeddingWithUsage(["memory","query"]);
    expect(result.embeddings).toEqual([[0.1,0.2],[0.3,0.4]]);
    expect(result.usage).toMatchObject({ provider_request_id:"emb-1",actual_model:"qwen/qwen3-embedding-8b" });
  });
});

/**
 * THE UNBOUNDED WAIT.
 *
 * `fetch` was given only the caller's own abort signal — the browser hanging up
 * — so an upstream that accepted the connection and then said nothing held the
 * request until the platform's 120-second ceiling killed the function. That is
 * the reported "close to a minute": not a model thinking, one dead host holding
 * a chat hostage while other hosts served the same model.
 *
 * The deadline is on the HEADERS phase only. A reply that is streaming is never
 * cut off however long it takes, because a long reply is not a fault.
 */
describe("a silent upstream does not hold the chat", () => {
  afterEach(() => { delete process.env.PROVIDER_HEADERS_TIMEOUT_MS; });

  it("gives up on a host that never sends headers and tries another", async () => {
    enable();
    process.env.PROVIDER_HEADERS_TIMEOUT_MS = "40";
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      return Response.json({ choices: [{ message: { content: "Recovered." } }] });
    }));

    const started = Date.now();
    const result = await completionWithUsage({ providerId: "openrouter", modelId: "passion-fruit" }, [{ role: "user", content: "hello" }]);
    expect(result.content).toBe("Recovered.");
    expect(calls).toBeGreaterThan(1);
    // Bounded by the deadline plus backoff, not by the platform ceiling.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still lets the caller hanging up abort the request outright", async () => {
    enable();
    process.env.PROVIDER_HEADERS_TIMEOUT_MS = "10000";
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    })));

    const pending = completionWithUsage({ providerId: "openrouter", modelId: "passion-fruit" }, [{ role: "user", content: "hello" }], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("clears the deadline the moment headers arrive, so a long reply is never cut off", () => {
    const source = readFileSync("src/lib/openrouter.ts", "utf8");
    const fetchCall = source.indexOf("await fetch(`${baseUrl()}/chat/completions`");
    expect(fetchCall).toBeGreaterThan(-1);
    expect(source.slice(fetchCall, fetchCall + 400)).toContain("clearTimeout(deadline)");
  });

  it("defaults to a bound that is clearly outside normal provider behaviour", () => {
    expect(providerHeadersTimeoutMs()).toBe(20_000);
    process.env.PROVIDER_HEADERS_TIMEOUT_MS = "5000";
    expect(providerHeadersTimeoutMs()).toBe(5_000);
  });
});
