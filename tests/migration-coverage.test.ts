import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationFiles, migrationsNotApplied } from "./helpers/tenancy";

/**
 * Every migration is either applied by the isolation suite or excluded on
 * purpose.
 *
 * The suite's file list is deliberately named rather than globbed, so that a
 * test can stop part-way through and check a backfill against data that
 * predates it. The cost of that decision is drift, and the drift is silent:
 * the list stopped at 0031 while production went on to 0037, so the row level
 * security suite spent several releases exercising a schema no deployment
 * has — and the first thing to notice was a CI failure on a column the tests
 * could not see.
 *
 * This makes the gap loud. Adding a migration and forgetting the list now
 * fails here, in a test that names the file, rather than somewhere downstream
 * that names a column.
 */
describe("the isolation suite applies the real migration set", () => {
  const onDisk = readdirSync(new URL("../supabase/migrations", import.meta.url))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  it("accounts for every file in supabase/migrations", () => {
    const accounted = new Set<string>([...migrationFiles, ...migrationsNotApplied]);
    expect(onDisk.filter((file) => !accounted.has(file))).toEqual([]);
  });

  it("lists nothing that does not exist", () => {
    const present = new Set(onDisk);
    expect([...migrationFiles, ...migrationsNotApplied].filter((file) => !present.has(file))).toEqual([]);
  });

  it("applies them in the order production does", () => {
    const applied = [...migrationFiles];
    expect(applied).toEqual([...applied].sort());
  });
});
