import { afterEach,describe,expect,it,vi } from "vitest";
import { completionWithUsage,embeddingWithUsage,streamCompletion } from "@/lib/llm";

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
