import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two denominators, and the branch that used to corrupt one of them.
 *
 * The fixture is the one from the brief: ten user turns, ten replies, five
 * regenerations, three continuations. A reply is not a generation and a
 * transcript row is not a reply, so the only source that gets 18 right is the
 * usage ledger.
 */

const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const usage = await import("@/app/api/usage/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";
const branchId = "cccccccc-0000-4000-8000-000000000002";

async function report() {
  const response = await usage.GET(new Request("http://test/api/usage?range=all"));
  return { status: response.status, body: await response.json() };
}

async function event(usageType: string, cost: number, fundingSource = "afterglow") {
  await query(
    `INSERT INTO usage_events (id,user_id,conversation_id,provider_id,model,usage_type,funding_source,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,estimated_cost_usd)
     VALUES ($1,$2,$3,'deepseek','deepseek-v4-flash',$4,$5,1000,200,0,1000,$6)`,
    [crypto.randomUUID(), owner, conversationId, usageType, fundingSource, cost],
  );
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
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Story')", [conversationId, owner, characterId]);
  await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Branch')", [branchId, owner, characterId]);

  // Ten accepted user turns, each of which started a generation.
  for (let index = 0; index < 10; index += 1) {
    await query(
      "INSERT INTO messages (id,conversation_id,user_id,role,content,generation_started_at,authored_event_id) VALUES ($1,$2,$3,'user',$4,now(),$1)",
      [crypto.randomUUID(), conversationId, owner, `Turn ${index}`],
    );
  }
  // Ten replies, five regenerations, three continuations.
  for (let index = 0; index < 10; index += 1) await event("chat", 0.001);
  for (let index = 0; index < 5; index += 1) await event("regenerate", 0.001);
  for (let index = 0; index < 3; index += 1) await event("continue", 0.001);
  // Background work is not a writer generation.
  await event("memory_consolidation", 0.002);
  await event("scene_state", 0.002);
  await event("embedding", 0.002);
});

describe("writer generations", () => {
  it("counts Reply + Regenerate + Continue and nothing else", async () => {
    const { body } = await report();
    expect(body.userMessages).toBe(10);
    expect(body.writerGenerations).toBe(18);
  });

  it("divides Afterglow cost by the denominator each metric names", async () => {
    const { body } = await report();
    const afterglowCost = body.usage.afterglowCostUsd;
    expect(body.costPer100UserMessages).toBeCloseTo(afterglowCost * 100 / 10, 9);
    expect(body.costPer100WriterGenerations).toBeCloseTo(afterglowCost * 100 / 18, 9);
  });

  it("is unmoved by a branch copying the transcript", async () => {
    const before = (await report()).body;
    // A branch copies every message row, preserving the authored event id.
    const original = await query("SELECT * FROM messages WHERE conversation_id=$1", [conversationId]);
    for (const row of original.rows) {
      await query(
        "INSERT INTO messages (id,conversation_id,user_id,role,content,generation_started_at,authored_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [crypto.randomUUID(), branchId, owner, row.role, row.content, row.generation_started_at, row.authored_event_id],
      );
    }
    // Copying an assistant row too, which is what makes counting rows wrong.
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','A copied reply')", [crypto.randomUUID(), branchId, owner]);

    const after = (await report()).body;
    expect(after.writerGenerations).toBe(before.writerGenerations);
    expect(after.userMessages).toBe(before.userMessages);
    expect(after.costPer100WriterGenerations).toBeCloseTo(before.costPer100WriterGenerations, 12);
  });

  it("keeps funding-source accounting separate from the denominators", async () => {
    await event("chat", 5, "byok");
    const { body } = await report();
    expect(body.writerGenerations).toBe(19);
    // A BYOK generation counts as a generation and NOT as Afterglow spend.
    expect(body.usage.byokCostUsd).toBeCloseTo(5, 6);
    expect(body.usage.afterglowCostUsd).toBeCloseTo(0.018 + 0.006, 6);
    expect(body.costPer100WriterGenerations).toBeCloseTo(body.usage.afterglowCostUsd * 100 / 19, 9);
  });
});
