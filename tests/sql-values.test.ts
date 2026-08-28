import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { insertValueRows } from "@/lib/sql-values";

describe("batched SQL values", () => {
  it("turns a 500-row branch layer into one database statement", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 500, rows: [] });
    const client = { query } as unknown as PoolClient;
    const rows = Array.from({ length: 500 }, (_, row) =>
      Array.from({ length: 12 }, (_, column) => `${row}:${column}`));

    const statements = await insertValueRows(client, "INSERT INTO messages VALUES ", rows, {
      casts: { 5: "::jsonb", 7: "::uuid[]" },
    });

    expect(statements).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toHaveLength(6_000);
    expect(query.mock.calls[0][0]).toContain("$6::jsonb");
  });

  it("chunks before the configured parameter ceiling", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const client = { query } as unknown as PoolClient;
    const rows = Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => null));
    expect(await insertValueRows(client, "INSERT INTO example VALUES ", rows, { maxParameters: 9 })).toBe(2);
    expect(query.mock.calls.map((call) => call[1].length)).toEqual([9, 6]);
  });
});
