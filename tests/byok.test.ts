import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptProviderKey, encryptProviderKey, validateOpenRouterKey } from "@/lib/byok";
import { completionWithUsage } from "@/lib/openrouter";

const user="11111111-1111-4111-8111-111111111111";
const originalEncryption=process.env.BYOK_ENCRYPTION_KEY;
const originalPlatform=process.env.OPENROUTER_API_KEY;

afterEach(()=>{
  if(originalEncryption===undefined)delete process.env.BYOK_ENCRYPTION_KEY;else process.env.BYOK_ENCRYPTION_KEY=originalEncryption;
  if(originalPlatform===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=originalPlatform;
  vi.unstubAllGlobals();
});

describe("BYOK encryption",()=>{
  it("uses AES-GCM with a fresh IV and account/provider-bound AAD",()=>{
    process.env.BYOK_ENCRYPTION_KEY=Buffer.alloc(32,7).toString("base64");
    const first=encryptProviderKey(user,"sk-or-secret");
    const second=encryptProviderKey(user,"sk-or-secret");
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(decryptProviderKey(user,{ciphertext:first.ciphertext,iv:first.iv,auth_tag:first.authTag})).toBe("sk-or-secret");
    expect(()=>decryptProviderKey("22222222-2222-4222-8222-222222222222",{ciphertext:first.ciphertext,iv:first.iv,auth_tag:first.authTag})).toThrow();
  });
});

describe("OpenRouter key handling",()=>{
  it("validates with GET /key and classifies invalid versus temporary failures",async()=>{
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(null,{status:200})).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(null,{status:503}));
    vi.stubGlobal("fetch",fetchMock);
    await expect(validateOpenRouterKey("personal-key")).resolves.toEqual({ok:true});
    await expect(validateOpenRouterKey("personal-key")).resolves.toEqual({ok:false,kind:"invalid"});
    await expect(validateOpenRouterKey("personal-key")).resolves.toEqual({ok:false,kind:"temporary"});
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/key$/);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer personal-key");
  });

  it("uses the request credential without mutating or falling back to the platform key",async()=>{
    process.env.OPENROUTER_API_KEY="platform-key";
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:"reply"}}]}),{status:200,headers:{"Content-Type":"application/json"}}));
    vi.stubGlobal("fetch",fetchMock);
    await completionWithUsage([{role:"user",content:"hello"}],"openai/test",{apiKey:"personal-key"});
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer personal-key");
    expect(process.env.OPENROUTER_API_KEY).toBe("platform-key");
  });

  it("does not retry BYOK authentication or billing failures on the platform key",async()=>{
    process.env.OPENROUTER_API_KEY="platform-key";
    const fetchMock=vi.fn().mockResolvedValue(new Response("invalid key",{status:401}));
    vi.stubGlobal("fetch",fetchMock);
    await expect(completionWithUsage([{role:"user",content:"hello"}],"openai/test",{apiKey:"personal-key"})).rejects.toMatchObject({category:"auth"});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer personal-key");
  });
});
