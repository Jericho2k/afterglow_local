import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPreferences, emptyDiscoveryPreferences, emptyDiscoveryQuery,
  preferencesFromQuery, queryStatesIntent, samePreferences,
} from "@/lib/discovery";

/**
 * Discovery preferences.
 *
 * Two ideas that are easy to conflate and must not be. What somebody is
 * looking at right now lives in the URL, where Back can restore it. What they
 * generally want to see lives on their account, where a new session can pick
 * it up. A preference that overwrote the URL would break Back; a URL that
 * overwrote the preference would make the setting pointless.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
let account: { id: string; email: string | null } | null = null;

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, setPoolForTesting } = await import("@/lib/db");
const preferences = await import("@/app/api/preferences/route");

function patch(body: unknown) {
  return new Request("http://test/api/preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function read() {
  const response = await preferences.GET();
  return { status: response.status, discovery: (await response.json()).discovery };
}

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  memoryDb.public.registerFunction({
    name: "date_trunc", args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz,
    implementation: (unit: string, value: Date) => { const out = new Date(value); if (unit === "day") out.setHours(0, 0, 0, 0); return out; },
  });
  memoryDb.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  setPoolForTesting(new (memoryDb.adapters.createPg()).Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: alice, email: null };
});

describe("preferences belong to the account", () => {
  it("requires an account", async () => {
    account = null;
    expect((await read()).status).toBe(401);
    expect((await preferences.PATCH(patch({ tags: ["Fantasy"] }))).status).toBe(401);
  });

  it("remembers what was saved, across a later session", async () => {
    await preferences.PATCH(patch({ sort: "new", tags: ["Fantasy"], types: ["scenario"], includeAdult: true }));
    // A fresh read is what a later visit does; nothing about the browser is
    // involved, which is what makes this survive a sign-out.
    expect((await read()).discovery).toMatchObject({ sort: "new", tags: ["Fantasy"], types: ["scenario"], includeAdult: true });
  });

  it("gives another account its own defaults rather than the first one's", async () => {
    await preferences.PATCH(patch({ tags: ["Fantasy"], includeAdult: true }));
    account = { id: bob, email: null };
    const theirs = (await read()).discovery;
    expect(theirs.tags).toEqual([]);
    expect(theirs.includeAdult).toBe(false);
    expect(theirs.sort).toBeUndefined();
  });

  it("does not let one account's write reach another", async () => {
    await preferences.PATCH(patch({ tags: ["Fantasy"] }));
    account = { id: bob, email: null };
    await preferences.PATCH(patch({ tags: ["Horror"] }));
    account = { id: alice, email: null };
    expect((await read()).discovery.tags).toEqual(["Fantasy"]);
  });

  it("creates the row for an account that has never opened settings", async () => {
    account = { id: bob, email: null };
    expect((await preferences.PATCH(patch({ tags: ["Comedy"] }))).status).toBe(200);
    expect((await read()).discovery.tags).toEqual(["Comedy"]);
  });
});

describe("what is worth remembering", () => {
  it("keeps the ordering and the structured filters", () => {
    const query = { ...emptyDiscoveryQuery, sort: "new" as const, tags: ["Fantasy"], types: ["cast" as const], includeAdult: true };
    expect(preferencesFromQuery(query)).toEqual({ sort: "new", tags: ["Fantasy"], types: ["cast"], includeAdult: true });
  });

  it("never keeps the search term, because a search is not a preference", () => {
    const query = { ...emptyDiscoveryQuery, search: "poetry", hashtag: "mha", tags: ["Fantasy"] };
    const saved = preferencesFromQuery(query) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("search");
    expect(saved).not.toHaveProperty("hashtag");
  });

  it("ignores a stored value the taxonomy no longer has, rather than querying with it", async () => {
    await preferences.PATCH(patch({ tags: ["Fantasy", "NotATagAnyMore"], types: ["character"] }));
    // Canonicalised on the way in; an unknown value is simply not a tag.
    expect((await read()).discovery.tags).toEqual(["Fantasy", "NotATagAnyMore"]);
  });

  it("refuses a structure the product does not have", async () => {
    expect((await preferences.PATCH(patch({ types: ["world"] }))).status).toBe(400);
    expect((await preferences.PATCH(patch({ sort: "for-you" }))).status).toBe(400);
  });

  it("stores an empty preference rather than treating Clear as nothing to save", async () => {
    await preferences.PATCH(patch({ sort: "new", tags: ["Fantasy"], types: ["cast"], includeAdult: true }));
    // Clearing is a decision. If it were skipped as "empty", the filters would
    // reappear on the next visit and Clear would look like it had failed.
    await preferences.PATCH(patch({ tags: [], types: [], includeAdult: false }));
    const cleared = (await read()).discovery;
    expect(cleared.tags).toEqual([]);
    expect(cleared.types).toEqual([]);
    expect(cleared.includeAdult).toBe(false);
  });
});

describe("the URL wins over the preference", () => {
  it("treats any stated filter, ordering or search as intent", () => {
    for (const search of ["?tags=Romance", "?sort=new", "?type=cast", "?adult=include", "?q=poetry"]) {
      expect(queryStatesIntent(new URLSearchParams(search))).toBe(true);
    }
  });

  it("treats a bare Discovery as nothing said", () => {
    expect(queryStatesIntent(new URLSearchParams(""))).toBe(false);
    // The shell's own view parameter is not a filter, so it does not count.
    expect(queryStatesIntent(new URLSearchParams("?view=home"))).toBe(false);
  });

  it("applies a saved preference to a fresh query only", () => {
    const applied = applyPreferences(emptyDiscoveryQuery, { sort: "new", tags: ["Fantasy"], types: ["scenario"], includeAdult: true });
    expect(applied).toMatchObject({ sort: "new", tags: ["Fantasy"], types: ["scenario"], includeAdult: true, offset: 0 });
  });

  it("leaves a search term alone when applying a preference", () => {
    const searching = { ...emptyDiscoveryQuery, search: "poetry" };
    expect(applyPreferences(searching, { ...emptyDiscoveryPreferences, tags: ["Fantasy"] }).search).toBe("poetry");
  });

  it("keeps the current ordering when the preference has none", () => {
    const chatted = { ...emptyDiscoveryQuery, sort: "chatted" as const };
    expect(applyPreferences(chatted, emptyDiscoveryPreferences).sort).toBe("chatted");
  });
});

describe("nothing writes in a loop", () => {
  it("recognises an unchanged preference whatever order it is in", () => {
    const a = { sort: "new" as const, tags: ["Fantasy", "Romance"], types: ["cast" as const, "scenario" as const], includeAdult: true };
    const b = { sort: "new" as const, tags: ["Romance", "Fantasy"], types: ["scenario" as const, "cast" as const], includeAdult: true };
    // Sorting order is not a change, so re-rendering never triggers a write.
    expect(samePreferences(a, b)).toBe(true);
  });

  it("treats the default ordering and an unset ordering as the same", () => {
    expect(samePreferences({ ...emptyDiscoveryPreferences, sort: "popular" }, emptyDiscoveryPreferences)).toBe(true);
  });

  it("notices a real change", () => {
    expect(samePreferences(emptyDiscoveryPreferences, { ...emptyDiscoveryPreferences, tags: ["Fantasy"] })).toBe(false);
    expect(samePreferences(emptyDiscoveryPreferences, { ...emptyDiscoveryPreferences, includeAdult: true })).toBe(false);
    expect(samePreferences(emptyDiscoveryPreferences, { ...emptyDiscoveryPreferences, sort: "new" })).toBe(false);
  });
});
