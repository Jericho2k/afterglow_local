import type { PoolClient } from "pg";

/**
 * Inserts already-normalised rows with a bounded number of PostgreSQL
 * parameters per statement.  Branching used to issue one INSERT per copied
 * object; this keeps the exact same transaction and mapping semantics while
 * turning hundreds of network round trips into one statement per object kind.
 */
export async function insertValueRows(
  client: PoolClient,
  prefix: string,
  rows: unknown[][],
  options: { casts?: Record<number, string>; suffix?: string; maxParameters?: number } = {},
) {
  if (!rows.length) return 0;
  const width = rows[0].length;
  if (!width || rows.some((row) => row.length !== width)) throw new Error("SQL value rows must have one consistent width");
  const batchSize = Math.max(1, Math.floor((options.maxParameters ?? 30_000) / width));
  let statements = 0;

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((row) => `(${row.map((value, column) => {
      values.push(value);
      return `$${values.length}${options.casts?.[column] ?? ""}`;
    }).join(",")})`).join(",");
    await client.query(`${prefix}${placeholders}${options.suffix ?? ""}`, values);
    statements += 1;
  }
  return statements;
}
