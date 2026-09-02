import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAccount, createAccount, migratedPool, tenancyDatabaseUrl } from "./helpers/tenancy";

/**
 * THE TEST THAT WOULD HAVE CAUGHT IT, AND DID NOT EXIST.
 *
 * `background_job_health` shipped, and in production every write to it was
 * refused:
 *
 *   [background-health] could not record a success
 *   new row violates row-level security policy for table "background_job_health"
 *   code 42501
 *
 * pg-mem implements neither roles nor policies, so the suites that covered this
 * table's BEHAVIOUR could not see its ACCESS at all — they exercised the SQL
 * against a database where row level security does not exist. And the real
 * PostgreSQL suite never applied migrations 0032–0034, because
 * `migrationFiles` is a named list and nobody added them.
 *
 * So this file runs the production path against a real PostgreSQL: the real
 * migration files, the real policy, and the exact session `asUser()` opens —
 * `BEGIN; SET LOCAL ROLE authenticated; set_config('request.jwt.claims', …)`.
 *
 * Skipped without TEST_DATABASE_URL so `npm test` still runs anywhere; CI
 * provides a PostgreSQL service.
 */
const describeTenancy = tenancyDatabaseUrl ? describe : describe.skip;

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const aliceCharacter = "aaaaaaaa-0000-4000-8000-000000000031";
const aliceConversation = "cccccccc-0000-4000-8000-000000000031";
const bobCharacter = "aaaaaaaa-0000-4000-8000-000000000032";
const bobConversation = "cccccccc-0000-4000-8000-000000000032";

/** Byte-for-byte the statement `recordBackgroundSuccess` sends. */
const recordSuccess = `INSERT INTO background_job_health
   (conversation_id,user_id,task,last_success_at,last_success_model,last_success_candidate,
    last_success_used_fallback,consecutive_failures,updated_at)
 VALUES ($1,$2,$3,now(),$4,$5,$6,0,now())
 ON CONFLICT (conversation_id,task) DO UPDATE SET
   last_success_at=now(),
   last_success_model=EXCLUDED.last_success_model,
   last_success_candidate=EXCLUDED.last_success_candidate,
   last_success_used_fallback=EXCLUDED.last_success_used_fallback,
   consecutive_failures=0,
   updated_at=now()`;

/** Byte-for-byte the statement `recordBackgroundFailure` sends. */
const recordFailure = `INSERT INTO background_job_health
   (conversation_id,user_id,task,last_failure_at,last_failure_model,last_failure_candidate,
    last_failure_reason,consecutive_failures,updated_at)
 VALUES ($1,$2,$3,now(),$4,$5,$6,1,now())
 ON CONFLICT (conversation_id,task) DO UPDATE SET
   last_failure_at=now(),
   last_failure_model=EXCLUDED.last_failure_model,
   last_failure_candidate=EXCLUDED.last_failure_candidate,
   last_failure_reason=EXCLUDED.last_failure_reason,
   consecutive_failures=background_job_health.consecutive_failures+1,
   updated_at=now()`;

describeTenancy("background job health, under the real policies", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await migratedPool({ database: "background_health" });
    await createAccount(pool, alice, "alice@example.com");
    await createAccount(pool, bob, "bob@example.com");
    await asAccount(pool, alice, async (run) => {
      await run("INSERT INTO characters (id,name,user_id) VALUES ($1,'Maya',$2)", [aliceCharacter, alice]);
      await run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Alice story')", [aliceConversation, aliceCharacter, alice]);
    });
    await asAccount(pool, bob, async (run) => {
      await run("INSERT INTO characters (id,name,user_id) VALUES ($1,'Uki',$2)", [bobCharacter, bob]);
      await run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Bob story')", [bobConversation, bobCharacter, bob]);
    });
  });
  afterAll(async () => { await pool?.end(); });

  it("lets an owner record a success — the write production refused", async () => {
    /*
     * This is the exact failure, in the exact session. Nothing about it is a
     * simplification: the statement, the parameters, the role and the claims
     * are what `recordBackgroundSuccess` produces through `userQuery`.
     */
    await asAccount(pool, alice, async (run) => {
      await run(recordSuccess, [aliceConversation, alice, "memory_consolidation", "deepseek-v4-flash", "direct_deepseek", true]);
      const stored = await run("SELECT * FROM background_job_health WHERE conversation_id=$1", [aliceConversation]);
      expect(stored.rowCount).toBe(1);
      expect(stored.rows[0].last_success_model).toBe("deepseek-v4-flash");
      expect(stored.rows[0].last_success_used_fallback).toBe(true);
      expect(Number(stored.rows[0].consecutive_failures)).toBe(0);
    });
  });

  it("lets an owner record a failure and update in place", async () => {
    // The ON CONFLICT path is a separate RLS question: an UPDATE is checked
    // against USING on the existing row AND WITH CHECK on the new one.
    await asAccount(pool, alice, async (run) => {
      await run(recordFailure, [aliceConversation, alice, "memory_consolidation", "ling-3.0-flash", "ling_3_flash", "empty_response"]);
      await run(recordFailure, [aliceConversation, alice, "memory_consolidation", "ling-3.0-flash", "ling_3_flash", "empty_response"]);
      const stored = await run("SELECT * FROM background_job_health WHERE conversation_id=$1", [aliceConversation]);
      expect(Number(stored.rows[0].consecutive_failures)).toBe(2);
      // And the earlier success is still on the row, which is what lets an
      // operator see a job that has been failing since it last worked.
      expect(stored.rows[0].last_success_model).toBe("deepseek-v4-flash");
    });
  });

  it("reads back only the owner's rows", async () => {
    await asAccount(pool, bob, async (run) => {
      await run(recordSuccess, [bobConversation, bob, "memory_curation", "deepseek-v4-flash", "direct_deepseek", false]);
    });
    const mine = await asAccount(pool, alice, (run) => run("SELECT conversation_id FROM background_job_health"));
    expect(mine.rowCount).toBe(1);
    expect(String(mine.rows[0].conversation_id)).toBe(aliceConversation);
  });

  it("refuses to let one account write a row belonging to another", async () => {
    /*
     * The direction the policy exists for. Bob naming Alice's user_id is
     * refused by WITH CHECK; Bob naming his own id against Alice's conversation
     * is refused by the foreign key relationship he cannot see. Both are
     * failures, and the first is the one that matters.
     */
    await expect(asAccount(pool, bob, (run) =>
      run(recordSuccess, [aliceConversation, alice, "memory_consolidation", "x", "y", false]),
    )).rejects.toThrow(/row-level security/i);
  });

  it("refuses to let one account read or update another's row", async () => {
    await asAccount(pool, bob, async (run) => {
      const seen = await run("SELECT * FROM background_job_health WHERE conversation_id=$1", [aliceConversation]);
      expect(seen.rowCount).toBe(0);
      // An UPDATE that matches nothing visible changes nothing, silently and
      // correctly: there is no row there as far as Bob is concerned.
      const updated = await run("UPDATE background_job_health SET consecutive_failures=99 WHERE conversation_id=$1", [aliceConversation]);
      expect(updated.rowCount).toBe(0);
    });
    const untouched = await asAccount(pool, alice, (run) =>
      run("SELECT consecutive_failures FROM background_job_health WHERE conversation_id=$1", [aliceConversation]));
    expect(Number(untouched.rows[0].consecutive_failures)).toBe(2);
  });

  it("keeps FORCE row level security on, so the owner is bound by it too", async () => {
    const state = await pool.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='background_job_health'",
    );
    expect(state.rows[0].relrowsecurity).toBe(true);
    expect(state.rows[0].relforcerowsecurity).toBe(true);
    // And exactly one policy, granting exactly the owner.
    const policies = await pool.query("SELECT polname, polcmd FROM pg_policy WHERE polrelid='background_job_health'::regclass");
    expect(policies.rowCount).toBe(1);
    expect(policies.rows[0].polname).toBe("background_job_health_all_own");
    expect(policies.rows[0].polcmd).toBe("*");
  });

  it("gives a signed-out visitor nothing at all", async () => {
    /*
     * `anon` is refused before RLS is even consulted: migration 0001 grants
     * USAGE on `public` to `authenticated` only, so the table is not merely
     * unreadable to a signed-out visitor, it is invisible. Either message is
     * the right answer — the assertion is that the query cannot succeed — and
     * pinning the exact wording would be pinning which layer said no.
     */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE anon");
      await expect(client.query("SELECT * FROM background_job_health"))
        .rejects.toThrow(/permission denied|does not exist/i);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});

/**
 * THE STATE PRODUCTION WAS ACTUALLY IN, AND THE REPAIR THAT LEAVES IT.
 *
 * `ensureSchema()` creates this table on every boot — Afterglow has to be able
 * to stand up a plain PostgreSQL — while `supabase/migrations` is applied by
 * hand. So a deploy makes the table before anybody runs the migration, and on a
 * Supabase project (new public tables inherit grants to `authenticated`, and are
 * protected as exposed tables) that lands on: guarded, granted, and no policy.
 *
 * Which is not an obscure state. It is the ONE state whose error message is
 * "new row violates row-level security policy", and it is what the logs said.
 */
describeTenancy("the half-created state, and migration 0034", () => {
  let pool: Pool;

  beforeAll(async () => {
    // Everything up to the migration that creates the table, so the next step
    // can create it the way a boot does.
    pool = await migratedPool({ database: "background_health_repair", through: "0032_background_routing_and_scene_ledger.sql" });
    await createAccount(pool, alice, "alice@example.com");
    await asAccount(pool, alice, async (run) => {
      await run("INSERT INTO characters (id,name,user_id) VALUES ($1,'Maya',$2)", [aliceCharacter, alice]);
      await run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Alice story')", [aliceConversation, aliceCharacter, alice]);
    });
    // The table exactly as `ensureSchema()` makes it: no policy of its own.
    await pool.query(`CREATE TABLE IF NOT EXISTS background_job_health (
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL, task text NOT NULL,
      last_success_at timestamptz, last_success_model text NOT NULL DEFAULT '',
      last_success_candidate text, last_success_used_fallback boolean NOT NULL DEFAULT false,
      last_failure_at timestamptz, last_failure_model text NOT NULL DEFAULT '',
      last_failure_candidate text, last_failure_reason text NOT NULL DEFAULT '',
      consecutive_failures integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, task))`);
    // …and the two things a Supabase project does to a new public table.
    await pool.query("GRANT SELECT,INSERT,UPDATE,DELETE ON background_job_health TO authenticated");
    await pool.query("ALTER TABLE background_job_health ENABLE ROW LEVEL SECURITY");
  });
  afterAll(async () => { await pool?.end(); });

  it("reproduces the production error exactly", async () => {
    await expect(asAccount(pool, alice, (run) =>
      run(recordSuccess, [aliceConversation, alice, "memory_consolidation", "deepseek-v4-flash", "direct_deepseek", false]),
    )).rejects.toMatchObject({
      code: "42501",
      message: expect.stringContaining("new row violates row-level security policy"),
    });
  });

  it("is repaired by 0034, without disabling anything", async () => {
    const { applyMigrations } = await import("./helpers/tenancy");
    await applyMigrations(pool, ["0033_background_job_health.sql", "0034_background_job_health_policy_repair.sql"]);

    await asAccount(pool, alice, async (run) => {
      await run(recordSuccess, [aliceConversation, alice, "memory_consolidation", "deepseek-v4-flash", "direct_deepseek", false]);
      expect((await run("SELECT * FROM background_job_health")).rowCount).toBe(1);
    });

    // The repair adds a policy. It does not remove a guard.
    const state = await pool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='background_job_health'");
    expect(state.rows[0].relrowsecurity).toBe(true);
    expect(state.rows[0].relforcerowsecurity).toBe(true);
  });

  it("is safe to apply twice", async () => {
    const { applyMigrations } = await import("./helpers/tenancy");
    await applyMigrations(pool, ["0034_background_job_health_policy_repair.sql"]);
    const policies = await pool.query("SELECT polname FROM pg_policy WHERE polrelid='background_job_health'::regclass");
    expect(policies.rowCount).toBe(1);
    await asAccount(pool, alice, async (run) => {
      await run(recordFailure, [aliceConversation, alice, "memory_consolidation", "ling-3.0-flash", "ling_3_flash", "empty_response"]);
      expect((await run("SELECT consecutive_failures FROM background_job_health")).rows[0].consecutive_failures).toBe(1);
    });
  });
});
