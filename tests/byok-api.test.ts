import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
let account: { id: string; email: string | null } | null = null;

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const byokRoute = await import("@/app/api/byok/route");
const { resetRateLimitsForTesting } = await import("@/lib/rate-limit");

function request(body: unknown, method = "POST") {
  return new Request("http://test/api/byok", {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": `${crypto.randomUUID()}.test` },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  resetRateLimitsForTesting();
  process.env.ENABLE_BYOK = "true";
  process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  await query("INSERT INTO user_settings (user_id) VALUES ($1),($2)", [alice, bob]);
  account = { id: alice, email: "alice@example.com" };
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ["ENABLE_BYOK", "BYOK_ENCRYPTION_KEY", "OPENROUTER_BASE_URL"]) delete process.env[name];
});

describe("credential API", () => {
  it("requires authentication for every operation", async () => {
    account = null;
    expect((await byokRoute.GET()).status).toBe(401);
    expect((await byokRoute.POST(request({ apiKey: "sk-or-v1-long-enough" }))).status).toBe(401);
    expect((await byokRoute.PATCH(request({ writerFunding: "byok" }, "PATCH"))).status).toBe(401);
    expect((await byokRoute.DELETE()).status).toBe(401);
  });

  it("connects a valid key encrypted and returns metadata only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { label: "test" } })));
    const secret = "sk-or-v1-alice-personal-secret";
    const response = await byokRoute.POST(request({ apiKey: secret }));
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata).toMatchObject({ connected: true, enabled: true, provider: "openrouter", suffix: "cret", writerFunding: "byok" });
    for (const forbidden of [secret, "ciphertext", "nonce", "authTag", "auth_tag", "apiKey"]) expect(JSON.stringify(metadata)).not.toContain(forbidden);

    const row = (await query("SELECT ciphertext,nonce,auth_tag,key_suffix FROM user_provider_credentials WHERE user_id=$1", [alice])).rows[0];
    expect(row.key_suffix).toBe("cret");
    expect(JSON.stringify(row)).not.toContain(secret);
    expect((await query("SELECT writer_funding FROM user_settings WHERE user_id=$1", [alice])).rows[0].writer_funding).toBe("byok");
  });

  it("stores nothing when the first key is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const response = await byokRoute.POST(request({ apiKey: "sk-or-v1-invalid-first-key" }));
    expect(response.status).toBe(400);
    expect(Number((await query("SELECT COUNT(*) count FROM user_provider_credentials WHERE user_id=$1", [alice])).rows[0].count)).toBe(0);
    expect((await query("SELECT writer_funding FROM user_settings WHERE user_id=$1", [alice])).rows[0].writer_funding).toBe("afterglow");
  });

  it("rejects invalid and temporary validation failures without changing a known-good key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await byokRoute.POST(request({ apiKey: "sk-or-v1-known-good-secret" }));
    const before = (await query("SELECT ciphertext,key_suffix FROM user_provider_credentials WHERE user_id=$1", [alice])).rows[0];

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const invalid = await byokRoute.POST(request({ apiKey: "sk-or-v1-invalid-replacement" }));
    expect(invalid.status).toBe(400);
    let after = (await query("SELECT ciphertext,key_suffix FROM user_provider_credentials WHERE user_id=$1", [alice])).rows[0];
    expect(after.key_suffix).toBe(before.key_suffix);
    expect(Buffer.from(after.ciphertext).equals(Buffer.from(before.ciphertext))).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const temporary = await byokRoute.POST(request({ apiKey: "sk-or-v1-temporary-replacement" }));
    expect(temporary.status).toBe(503);
    expect((await temporary.json()).reason).toBe("temporary");
    after = (await query("SELECT ciphertext,key_suffix FROM user_provider_credentials WHERE user_id=$1", [alice])).rows[0];
    expect(after.key_suffix).toBe(before.key_suffix);
  });

  it("replaces valid keys and isolates metadata and writes by account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await byokRoute.POST(request({ apiKey: "sk-or-v1-alice-first-key" }));
    await byokRoute.POST(request({ apiKey: "sk-or-v1-alice-second-key" }));
    expect((await byokRoute.GET().then((response) => response.json())).suffix).toBe("-key");

    account = { id: bob, email: null };
    expect(await byokRoute.GET().then((response) => response.json())).toMatchObject({ connected: false, suffix: "", writerFunding: "afterglow" });
    await byokRoute.POST(request({ apiKey: "sk-or-v1-bob-private-key" }));
    expect(await byokRoute.GET().then((response) => response.json())).toMatchObject({ connected: true, suffix: "-key" });

    const rows = await query("SELECT user_id,COUNT(*)::int count FROM user_provider_credentials GROUP BY user_id ORDER BY user_id");
    expect(rows.rows).toEqual([{ user_id: alice, count: 1 }, { user_id: bob, count: 1 }]);
  });

  it("removes only the caller's key, disables BYOK, and leaves story data untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await byokRoute.POST(request({ apiKey: "sk-or-v1-alice-removal-key" }));
    await query("INSERT INTO characters (id,name,user_id) VALUES ($1,'Mara',$2)", ["aaaaaaaa-0000-4000-8000-000000000001", alice]);
    await query("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Story')", ["cccccccc-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000001", alice]);
    const response = await byokRoute.DELETE();
    expect(await response.json()).toMatchObject({ connected: false, enabled: false, writerFunding: "afterglow" });
    expect(Number((await query("SELECT COUNT(*) count FROM user_provider_credentials WHERE user_id=$1", [alice])).rows[0].count)).toBe(0);
    expect((await query("SELECT writer_funding FROM user_settings WHERE user_id=$1", [alice])).rows[0].writer_funding).toBe("afterglow");
    expect(Number((await query("SELECT COUNT(*) count FROM conversations WHERE user_id=$1", [alice])).rows[0].count)).toBe(1);
  });

  it("uses the feature flag as a kill switch without deleting stored credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await byokRoute.POST(request({ apiKey: "sk-or-v1-alice-saved-key" }));
    process.env.ENABLE_BYOK = "false";
    const metadata = await byokRoute.GET().then((response) => response.json());
    expect(metadata).toMatchObject({ available: false, connected: true, enabled: false, writerFunding: "afterglow" });
    expect((await byokRoute.PATCH(request({ writerFunding: "byok" }, "PATCH"))).status).toBe(503);
    expect(Number((await query("SELECT COUNT(*) count FROM user_provider_credentials WHERE user_id=$1", [alice])).rows[0].count)).toBe(1);
  });
});
