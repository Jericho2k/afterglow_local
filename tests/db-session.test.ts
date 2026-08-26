import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, migratedPool, tenancyDatabaseUrl } from "./helpers/tenancy";
import { asUser, setPoolForTesting } from "@/lib/db";

/**
 * The application's own database session, against the real policies.
 *
 * `tests/tenancy.test.ts` proves the POLICIES are right, but it does so through
 * a helper of its own that reproduces the session setup rather than importing
 * it. So the one function every authenticated request in the product actually
 * goes through — `asUser` in src/lib/db.ts — had no test that it applies those
 * policies at all. That gap predates this sprint and it is the wrong gap to
 * have: a mistake there does not fail loudly, it silently runs every statement
 * as the pool's privileged role with row level security bypassed.
 *
 * It matters more now because `asUser` was changed. It used to open its
 * transaction and publish the caller's identity in three round trips; it does
 * it in one simple-protocol statement, because that ceremony was a measurable
 * share of every interaction in the product. The question that change raises is
 * exactly the question below: does an explicit BEGIN inside a multi-statement
 * query leave the transaction open, or does the implicit transaction around the
 * query commit it — taking `SET LOCAL` with it and dropping the connection back
 * to superuser for the statements that follow?
 *
 * Skipped without TEST_DATABASE_URL, like the isolation suite. CI provides a
 * PostgreSQL service, so this runs there.
 */
const describeSession = tenancyDatabaseUrl ? describe : describe.skip;

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const aliceCharacter = "aaaaaaaa-0000-4000-8000-000000000031";
const bobCharacter = "aaaaaaaa-0000-4000-8000-000000000032";

describeSession("asUser is the enforcement boundary", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await migratedPool();
    await createAccount(pool, alice, "alice@example.com");
    await createAccount(pool, bob, "bob@example.com");
    // Seeded with the privileged pool role, so the reads below are the only
    // thing under test.
    await pool.query("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Alice Only',$2,'private')", [aliceCharacter, alice]);
    await pool.query("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Bob Only',$2,'private')", [bobCharacter, bob]);
    setPoolForTesting(pool);
  });

  afterAll(async () => { await pool.end(); });

  it("runs its work as the authenticated role, with the caller's claims", async () => {
    const session = await asUser(alice, async (client) => (await client.query(
      "SELECT current_user, current_setting('request.jwt.claims', true) claims, auth.uid()::text uid",
    )).rows[0]);
    // If the combined statement had been committed by the implicit transaction
    // around it, all three of these would be wrong — and nothing else in the
    // product would have noticed.
    expect(session.current_user).toBe("authenticated");
    expect(JSON.parse(session.claims).sub).toBe(alice);
    expect(session.uid).toBe(alice);
  });

  it("actually enforces row level security on the caller's behalf", async () => {
    const mine = await asUser(alice, async (client) => (await client.query("SELECT id FROM characters WHERE visibility='private'")).rows);
    expect(mine.map((row) => String(row.id))).toEqual([aliceCharacter]);

    const theirs = await asUser(bob, async (client) => (await client.query("SELECT id FROM characters WHERE visibility='private'")).rows);
    expect(theirs.map((row) => String(row.id))).toEqual([bobCharacter]);
  });

  it("refuses a write into another account", async () => {
    await expect(asUser(bob, (client) => client.query(
      "INSERT INTO characters (id,name,user_id) VALUES ($1,'Forged',$2)",
      ["aaaaaaaa-0000-4000-8000-000000000033", alice],
    ))).rejects.toThrow();
  });

  it("returns the connection to the pool carrying no identity", async () => {
    // The reason both settings are transaction-scoped. A connection that kept
    // one account's role or claims would hand them to whoever borrowed it next,
    // which is the worst failure this file can catch.
    await asUser(alice, (client) => client.query("SELECT 1"));
    const after = await pool.query("SELECT current_user, current_setting('request.jwt.claims', true) claims");
    expect(after.rows[0].current_user).not.toBe("authenticated");
    expect(after.rows[0].claims ?? "").toBe("");
  });

  it("returns it clean after a failure, too", async () => {
    await expect(asUser(alice, (client) => client.query("SELECT * FROM nothing_of_the_sort"))).rejects.toThrow();
    const after = await pool.query("SELECT current_user, current_setting('request.jwt.claims', true) claims");
    expect(after.rows[0].current_user).not.toBe("authenticated");
    expect(after.rows[0].claims ?? "").toBe("");
  });

  it("commits work that succeeded", async () => {
    // The other half of "the transaction stayed open": it also has to close.
    const id = "aaaaaaaa-0000-4000-8000-000000000034";
    await asUser(alice, (client) => client.query("INSERT INTO characters (id,name,user_id) VALUES ($1,'Committed',$2)", [id, alice]));
    expect((await pool.query("SELECT name FROM characters WHERE id=$1", [id])).rows[0].name).toBe("Committed");
  });

  it("rolls back work that did not", async () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000035";
    await expect(asUser(alice, async (client) => {
      await client.query("INSERT INTO characters (id,name,user_id) VALUES ($1,'Doomed',$2)", [id, alice]);
      throw new Error("something went wrong after the write");
    })).rejects.toThrow("something went wrong");
    expect((await pool.query("SELECT id FROM characters WHERE id=$1", [id])).rowCount).toBe(0);
  });

  it("refuses an account id that is not one", async () => {
    // The claims are inlined into the statement, so this check is the thing
    // that makes that safe. It must reject before any statement is sent.
    for (const identity of ["'; DROP TABLE characters; --", "alice", "", "1"]) {
      await expect(asUser(identity, (client) => client.query("SELECT 1"))).rejects.toThrow(/valid account id/);
    }
    expect((await pool.query("SELECT to_regclass('public.characters') AS present")).rows[0].present).toBe("characters");
  });
});
