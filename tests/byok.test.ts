import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptProviderKey, encryptProviderKey, validateByokEncryptionConfiguration, validateOpenRouterKey, type InferenceFunding } from "@/lib/byok";
import { completionWithUsage, streamWriterCompletion } from "@/lib/llm";
import { ProviderError, logProviderDiagnostic, redactProviderSecrets } from "@/lib/provider-errors";

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const validEncryptionKey = Buffer.alloc(32, 7).toString("base64");

function enableOpenRouter() {
  process.env.ENABLE_OPENROUTER = "true";
  process.env.ENABLE_BYOK = "true";
  process.env.OPENROUTER_API_KEY = "platform-key";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
  process.env.ALLOWED_MODELS = "mimo-v2.5";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of ["ENABLE_OPENROUTER", "ENABLE_BYOK", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "ALLOWED_MODELS", "BYOK_ENCRYPTION_KEY"]) delete process.env[name];
});

describe("BYOK authenticated encryption", () => {
  it("round-trips with a fresh nonce every time", () => {
    process.env.BYOK_ENCRYPTION_KEY = validEncryptionKey;
    const first = encryptProviderKey(alice, "openrouter", "sk-or-v1-secret");
    const second = encryptProviderKey(alice, "openrouter", "sk-or-v1-secret");
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(decryptProviderKey(alice, "openrouter", first)).toBe("sk-or-v1-secret");
  });

  it("fails closed for tampering and AAD copied across accounts/providers", () => {
    process.env.BYOK_ENCRYPTION_KEY = validEncryptionKey;
    const encrypted = encryptProviderKey(alice, "openrouter", "sk-or-v1-secret");
    const ciphertext = Buffer.from(encrypted.ciphertext); ciphertext[0] ^= 1;
    const authTag = Buffer.from(encrypted.authTag); authTag[0] ^= 1;
    expect(() => decryptProviderKey(alice, "openrouter", { ...encrypted, ciphertext })).toThrow();
    expect(() => decryptProviderKey(alice, "openrouter", { ...encrypted, authTag })).toThrow();
    expect(() => decryptProviderKey(bob, "openrouter", encrypted)).toThrow();
    expect(() => decryptProviderKey(alice, "other" as "openrouter", encrypted)).toThrow();
  });

  it("accepts only an explicit base64 encoding of exactly 32 bytes", () => {
    for (const invalid of ["", "human password", Buffer.alloc(31).toString("base64"), "a".repeat(64)]) {
      process.env.BYOK_ENCRYPTION_KEY = invalid;
      expect(() => validateByokEncryptionConfiguration()).toThrow(/base64-encoded 32-byte|not configured/);
    }
    process.env.BYOK_ENCRYPTION_KEY = validEncryptionKey;
    expect(() => validateByokEncryptionConfiguration()).not.toThrow();
  });
});

describe("OpenRouter validation and request-scoped auth", () => {
  it("validates through GET /key and distinguishes invalid from temporary failures", async () => {
    enableOpenRouter();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateOpenRouterKey("personal-key")).resolves.toEqual({ ok: true });
    await expect(validateOpenRouterKey("personal-key")).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(validateOpenRouterKey("personal-key")).resolves.toEqual({ ok: false, kind: "temporary" });
    await expect(validateOpenRouterKey("personal-key")).resolves.toEqual({ ok: false, kind: "temporary" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.test/api/v1/key");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer personal-key");
  });

  it("isolates concurrent users and keeps platform authentication separate", async () => {
    enableOpenRouter();
    const seen = new Map<string, string>();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const marker = String(body.messages[0].content);
      seen.set(marker, new Headers(init?.headers).get("Authorization") || "");
      await Promise.resolve();
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}\n\ndata: [DONE]\n\n`);
    }));
    const selection = { providerId: "openrouter", modelId: "mimo-v2.5" };
    const byok = (credential: string): InferenceFunding => ({ type: "byok", provider: "openrouter", credential });
    await Promise.all([
      streamWriterCompletion(selection, [{ role: "user", content: "alice" }], byok("alice-key")),
      streamWriterCompletion(selection, [{ role: "user", content: "bob" }], byok("bob-key")),
      streamWriterCompletion(selection, [{ role: "user", content: "platform" }], { type: "afterglow" }),
    ]);
    expect(Object.fromEntries(seen)).toEqual({ alice: "Bearer alice-key", bob: "Bearer bob-key", platform: "Bearer platform-key" });
    expect(process.env.OPENROUTER_API_KEY).toBe("platform-key");
  });

  it("never falls back on BYOK auth or billing failure", async () => {
    enableOpenRouter();
    for (const [status, category] of [[401, "auth"], [402, "billing"]] as const) {
      const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => { void args; return new Response("rejected", { status }); });
      vi.stubGlobal("fetch", fetchMock);
      const failure = await streamWriterCompletion(
        { providerId: "openrouter", modelId: "mimo-v2.5" },
        [{ role: "user", content: "hello" }],
        { type: "byok", provider: "openrouter", credential: "personal-key" },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ category });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer personal-key");
    }
  });

  it("keeps same-model provider failover on the same personal key", async () => {
    enableOpenRouter();
    const auth: string[] = []; const models: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get("Authorization") || "");
      models.push(String(JSON.parse(String(init?.body)).model));
      if (fetchMock.mock.calls.length === 1) return new Response("busy", { status: 429 });
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
    vi.stubGlobal("fetch", fetchMock);
    await streamWriterCompletion(
      { providerId: "openrouter", modelId: "mimo-v2.5" },
      [{ role: "user", content: "hello" }],
      { type: "byok", provider: "openrouter", credential: "personal-key" },
    );
    expect(auth).toEqual(["Bearer personal-key", "Bearer personal-key"]);
    expect(new Set(models)).toEqual(new Set(["xiaomi/mimo-v2.5"]));
  });

  it("keeps generic/background OpenRouter calls platform-funded", async () => {
    enableOpenRouter();
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => { void args; return Response.json({ choices: [{ message: { content: "{}" } }] }); });
    vi.stubGlobal("fetch", fetchMock);
    await completionWithUsage({ providerId: "openrouter", modelId: "mimo-v2.5" }, [{ role: "user", content: "maintenance" }]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer platform-key");
  });
});

describe("secret redaction", () => {
  it("redacts bearer tokens and OpenRouter key shapes from diagnostics", () => {
    const secret = "sk-or-v1-supersecretvalue";
    expect(redactProviderSecrets(`Authorization: Bearer ${secret}`)).not.toContain(secret);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logProviderDiagnostic("test", new ProviderError("auth", { detail: `header=Bearer ${secret}` }));
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  });
});
