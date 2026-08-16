import { afterEach, describe, expect, it, vi } from "vitest";
import { completion, streamCompletion } from "@/lib/deepseek";

afterEach(() => { vi.unstubAllGlobals(); delete process.env.DEEPSEEK_API_KEY; });

describe("DeepSeek client", () => {
  it("uses runtime model and response controls without exposing the key in the body", async () => {
    process.env.DEEPSEEK_API_KEY = "test-secret";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "deepseek-v4-pro", max_tokens: 2048, temperature: 0.7, thinking: { type: "disabled" } });
      expect(String(init?.body)).not.toContain("test-secret");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-secret");
      return Response.json({ choices: [{ message: { content: "hello" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(completion([{ role: "user", content: "Hi" }], { model: "deepseek-v4-pro", maxTokens: 2048, temperature: 0.7 })).resolves.toBe("hello");
  });

  it("requests streamed usage metadata", async () => {
    process.env.DEEPSEEK_API_KEY = "test-secret";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stream = await streamCompletion([{ role: "user", content: "Hi" }], { model: "deepseek-v4-flash" });
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});
