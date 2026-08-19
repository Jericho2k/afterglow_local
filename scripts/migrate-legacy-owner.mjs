#!/usr/bin/env node
/**
 * Assigns every pre-migration row to one Supabase account.
 *
 * The original database has no concept of a user, so ownership cannot be
 * inferred — it has to be told which account inherits the single owner's data.
 * Nothing is dropped or rewritten beyond setting user_id on rows that do not
 * have one, so the script is safe to re-run and safe to run before or after
 * new accounts start signing up.
 *
 *   DATABASE_URL=postgresql://…                  \
 *   LEGACY_OWNER_USER_ID=<uuid from auth.users>  \
 *   node scripts/migrate-legacy-owner.mjs [--commit] [--enforce]
 *
 * Without --commit it reports what it would claim and rolls back.
 * With --enforce it additionally sets the ownership columns NOT NULL, which
 * should only be done once no unowned rows remain.
 */

import { Pool } from "pg";

const ownerId = process.env.LEGACY_OWNER_USER_ID;
const commit = process.argv.includes("--commit");
const enforce = process.argv.includes("--enforce");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId ?? "")) {
  console.error("LEGACY_OWNER_USER_ID must be the UUID of an existing Supabase account (Dashboard → Authentication → Users).");
  process.exit(1);
}

// Ordered so parents are claimed before the rows that reference them.
const ownedTables = [
  "characters",
  "worlds",
  "personas",
  "conversations",
  "messages",
  "memories",
  "memory_arcs",
  "usage_events",
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const account = await client.query("SELECT id FROM auth.users WHERE id=$1", [ownerId]);
  if (!account.rowCount) throw new Error(`No Supabase account exists with id ${ownerId}. Create or invite the account first.`);

  await client.query(
    "INSERT INTO profiles (id,display_name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING",
    [ownerId, process.env.OWNER_NAME || "Owner"],
  );
  await client.query("INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [ownerId]);

  // Carry the single-owner settings row over to the account's own settings.
  await client.query(
    `UPDATE user_settings u SET
       owner_name=a.owner_name, owner_profile=a.owner_profile, model=a.model, roleplay_preset=a.roleplay_preset,
       temperature=a.temperature, max_tokens=a.max_tokens, context_messages=a.context_messages,
       context_token_budget=a.context_token_budget, consolidation_interval=a.consolidation_interval,
       memory_limit=a.memory_limit, memory_token_budget=a.memory_token_budget, updated_at=now()
     FROM app_settings a WHERE a.id='owner' AND u.user_id=$1`,
    [ownerId],
  );

  const claimed = {};
  for (const table of ownedTables) {
    const result = await client.query(`UPDATE ${table} SET user_id=$1 WHERE user_id IS NULL`, [ownerId]);
    claimed[table] = result.rowCount;
  }

  // The legacy database allowed exactly one default persona overall; the new
  // unique index is per account, so nothing has to change here beyond making
  // sure the owner ends up with exactly one.
  const defaults = await client.query("SELECT COUNT(*)::int count FROM personas WHERE user_id=$1 AND is_default", [ownerId]);
  if (Number(defaults.rows[0].count) === 0) {
    await client.query(
      "UPDATE personas SET is_default=true WHERE id=(SELECT id FROM personas WHERE user_id=$1 ORDER BY created_at ASC LIMIT 1)",
      [ownerId],
    );
  }

  const leftovers = {};
  for (const table of ownedTables) {
    const result = await client.query(`SELECT COUNT(*)::int count FROM ${table} WHERE user_id IS NULL`);
    leftovers[table] = Number(result.rows[0].count);
  }
  const unowned = Object.values(leftovers).reduce((total, count) => total + count, 0);

  if (enforce) {
    if (unowned > 0) throw new Error(`Cannot enforce NOT NULL while ${unowned} rows are still unowned: ${JSON.stringify(leftovers)}`);
    for (const table of ownedTables) {
      await client.query(`ALTER TABLE ${table} ALTER COLUMN user_id SET NOT NULL`);
    }
  }

  console.table(claimed);
  console.log(`Rows still unowned after this run: ${unowned}`);
  console.log(enforce ? "Ownership columns set to NOT NULL." : "Ownership columns left nullable (pass --enforce once every row is claimed).");

  if (commit) {
    await client.query("COMMIT");
    console.log("Committed.");
  } else {
    await client.query("ROLLBACK");
    console.log("Dry run only — nothing was written. Re-run with --commit to apply.");
  }
} catch (error) {
  await client.query("ROLLBACK");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
