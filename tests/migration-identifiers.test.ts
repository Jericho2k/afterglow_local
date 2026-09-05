import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Identifiers a migration may not use, checked without a database.
 *
 * The unit suite runs against pg-mem, which never parses a `CREATE FUNCTION`
 * body or its signature — so a migration can be fully green here and still fail
 * on the first line of a real `psql` run. That is not hypothetical: 0036
 * declared `RETURNS TABLE (… position integer)` and Supabase refused it with a
 * syntax error, because a RETURNS TABLE entry is a function PARAMETER name and
 * `position` is one of PostgreSQL's col_name_keywords — legal as a column on a
 * table, reserved as a parameter.
 *
 * The failure is silent in every check we run and loud in exactly the place
 * nobody wants it: a production migration, applied by hand, halfway down the
 * file. So the names are checked here instead.
 *
 * This is deliberately a keyword check and not a SQL parser. It catches the
 * class of mistake that has actually happened, cheaply, in the suite everybody
 * already runs.
 */

/*
 * PostgreSQL keywords that cannot be a function parameter name unquoted:
 * every fully reserved word, plus the col_name_keywords — the ones that may
 * name a column but not a parameter, which is the surprising half. From the
 * keyword appendix for PostgreSQL 16.
 */
const forbidden = new Set([
  // col_name_keyword — legal as a column, reserved as a parameter name.
  "between", "bigint", "bit", "boolean", "char", "character", "coalesce", "collation",
  "dec", "decimal", "exists", "extract", "float", "greatest", "grouping", "inout",
  "int", "integer", "interval", "json", "json_array", "json_object", "least",
  "national", "nchar", "none", "normalize", "nullif", "numeric", "out", "overlay",
  "position", "precision", "real", "row", "setof", "smallint", "substring", "time",
  "timestamp", "treat", "trim", "values", "varchar", "xmlattributes", "xmlconcat",
  "xmlelement", "xmlexists", "xmlforest", "xmlnamespaces", "xmlparse", "xmlpi",
  "xmlroot", "xmlserialize", "xmltable",
  // reserved_keyword
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric",
  "both", "case", "cast", "check", "collate", "column", "constraint", "create",
  "current_catalog", "current_date", "current_role", "current_time",
  "current_timestamp", "current_user", "default", "deferrable", "desc", "distinct",
  "do", "else", "end", "except", "false", "fetch", "for", "foreign", "from", "grant",
  "group", "having", "in", "initially", "intersect", "into", "lateral", "leading",
  "limit", "localtime", "localtimestamp", "not", "null", "offset", "on", "only",
  "or", "order", "placing", "primary", "references", "returning", "select",
  "session_user", "some", "symmetric", "system_user", "table", "then", "to",
  "trailing", "true", "union", "unique", "user", "using", "variadic", "when",
  "where", "window", "with",
]);

const migrationsDir = join(process.cwd(), "supabase", "migrations");

/** Every `RETURNS TABLE (...)` column name in a file, with its function. */
function returnsTableNames(sql: string) {
  const found: { fn: string; name: string }[] = [];
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const fn = match[1];
    const rest = sql.slice(match.index);
    const returns = /RETURNS\s+TABLE\s*\(/i.exec(rest);
    if (!returns) continue;
    // Only a RETURNS TABLE belonging to THIS function: anything past the next
    // CREATE FUNCTION is somebody else's signature.
    const nextFunction = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i.exec(rest.slice(10));
    if (nextFunction && returns.index > nextFunction.index + 10) continue;
    let depth = 1;
    let index = returns.index + returns[0].length;
    let body = "";
    while (index < rest.length && depth > 0) {
      const char = rest[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      if (depth > 0) body += char;
      index += 1;
    }
    // Strip comments, then read the first word of each declaration.
    const cleaned = body.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const entry of cleaned.split(",")) {
      const name = entry.trim().split(/\s+/)[0];
      if (name) found.push({ fn, name: name.toLowerCase() });
    }
  }
  return found;
}

describe("migration identifiers survive a real PostgreSQL", () => {
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

  it("has migrations to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never names a RETURNS TABLE column with a reserved or col_name keyword", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      for (const { fn, name } of returnsTableNames(sql)) {
        // A quoted name is a deliberate choice and legal; a bare one is not.
        if (forbidden.has(name)) offenders.push(`${file}: ${fn}(...) returns a column named "${name}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("recognises the mistake it exists to catch", () => {
    // The exact declaration Supabase rejected, so this test cannot quietly stop
    // detecting anything by having its parser drift.
    const sample = `CREATE FUNCTION public.sample(p_id uuid)
      RETURNS TABLE (id uuid, caption text, position integer)
      LANGUAGE sql AS $$ SELECT 1 $$;`;
    expect(returnsTableNames(sample).map((entry) => entry.name)).toContain("position");
  });

  it("reads every declaration in a multi-line signature", () => {
    const sample = `CREATE FUNCTION public.a(p uuid) RETURNS TABLE (
      id uuid, name text,
      -- a comment between declarations
      created_at timestamptz
    ) LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE FUNCTION public.b(p uuid) RETURNS TABLE (slug text) LANGUAGE sql AS $$ SELECT 1 $$;`;
    const names = returnsTableNames(sample);
    expect(names.filter((entry) => entry.fn === "public.a").map((entry) => entry.name))
      .toEqual(["id", "name", "created_at"]);
    expect(names.filter((entry) => entry.fn === "public.b").map((entry) => entry.name)).toEqual(["slug"]);
  });
});
