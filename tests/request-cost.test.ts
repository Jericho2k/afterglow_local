import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countRoundTrips, type RoundTripLog } from "./helpers/round-trips";

/**
 * What one interaction costs the database.
 *
 * The sprint's performance claims are about round trips against a pooled
 * remote PostgreSQL, so they are measured as round trips here rather than
 * argued from the shape of the source. Each case is one thing a reader does.
 *
 * `modelled` converts the in-memory count into what production pays: the test
 * engine cannot assume a role, so the two row-level-security statements every
 * real transaction issues are added back per connection.
 */

const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };
const streamCompletion = vi.fn();

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", async () => {
  const errors = await vi.importActual<typeof import("@/lib/provider-errors")>("@/lib/provider-errors");
  return {
    streamCompletion: (...args: unknown[]) => streamCompletion(...args),
    completionWithUsage: vi.fn().mockResolvedValue({ content: "{}", usage: null }),
    parseJson: (value: string) => JSON.parse(value),
    ProviderError: errors.ProviderError,
  };
});

const { asUser, ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const conversations = await import("@/app/api/conversations/route");
const conversationDetail = await import("@/app/api/conversations/[id]/route");
const characters = await import("@/app/api/characters/route");
const characterDetail = await import("@/app/api/characters/[id]/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";
let log: RoundTripLog;

/**
 * Production round trips.
 *
 * `asUser` opens its transaction and publishes the account's identity in ONE
 * simple-protocol statement, so a policy-enforcing database issues exactly the
 * statements the in-memory engine issues here. The counted number and the
 * production number are the same number, which is the point of doing it this
 * way rather than adding an estimate on top.
 */
function modelled(record: RoundTripLog) {
  return record.queries.length;
}

function report(label: string, record: RoundTripLog) {
  console.log(`${label.padEnd(42)} transactions=${record.connections}  statements=${record.statements().length}  round-trips(prod)=${modelled(record)}`);
  return modelled(record);
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  setPoolForTesting(pool);
  await ensureSchema();
  log = countRoundTrips(pool);
  account = { id: owner, email: null };
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  vi.stubEnv("SCENE_STATE_ENABLED", "false");
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  // `worlds_initialized` is what every conversation looks like after
  // 0019_conversation_worlds.sql: the migration backfills each existing story's
  // world set once and marks it. Measuring an unmigrated row here would be
  // measuring a one-off, not the steady state these budgets exist to protect.
  // The one-off itself is asserted in tests/conversation-worlds.test.ts.
  await query("INSERT INTO conversations (id,user_id,character_id,title,message_count,worlds_initialized) VALUES ($1,$2,$3,'Story',1,true)", [conversationId, owner, characterId]);
  await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','*Maya waits.*')", [crypto.randomUUID(), conversationId, owner]);
  // One warm-up transaction, so the pool's one-off row-level-security probe is
  // not billed to the first interaction measured.
  await asUser(owner, (client) => client.query("SELECT 1"));
  log.reset();
});

describe("database round trips per interaction", () => {
  it("measures the chats list", async () => {
    await conversations.GET(new Request("http://test/api/conversations?scope=all"));
    expect(report("GET /api/conversations?scope=all", log)).toBeLessThanOrEqual(3);
  });

  it("measures opening a conversation", async () => {
    log.reset();
    await conversations.GET(new Request(`http://test/api/conversations?characterId=${characterId}&conversationId=${conversationId}`));
    expect(report("GET /api/conversations (open chat)", log)).toBeLessThanOrEqual(4);
  });

  it("measures changing response length", async () => {
    log.reset();
    const response = await conversationDetail.PATCH(
      new Request(`http://test/api/conversations/${conversationId}`, { method: "PATCH", body: JSON.stringify({ responseLength: "concise" }) }),
      { params: Promise.resolve({ id: conversationId }) },
    );
    expect(response.status).toBe(200);
    expect(report("PATCH /api/conversations/[id]", log)).toBeLessThanOrEqual(4);
  });

  it("measures what a creation page downloads", async () => {
    // 100,000 characters is the Paste Everything ceiling, and it used to ship
    // on every view of the page by its owner.
    await query("UPDATE characters SET source_material=$1 WHERE id=$2", ["x".repeat(100_000), characterId]);
    log.reset();
    const page = await characterDetail.GET(new Request(`http://test/api/characters/${characterId}`), { params: Promise.resolve({ id: characterId }) });
    const pageBytes = (await page.text()).length;
    const edit = await characterDetail.GET(new Request(`http://test/api/characters/${characterId}?scope=edit`), { params: Promise.resolve({ id: characterId }) });
    const editBytes = (await edit.text()).length;
    console.log(`${"GET /api/characters/[id] payload".padEnd(42)} page=${pageBytes.toLocaleString()} bytes  edit=${editBytes.toLocaleString()} bytes`);
    expect(editBytes - pageBytes).toBeGreaterThan(90_000);
    expect(pageBytes).toBeLessThan(10_000);
  });

  it("measures the shell's creation list", async () => {
    log.reset();
    await characters.GET(new Request("http://test/api/characters"));
    const owned = modelled(log);
    log.reset();
    await characters.GET(new Request("http://test/api/characters?scope=chats"));
    console.log(`${"GET /api/characters (both shell calls)".padEnd(42)} round-trips(prod)=${owned + modelled(log)}`);
    expect(owned).toBeLessThanOrEqual(4);
  });
});
