import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/**
 * Test harness for the row level security suite.
 *
 * These tests need a real PostgreSQL: pg-mem implements neither roles nor
 * policies, so it cannot answer the only question this suite asks. The
 * migrations under supabase/migrations are applied verbatim — the same files
 * that are applied to production — with only the Supabase-provided pieces
 * (auth.users, auth.uid(), the three roles) shimmed in.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export const tenancyDatabaseUrl = process.env.TEST_DATABASE_URL ?? "";

function sql(relativePath: string) {
  return readFileSync(`${root}${relativePath}`, "utf8");
}

export async function migratedPool() {
  const pool = new Pool({ connectionString: tenancyDatabaseUrl, max: 4, ssl: false });
  const client = await pool.connect();
  try {
    // Start from a clean schema so a re-run never inherits earlier state.
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await client.query("DROP SCHEMA IF EXISTS auth CASCADE;");
    await client.query(sql("supabase/testing/auth-shim.sql"));
    await client.query(sql("supabase/migrations/0000_baseline.sql"));
    await client.query(sql("supabase/migrations/0001_multi_tenant_foundation.sql"));
    await client.query(sql("supabase/migrations/0003_conversation_inference.sql"));
    await client.query(sql("supabase/migrations/0004_product_social.sql"));
  } finally {
    client.release();
  }
  return pool;
}

/** Creates an account the way Supabase Auth would, trigger included. */
export async function createAccount(pool: Pool, id: string, email: string) {
  await pool.query("INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [id, email]);
  return id;
}

/**
 * Runs statements exactly the way the application does: as the `authenticated`
 * role with the account's id published as JWT claims, so `auth.uid()` resolves
 * and the policies apply.
 */
export async function asAccount<T>(pool: Pool, userId: string, fn: (run: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    const result = await fn((text, values = []) => client.query(text, values));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Convenience: how many rows this account can see from a table. */
export async function visibleCount(pool: Pool, userId: string, table: string, where = "true", values: unknown[] = []) {
  return asAccount(pool, userId, async (run) => {
    const result = await run(`SELECT COUNT(*)::int count FROM ${table} WHERE ${where}`, values);
    return Number(result.rows[0].count);
  });
}
