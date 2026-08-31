import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAccount, createAccount, migratedPool, tenancyDatabaseUrl, visibleCount } from "./helpers/tenancy";

/**
 * The provenance tables, against the real policies.
 *
 * pg-mem implements neither roles nor policies, so the unit tests elsewhere
 * cannot answer this question at all. Skipped without TEST_DATABASE_URL; CI
 * provides a PostgreSQL service, so these do run there.
 *
 * WHAT IS AT STAKE HERE IS NOT ONLY TEXT. A generation row names memory ids,
 * transcript ids, a scene state and a retrieval run. Being able to read one for
 * somebody else's story would leak the SHAPE of that story — how long it is,
 * how much it remembers, when it was written — even if every id resolved to
 * nothing. So the test below checks that the rows are invisible, not merely
 * that their contents are.
 */
const describeTenancy = tenancyDatabaseUrl ? describe : describe.skip;

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const aliceCharacter = "aaaaaaaa-0000-4000-8000-000000000031";
const aliceConversation = "cccccccc-0000-4000-8000-000000000031";
const aliceMessage = "dddddddd-0000-4000-8000-000000000031";
const aliceMemory = "eeeeeeee-0000-4000-8000-000000000031";
const aliceGeneration = "abababab-0000-4000-8000-000000000031";
const aliceMemoryVersion = "bcbcbcbc-0000-4000-8000-000000000031";
const aliceMessageVersion = "cdcdcdcd-0000-4000-8000-000000000031";

describeTenancy("generation provenance is owner-scoped", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await migratedPool();
    await createAccount(pool, alice, "alice-prov@example.com");
    await createAccount(pool, bob, "bob-prov@example.com");

    await asAccount(pool, alice, async (run) => {
      await run("INSERT INTO characters (id,user_id,name,visibility) VALUES ($1,$2,'Mara','private')", [aliceCharacter, alice]);
      await run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Private story')", [aliceConversation, aliceCharacter, alice]);
      await run("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','A reply nobody else may read')", [aliceMessage, aliceConversation, alice]);
      await run("INSERT INTO memories (id,character_id,conversation_id,user_id,content) VALUES ($1,$2,$3,$4,'A private fact')", [aliceMemory, aliceCharacter, aliceConversation, alice]);
      await run(
        `INSERT INTO message_generations (id,message_id,conversation_id,user_id,variant_index,action,memory_versions,transcript_versions)
         VALUES ($1,$2,$3,$4,0,'send',$5::jsonb,$6::jsonb)`,
        [aliceGeneration, aliceMessage, aliceConversation, alice, JSON.stringify([{ id: aliceMemory, v: 1 }]), JSON.stringify([{ id: aliceMessage, v: 1 }])],
      );
      await run("INSERT INTO memory_versions (id,memory_id,user_id,version,content) VALUES ($1,$2,$3,1,'The original wording')", [aliceMemoryVersion, aliceMemory, alice]);
      await run("INSERT INTO message_versions (id,message_id,user_id,version,role,content) VALUES ($1,$2,$3,1,'assistant','The original reply')", [aliceMessageVersion, aliceMessage, alice]);
    });
  });

  afterAll(async () => { await pool?.end(); });

  it("lets the owner read their own provenance", async () => {
    expect(await visibleCount(pool, alice, "message_generations", "id=$1", [aliceGeneration])).toBe(1);
    expect(await visibleCount(pool, alice, "memory_versions", "id=$1", [aliceMemoryVersion])).toBe(1);
    expect(await visibleCount(pool, alice, "message_versions", "id=$1", [aliceMessageVersion])).toBe(1);
  });

  it("shows another account nothing at all", async () => {
    expect(await visibleCount(pool, bob, "message_generations", "true")).toBe(0);
    expect(await visibleCount(pool, bob, "memory_versions", "true")).toBe(0);
    expect(await visibleCount(pool, bob, "message_versions", "true")).toBe(0);
  });

  it("does not let another account infer transcript or memory ids", async () => {
    // Naming the id directly must be as empty as listing everything, or the
    // shape of somebody else's story is readable one probe at a time.
    expect(await visibleCount(pool, bob, "message_generations", "message_id=$1", [aliceMessage])).toBe(0);
    expect(await visibleCount(pool, bob, "memory_versions", "memory_id=$1", [aliceMemory])).toBe(0);
    expect(await visibleCount(pool, bob, "message_versions", "message_id=$1", [aliceMessage])).toBe(0);
  });

  it("refuses a write attributed to somebody else", async () => {
    await expect(asAccount(pool, bob, (run) => run(
      `INSERT INTO message_generations (id,message_id,conversation_id,user_id,variant_index,action)
       VALUES ($1,$2,$3,$4,0,'send')`,
      ["fefefefe-0000-4000-8000-000000000031", aliceMessage, aliceConversation, alice],
    ))).rejects.toThrow();
  });

  it("refuses a write that forges an owner it does not have", async () => {
    // Same table, bob's own id on the row but alice's message: the FK resolves
    // only if bob can see the message, and he cannot.
    await expect(asAccount(pool, bob, (run) => run(
      `INSERT INTO memory_versions (id,memory_id,user_id,version,content) VALUES ($1,$2,$3,2,'forged')`,
      ["fefefefe-0000-4000-8000-000000000032", aliceMemory, bob],
    ))).rejects.toThrow();
  });

  it("cannot supersede or purge into another account's story", async () => {
    const changed = await asAccount(pool, bob, async (run) => {
      const updated = await run("UPDATE memories SET status='superseded' WHERE id=$1", [aliceMemory]);
      const deleted = await run("DELETE FROM memory_versions WHERE memory_id=$1", [aliceMemory]);
      return { updated: updated.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
    });
    expect(changed).toEqual({ updated: 0, deleted: 0 });
    // And alice's rows are exactly as she left them.
    expect(await visibleCount(pool, alice, "memories", "id=$1 AND status='active'", [aliceMemory])).toBe(1);
    expect(await visibleCount(pool, alice, "memory_versions", "memory_id=$1", [aliceMemory])).toBe(1);
  });

  it("forces row level security, so even a table owner is filtered", async () => {
    const forced = await asAccount(pool, alice, async (run) => {
      const result = await run(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname IN ('message_generations','memory_versions','message_versions')`,
      );
      return result.rows;
    });
    expect(forced).toHaveLength(3);
    for (const row of forced) {
      expect(row.relrowsecurity, String(row.relname)).toBe(true);
      expect(row.relforcerowsecurity, String(row.relname)).toBe(true);
    }
  });

  it("carries the consolidation cursor and the relevance clock as owner data", async () => {
    // Both are new columns on rows the policies already covered; this is the
    // check that the migrations did not add them to an unprotected surface.
    expect(await visibleCount(pool, bob, "conversations", "id=$1", [aliceConversation])).toBe(0);
    const columns = await asAccount(pool, alice, async (run) => {
      const result = await run(
        `SELECT column_name FROM information_schema.columns
         WHERE (table_name='conversations' AND column_name='last_consolidated_offset')
            OR (table_name='memories' AND column_name='last_relevance_match_count')
            OR (table_name='memories' AND column_name='content_version')
            OR (table_name='messages' AND column_name='content_version')`,
      );
      return result.rows.map((row) => String(row.column_name)).sort();
    });
    expect(columns).toEqual(["content_version", "content_version", "last_consolidated_offset", "last_relevance_match_count"]);
  });
});
