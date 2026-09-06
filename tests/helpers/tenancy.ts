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

/**
 * The migration files, in the order production applies them.
 *
 * Named rather than globbed so a new file has to be added deliberately, and so
 * a test can stop part-way — which is what makes a BACKFILL testable at all:
 * you cannot check that a migration converts old data correctly unless you can
 * first create data that predates it.
 */
export const migrationFiles = [
  "0000_baseline.sql",
  "0001_multi_tenant_foundation.sql",
  "0003_conversation_inference.sql",
  "0004_product_social.sql",
  "0005_openrouter_usage.sql",
  "0006_memory_retrieval_v2.sql",
  "0007_productization_sprint_1.sql",
  "0008_canonical_generated_user_messages.sql",
  "0009_public_character_profile.sql",
  // 0010 is storage buckets, which the shim does not provide; 0011 and 0012
  // are ordinary schema and belong here, or the suite is testing a
  // `characters` table that production does not have.
  "0011_creation_model.sql",
  "0012_discovery_feed.sql",
  "0013_scene_state.sql",
  "0014_worlds_v2.sql",
  "0015_rich_content.sql",
  "0016_discovery_preferences.sql",
  "0017_linked_world_previews.sql",
  "0018_memory_feedback.sql",
  "0019_conversation_worlds.sql",
  "0020_scene_physical_state.sql",
  "0021_creator_profile_v2.sql",
  "0022_social_discovery.sql",
  "0023_branch_copy_indexes.sql",
  "0024_byok_creation_moderation.sql",
  "0025_writer_openrouter_byok.sql",
  "0026_memory_transparency.sql",
  "0027_consolidation_cursor.sql",
  "0028_generation_provenance.sql",
  "0029_story_distance_aging.sql",
  "0030_provenance_parent_ownership.sql",
  "0031_free_tier_and_curated_routes.sql",
  "0032_background_routing_and_scene_ledger.sql",
  "0033_background_job_health.sql",
  "0034_admin_writer_upstream_override.sql",
  "0035_writer_cache_probe.sql",
  "0036_public_content_modes.sql",
  "0037_art_presentation_and_links.sql",
  "0038_share_media_review.sql",
] as const;

/**
 * Files this list deliberately omits, and why.
 *
 * Anything else missing is DRIFT, not a decision — which is what happened
 * here: the list stopped at 0031 while production went on to 0037, so every
 * suite built on it was exercising a `characters` table that no deployment
 * has. `tests/migration-coverage.test.ts` compares this pair against the
 * directory so the next gap fails a test instead of a production migration.
 */
export const migrationsNotApplied = [
  // Supabase Storage buckets and their policies; the auth shim provides no
  // `storage` schema, and nothing in these suites reads an image.
  "0002_storage.sql",
  "0010_world_covers_storage.sql",
] as const;

export async function applyMigrations(pool: Pool, files: readonly string[]) {
  const client = await pool.connect();
  try {
    for (const file of files) await client.query(sql(`supabase/migrations/${file}`));
  } finally {
    client.release();
  }
}

/**
 * A database with the real migrations applied.
 *
 * `through` stops after the named file, so a test can seed the schema as it
 * stood before a migration and then apply that migration to it — which is the
 * only way to check that a BACKFILL converts existing data correctly.
 *
 * `database` puts a suite on a database of its own. Every suite here begins by
 * dropping and rebuilding its schema, and Vitest runs files in parallel, so two
 * suites sharing one database would tear each other's tables out mid-run. A
 * suite that needs its own migration order therefore needs its own database,
 * and asking for one by name is cheaper to reason about than making the whole
 * test run serial.
 */
export async function migratedPool(options: { through?: string; database?: string } = {}) {
  const connectionString = options.database ? await freshDatabase(options.database) : tenancyDatabaseUrl;
  const pool = new Pool({ connectionString, max: 4, ssl: false });
  const client = await pool.connect();
  try {
    // Start from a clean schema so a re-run never inherits earlier state.
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await client.query("DROP SCHEMA IF EXISTS auth CASCADE;");
    await client.query(sql("supabase/testing/auth-shim.sql"));
  } finally {
    client.release();
  }
  const stop = options.through ? migrationFiles.indexOf(options.through as typeof migrationFiles[number]) : migrationFiles.length - 1;
  if (stop < 0) throw new Error(`Unknown migration: ${options.through}`);
  await applyMigrations(pool, migrationFiles.slice(0, stop + 1));
  return pool;
}

/** Creates (or reuses) a sibling database beside the configured one. */
async function freshDatabase(name: string) {
  const url = new URL(tenancyDatabaseUrl);
  const target = `${url.pathname.replace(/^\//, "") || "postgres"}_${name}`;
  const admin = new Pool({ connectionString: tenancyDatabaseUrl, max: 1, ssl: false });
  try {
    // CREATE DATABASE cannot run inside a transaction, and IF NOT EXISTS is not
    // available for it, so an existing database is simply reused — the schema
    // rebuild above is what makes a re-run clean.
    await admin.query(`CREATE DATABASE ${JSON.stringify(target).replace(/"/g, '"')}`).catch((error) => {
      if (!String(error?.message ?? "").includes("already exists")) throw error;
    });
  } finally {
    await admin.end();
  }
  url.pathname = `/${target}`;
  return url.toString();
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
