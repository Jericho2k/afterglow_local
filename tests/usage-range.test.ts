import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUsageRange, usageRangeFilter, maxCustomRangeDays } from "@/lib/usage-range";

/**
 * A report about a period, rather than about everything that ever happened.
 *
 * All-time and today were the only two windows available, which answers neither
 * "what did last week cost" nor "what did that prompt change do to the bill".
 */

const at = (iso: string) => new Date(iso);
const params = (query: string) => new URLSearchParams(query);

describe("resolving a window", () => {
  it("uses the reader's day, not the server's", () => {
    // 09:00 in Auckland (UTC+13, offset -780) is the previous UTC day. A report
    // that showed yesterday at breakfast would be wrong in the way that matters.
    const morningInAuckland = at("2026-08-25T20:00:00.000Z");
    const range = resolveUsageRange(params("range=today&offset=-780"), morningInAuckland);
    expect(range.from?.toISOString()).toBe("2026-08-25T11:00:00.000Z");
    expect(range.to).toBeNull();
  });

  it("counts the last seven days as including today", () => {
    const range = resolveUsageRange(params("range=7d&offset=0"), at("2026-08-25T15:00:00.000Z"));
    expect(range.from?.toISOString()).toBe("2026-08-19T00:00:00.000Z");
  });

  it("starts this month at its first day", () => {
    const range = resolveUsageRange(params("range=month&offset=0"), at("2026-08-25T15:00:00.000Z"));
    expect(range.from?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("treats a custom end date as inclusive and the interval as half-open", () => {
    const range = resolveUsageRange(params("range=custom&from=2026-08-01&to=2026-08-07&offset=0"));
    expect(range.from?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // The 7th is IN the report, so the interval ends at the start of the 8th.
    expect(range.to?.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });

  it("falls back to all time rather than to a nonsense window", () => {
    for (const query of [
      "range=custom&from=2026-08-07&to=2026-08-01&offset=0",
      "range=custom&from=not-a-date&to=2026-08-01",
      "range=custom&from=2026-08-01",
      "range=nonsense",
      "",
    ]) {
      expect(resolveUsageRange(params(query)).id).toBe("all");
    }
  });

  it("refuses a pathologically long custom range", () => {
    const from = "2000-01-01";
    expect(resolveUsageRange(params(`range=custom&from=${from}&to=2026-08-01&offset=0`)).id).toBe("all");
    expect(maxCustomRangeDays).toBeGreaterThan(365);
  });

  it("ignores an offset that is not a timezone", () => {
    const range = resolveUsageRange(params("range=today&offset=99999"), at("2026-08-25T15:00:00.000Z"));
    expect(range.from?.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });
});

describe("the window as a query", () => {
  it("filters in SQL, on the columns an existing index already covers", () => {
    const range = resolveUsageRange(params("range=custom&from=2026-08-01&to=2026-08-07&offset=0"));
    const { predicate, values } = usageRangeFilter("user-1", range);
    expect(predicate).toBe("user_id=$1 AND created_at >= $2 AND created_at < $3");
    expect(values).toHaveLength(3);
  });

  it("adds no predicate at all for all time", () => {
    const { predicate, values } = usageRangeFilter("user-1", resolveUsageRange(params("range=all")));
    expect(predicate).toBe("user_id=$1");
    expect(values).toEqual(["user-1"]);
  });
});

/** And the route itself, against real rows. */
const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({ streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (v: string) => JSON.parse(v) }));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const usage = await import("@/app/api/usage/route");

async function report(search: string) {
  const response = await usage.GET(new Request(`http://test/api/usage${search}`));
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: owner, email: null };
  vi.stubEnv("AFTERGLOW_ADMIN_USER_IDS", owner);

  // Three events: one long ago, one last week, one a minute ago.
  const events: Array<[string, number, string]> = [
    ["2024-01-01T00:00:00.000Z", 1_000, "deepseek-v4-flash"],
    [new Date(Date.now() - 5 * 86_400_000).toISOString(), 2_000, "mimo-v2.5"],
    [new Date(Date.now() - 60_000).toISOString(), 4_000, "mimo-v2.5"],
  ];
  for (const [createdAt, promptTokens, model] of events) {
    await query(
      `INSERT INTO usage_events (id,user_id,provider_id,model,usage_type,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,estimated_cost_usd,created_at)
       VALUES ($1,$2,'openrouter',$3,'chat',$4,100,0,$4,0.01,$5)`,
      [crypto.randomUUID(), owner, model, promptTokens, createdAt],
    );
  }
});

describe("the report honours the window", () => {
  it("counts everything for all time", async () => {
    const { body } = await report("?range=all");
    expect(body.usage.requests).toBe(3);
    expect(body.range.id).toBe("all");
  });

  it("counts only today for today", async () => {
    const { body } = await report(`?range=today&offset=${new Date().getTimezoneOffset()}`);
    expect(body.usage.requests).toBe(1);
    expect(body.usage.promptTokens).toBe(4_000);
  });

  it("counts the last week for seven days", async () => {
    const { body } = await report(`?range=7d&offset=${new Date().getTimezoneOffset()}`);
    expect(body.usage.requests).toBe(2);
    expect(body.usage.promptTokens).toBe(6_000);
  });

  it("scopes the breakdowns to the same window as the total", async () => {
    // A total covering one period and a breakdown covering another is a report
    // that cannot be reasoned about.
    const { body } = await report(`?range=7d&offset=${new Date().getTimezoneOffset()}`);
    const byModel = Object.fromEntries(body.byModel.map((row: { key: string; requests: number }) => [row.key, row.requests]));
    expect(byModel["mimo-v2.5"]).toBe(2);
    expect(byModel["deepseek-v4-flash"]).toBeUndefined();
    expect(body.byModel.reduce((sum: number, row: { requests: number }) => sum + row.requests, 0)).toBe(body.usage.requests);
  });

  it("stays admin-only whatever window is asked for", async () => {
    vi.stubEnv("AFTERGLOW_ADMIN_USER_IDS", "");
    expect((await report("?range=today")).status).toBe(403);
  });
});
