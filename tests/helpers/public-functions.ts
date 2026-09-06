import { readFileSync } from "node:fs";
import { DataType, newDb, type IMemoryDb } from "pg-mem";

/**
 * The real anonymous SQL, running in the in-memory suite.
 *
 * `ensureSchema` builds tables and nothing else — the public functions live
 * only in supabase/migrations, and pg-mem has no `migrate` step. So the
 * anonymous half of the product used to be untestable without a PostgreSQL
 * server: every test that wanted to know what a logged-out reader receives had
 * to stub `publicSafeLanding` and assert against its own idea of the row.
 *
 * That is exactly the wrong place to guess. The blanking that makes a gated
 * creation safe, and the columns that carry a creator's framing outward, are
 * SQL — a test that supplies the row it wants cannot fail when the SQL stops
 * supplying it.
 *
 * So the function bodies are read out of the migration files and defined here,
 * verbatim apart from three things pg-mem's parser cannot take:
 *
 *   * comments, which it lexes and chokes on (an em-dash inside one is enough);
 *   * `SECURITY DEFINER`, which it has no concept of;
 *   * `SET search_path`, likewise.
 *
 * None of the three is part of the projection, which is what these tests are
 * about. Row level security and the grants are a different suite entirely —
 * tests/helpers/tenancy.ts, against a real server — and this does not pretend
 * to cover them.
 */

/** One `CREATE FUNCTION` from a migration, as pg-mem will accept it. */
export function publicFunctionSql(migration: string, name: string) {
  const sql = readFileSync(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8");
  const start = sql.indexOf(`CREATE FUNCTION public.${name}`);
  if (start < 0) throw new Error(`${name} is not defined in ${migration}`);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + 3)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace("SECURITY DEFINER", "")
    .replace("SET search_path = public", "");
}

/**
 * The scalar functions the product's SQL uses and pg-mem does not implement.
 *
 * Registered rather than worked around, so the migration text stays verbatim.
 */
export function registerSqlBuiltins(db: IMemoryDb) {
  db.public.registerFunction({
    name: "date_trunc", args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz,
    implementation: (unit: string, value: Date) => { const out = new Date(value); if (unit === "day") out.setHours(0, 0, 0, 0); return out; },
  });
  db.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  db.public.registerFunction({
    name: "btrim", args: [DataType.text], returns: DataType.text,
    allowNullArguments: true,
    implementation: (value: string | null) => (value ?? "").trim(),
  });
  db.public.registerFunction({
    name: "nullif", args: [DataType.text, DataType.text], returns: DataType.text,
    allowNullArguments: true,
    implementation: (value: string | null, against: string | null) => (value === against ? null : value),
  });
  db.public.registerFunction({
    name: "concat_ws", args: [DataType.text, DataType.text, DataType.text], returns: DataType.text,
    allowNullArguments: true,
    implementation: (separator: string, first: string | null, second: string | null) =>
      [first, second].filter(Boolean).join(separator),
  });
}

/** A database with the application's tables and the public functions in it. */
export function publicSqlDatabase() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  registerSqlBuiltins(db);
  return db;
}

/**
 * The functions the anonymous view model calls, in the file each is CURRENTLY
 * defined in.
 *
 * A function redefined by a later migration is listed at its newest definition,
 * which is what a deployment has after applying all of them. Moving an entry
 * when a migration redefines a function is the point: forgetting to is a test
 * exercising SQL nobody runs.
 */
export const publicViewFunctions: { migration: string; name: string }[] = [
  { migration: "0039_share_card_artwork.sql", name: "public_creation_safe_landing" },
  { migration: "0037_art_presentation_and_links.sql", name: "public_creation_page" },
  { migration: "0037_art_presentation_and_links.sql", name: "public_creation_card" },
  { migration: "0037_art_presentation_and_links.sql", name: "public_creator_creations" },
  { migration: "0037_art_presentation_and_links.sql", name: "public_creator_profile" },
  { migration: "0036_public_content_modes.sql", name: "public_creation_gallery" },
];

/*
 * `public_creation_cast`, which pg-mem cannot run.
 *
 * The real function is a `CROSS JOIN LATERAL jsonb_array_elements(c.cast_members)`
 * and pg-mem does not resolve the outer alias inside the lateral, so it reports
 * a column that plainly exists as missing. `publicCreationPage` calls it on
 * every request, so a page test needs SOMETHING at that name.
 *
 * This is that something, and it is deliberately not an imitation: it answers
 * "no cast members" for every creation, and it is named so nobody mistakes it
 * for coverage. A test that cares what the cast function returns belongs in the
 * tenancy suite, which runs the migrations against a real PostgreSQL.
 */
export const emptyCastFunctionForPgMem =
  "CREATE FUNCTION public_creation_cast(p_id uuid) RETURNS TABLE (member jsonb) LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb WHERE false; $$;";
