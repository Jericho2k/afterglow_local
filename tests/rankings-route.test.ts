import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rankings endpoint.
 *
 * The board itself — how it is ordered, what is eligible, that it is a total
 * order — is built by a SQL function and verified against a real PostgreSQL in
 * tests/social-discovery.test.ts. What is asserted HERE is the thing that makes
 * Rankings a discovery surface rather than an analytics page:
 *
 *   EVERY ROW IS A DESTINATION. A ranked creation carries its own id and its
 *   creator's handle; a ranked creator carries their handle and their best
 *   creation's id. A board whose rows cannot be opened is a table.
 *
 * and the thing that keeps it honest:
 *
 *   THE NUMBER MEANS WHAT THE PAGE SAYS. `userMessages` is
 *   `user_message_count` — turns readers actually sent — and never
 *   `message_count`, which counts the model's replies and every regenerated
 *   alternative too.
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

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const rankings = await import("@/app/api/rankings/route");

const elysia = "aaaaaaaa-0000-4000-8000-000000000001";
const kaelen = "aaaaaaaa-0000-4000-8000-000000000002";

type RankedCreation = {
  rank: number; rankTotal: number; userMessages: number;
  creation: { id: string; title: string; saveCount: number; messageCount: number; creator: { username: string } | null };
};
async function board(search = "") {
  const response = await rankings.GET(new Request(`http://test/api/rankings${search}`));
  const body = await response.json() as {
    board: string; category?: string; categories?: string[];
    creations?: RankedCreation[];
    hasMore: boolean; nextOffset: number; total: number;
  };
  return { status: response.status, ...body };
}

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: bob, email: null };

  await query("INSERT INTO profiles (id,username,display_name,follower_count) VALUES ($1,'nova','Nova Vale',1200)", [alice]);
  await query("INSERT INTO profiles (id,display_name) VALUES ($1,'Bob')", [bob]);
  await query(
    `INSERT INTO characters (id,user_id,name,title,creation_type,visibility,published_at,tags,
       user_message_count,message_count,chat_count,like_count,accent)
     VALUES ($1,$3,'Elysia','Elysia','character','public',now(),ARRAY['Drama','Romance'],238000,501000,900,4800,'#e879a9'),
            ($2,$3,'Kaelen','Kaelen','character','public',now(),ARRAY['Drama'],192000,410000,700,3100,'#8a5cf6')`,
    [elysia, kaelen, alice],
  );
  // Materialised boards, as the refresh function would leave them.
  await query(
    `INSERT INTO creation_rankings (character_id,category,rank,rank_total,user_messages) VALUES
       ($1,'',1,2,238000),($2,'',2,2,192000),
       ($1,'Drama',1,2,238000),($2,'Drama',2,2,192000),
       ($1,'Romance',1,1,238000)`,
    [elysia, kaelen],
  );
  await query(
    `INSERT INTO creator_stats (user_id,published_creations,published_worlds,user_messages,saves,followers,rank,rank_total)
     VALUES ($1,2,0,430000,7900,1200,1,1)`,
    [alice],
  );
});

describe("the creations board", () => {
  it("is the overall board by default, best first", async () => {
    const page = await board();
    expect(page.board).toBe("creations");
    expect(page.category).toBe("");
    expect(page.creations?.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(page.creations?.map((entry) => entry.creation.id)).toEqual([elysia, kaelen]);
    expect(page.total).toBe(2);
  });

  it("narrows to a category, and only to creations that carry it", async () => {
    const drama = await board("?category=Drama");
    expect(drama.creations?.map((entry) => entry.creation.id)).toEqual([elysia, kaelen]);
    const romance = await board("?category=Romance");
    expect(romance.creations?.map((entry) => entry.creation.id)).toEqual([elysia]);
    expect(romance.creations?.[0].rankTotal).toBe(1);
  });

  /*
   * Two numbers under the word "messages" on one page would be a page that
   * contradicts itself. The board's own metric is the creator metric.
   */
  it("ranks by user messages, not by every message row", async () => {
    const page = await board();
    const top = page.creations![0];
    expect(top.userMessages).toBe(238_000);
    // The card underneath still carries the feed's meaning of the word, and the
    // two are deliberately different numbers.
    expect(top.creation.messageCount).toBe(501_000);
  });

  it("offers the categories rather than making a client know the taxonomy", async () => {
    const page = await board();
    expect(page.categories).toContain("Drama");
    expect(page.categories).toContain("Sci-Fi");
    // A creator hashtag is not a board.
    expect(page.categories).not.toContain("darkacademia");
  });

  it("treats an unknown category as the overall board rather than failing", async () => {
    const page = await board("?category=darkacademia");
    expect(page.status).toBe(200);
    expect(page.category).toBe("");
    expect(page.creations).toHaveLength(2);
  });

  it("drops a creation that has been unpublished since the last rebuild", async () => {
    await query("UPDATE characters SET visibility='private' WHERE id=$1", [elysia]);
    const page = await board();
    expect(page.creations?.map((entry) => entry.creation.id)).toEqual([kaelen]);
  });

  /*
   * Every row is a destination. This is the whole difference between a
   * leaderboard and a table.
   */
  it("gives every row a creation to open and a creator to open", async () => {
    const page = await board();
    for (const entry of page.creations!) {
      expect(entry.creation.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.creation.creator?.username).toBe("nova");
    }
  });

  it("never carries a hidden definition", async () => {
    const serialised = JSON.stringify((await board()).creations);
    for (const hidden of ["greeting", "personality", "backstory", "response_directive", "boundaries", "source_material"]) {
      expect(serialised, `${hidden} is not board data`).not.toContain(hidden);
    }
  });

  it("pages, and says whether there is more", async () => {
    const first = await board("?limit=1");
    expect(first.creations).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = await board(`?limit=1&offset=${first.nextOffset}`);
    expect(second.creations?.[0].creation.id).toBe(kaelen);
    expect(second.hasMore).toBe(false);
  });

  it("returns a real empty board when a successful board is simply empty", async () => {
    await query("DELETE FROM creation_rankings");
    await query("UPDATE creation_rankings_refresh SET refreshed_at=now() WHERE id=true");
    const page = await board();
    expect(page.status).toBe(200);
    expect(page.creations).toEqual([]);
  });

  it("distinguishes an unavailable refresh from a real empty board", async () => {
    await query("DELETE FROM creation_rankings");
    const page = await board();
    expect(page.status).toBe(503);
    expect(page).toMatchObject({ error: "Creation rankings are temporarily unavailable" });
  });
});

/*
 * The creators board is verified in tests/social-discovery.test.ts instead.
 *
 * Its query uses a LATERAL correlated to an outer alias — the creator's own
 * most-read creation — and pg-mem cannot evaluate that at all. Rewriting an
 * indexed one-statement board into something a fake database can manage would
 * be letting the test choose the query, so the real-PostgreSQL suite calls
 * `rankedCreators` directly: the same function this route runs.
 */

describe("access", () => {
  it("refuses an unauthenticated caller", async () => {
    account = null;
    const response = await rankings.GET(new Request("http://test/api/rankings"));
    expect(response.status).toBe(401);
  });
});
