import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem } from "@/lib/notifications";

/**
 * The notifications endpoint.
 *
 * The generation half is a trigger and lives in tests/social-discovery.test.ts,
 * where a real PostgreSQL can run it. This is the READING half, and the two
 * properties it exists to hold are both about restraint:
 *
 *   THE BELL IS CHEAP. `?scope=unread` answers with a count and nothing else.
 *   Fetching twenty notifications and their covers to decide whether to paint a
 *   dot is the mistake the split endpoint exists to make impossible.
 *
 *   A NOTIFICATION NEVER OUTLIVES WHAT IT POINTS AT. A creation made private
 *   after the fact disappears from the list AND from the count, so the product
 *   never draws a dot for something the reader cannot open, and never reports
 *   metadata about work that has been withdrawn.
 */

const reader = "b2b2b2b2-2222-4222-8222-222222222222";
const creator = "a1a1a1a1-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = null;

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const notifications = await import("@/app/api/notifications/route");

const elysia = "dddddddd-0000-4000-8000-000000000001";
const kaelen = "dddddddd-0000-4000-8000-000000000002";

type ListBody = { notifications: NotificationItem[]; hasMore: boolean; nextCursor: string | null; unread: number };

async function list(search = "") {
  const response = await notifications.GET(new Request(`http://test/api/notifications${search}`));
  return { status: response.status, ...(await response.json() as ListBody) };
}

async function unread() {
  const response = await notifications.GET(new Request("http://test/api/notifications?scope=unread"));
  return await response.json() as { unread: number; hasUnread: boolean };
}

async function markRead(body: Record<string, unknown>) {
  const response = await notifications.PATCH(new Request("http://test/api/notifications", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: response.status, ...(await response.json() as { unread: number; hasUnread: boolean }) };
}

/** A notification, written directly — generation is the trigger's own suite. */
async function notify(characterId: string, minutesAgo: number, read = false) {
  await query(
    `INSERT INTO notifications (id,user_id,type,actor_user_id,character_id,dedupe_key,created_at,read_at)
     VALUES ($7,$1,'creation_published',$2,$3,$4,$5,$6)`,
    [
      reader, creator, characterId, `creation_published:${characterId}`,
      new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      read ? new Date().toISOString() : null,
      randomUUID(),
    ],
  );
}

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: reader, email: null };

  await query("INSERT INTO profiles (id,username,display_name,avatar_path) VALUES ($1,'noctis','Noctis','users/x/a.png')", [creator]);
  await query("INSERT INTO profiles (id,display_name) VALUES ($1,'Reader')", [reader]);
  await query(
    `INSERT INTO characters (id,user_id,name,title,creation_type,visibility,published_at,accent)
     VALUES ($1,$3,'Elysia','Elysia','character','public',now(),'#e879a9'),
            ($2,$3,'Kaelen','The Last Dance','scenario','public',now(),'#8a5cf6')`,
    [elysia, kaelen, creator],
  );
});

describe("the list", () => {
  it("is empty for an account nobody has published to", async () => {
    const page = await list();
    expect(page.notifications).toEqual([]);
    expect(page.unread).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("carries everything a row needs to be recognised and opened", async () => {
    await notify(elysia, 12);
    const [item] = (await list()).notifications;
    expect(item.type).toBe("creation_published");
    expect(item.read).toBe(false);
    expect(item.actor).toEqual({ username: "noctis", displayName: "Noctis", avatarPath: "users/x/a.png" });
    // The creation, by id, so the row can open the exact page.
    expect(item.creation?.id).toBe(elysia);
    expect(item.creation?.title).toBe("Elysia");
    expect(item.creation?.creationType).toBe("character");
  });

  it("reports the creation's own type rather than assuming a character", async () => {
    await notify(kaelen, 5);
    expect((await list()).notifications[0].creation?.creationType).toBe("scenario");
  });

  it("is newest first", async () => {
    await notify(elysia, 60);
    await notify(kaelen, 5);
    expect((await list()).notifications.map((item) => item.creation?.id)).toEqual([kaelen, elysia]);
  });

  it("never carries a hidden definition", async () => {
    await notify(elysia, 3);
    const serialised = JSON.stringify((await list()).notifications);
    for (const hidden of ["greeting", "personality", "backstory", "response_directive", "boundaries"]) {
      expect(serialised, `${hidden} is not notification data`).not.toContain(hidden);
    }
  });

  it("pages by cursor, so an arrival mid-scroll cannot hide a row", async () => {
    await notify(elysia, 60);
    await notify(kaelen, 5);
    const first = await list("?limit=1");
    expect(first.notifications).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await list(`?limit=1&before=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.notifications.map((item) => item.creation?.id)).toEqual([elysia]);
    expect(second.hasMore).toBe(false);
  });

  it("ignores a cursor that is not a time, rather than refusing the request", async () => {
    await notify(elysia, 3);
    expect((await list("?before=not-a-date")).notifications).toHaveLength(1);
  });
});

describe("a release that has been withdrawn", () => {
  /*
   * The graceful half of "handle a deleted or privatised creation". A DELETED
   * creation takes its notification with it through the foreign key; a
   * PRIVATISED one keeps its row — it may come back — and is filtered out on
   * read, here and in the count.
   */
  it("disappears from the list when the creation is made private", async () => {
    await notify(elysia, 3);
    expect((await list()).notifications).toHaveLength(1);
    await query("UPDATE characters SET visibility='private' WHERE id=$1", [elysia]);
    expect((await list()).notifications).toEqual([]);
  });

  it("stops counting towards the unread dot too", async () => {
    await notify(elysia, 3);
    expect((await unread()).hasUnread).toBe(true);
    await query("UPDATE characters SET visibility='private' WHERE id=$1", [elysia]);
    expect(await unread()).toEqual({ unread: 0, hasUnread: false });
  });

  it("leaks no metadata about it", async () => {
    await notify(elysia, 3);
    await query("UPDATE characters SET visibility='private' WHERE id=$1", [elysia]);
    expect(JSON.stringify(await list())).not.toContain("Elysia");
  });
});

describe("the unread dot", () => {
  it("answers with a count and nothing else", async () => {
    await notify(elysia, 3);
    const body = await unread();
    expect(body).toEqual({ unread: 1, hasUnread: true });
    // Emphatically not the feed: this runs on every shell render.
    expect(Object.keys(body)).toEqual(["unread", "hasUnread"]);
  });

  it("does not count what has already been read", async () => {
    await notify(elysia, 60, true);
    await notify(kaelen, 5);
    expect((await unread()).unread).toBe(1);
  });
});

/*
 * Marking read.
 *
 * "Mark all" is here; marking BY ID is exercised against a real PostgreSQL in
 * tests/social-discovery.test.ts instead. That split is a pg-mem limitation
 * rather than a design one: `id = ANY($2::uuid[])` matches nothing under pg-mem
 * whatever it is given, so a test written here would fail against correct code
 * and tempt somebody into rewriting an indexed predicate to satisfy a fake
 * database. The production statement stays as it is.
 */
describe("marking read", () => {
  it("marks all, and the dot goes out", async () => {
    await notify(elysia, 60);
    await notify(kaelen, 5);
    const result = await markRead({ all: true });
    expect(result.unread).toBe(0);
    expect(result.hasUnread).toBe(false);
    expect((await list()).notifications.every((item) => item.read)).toBe(true);
  });

  it("is idempotent, so firing on open, scroll and close does no harm", async () => {
    await notify(elysia, 3);
    await markRead({ all: true });
    const first = (await list()).notifications[0];
    await markRead({ all: true });
    const second = (await list()).notifications[0];
    // The timestamp does not move, so "when did you first see this" stays true.
    expect(second.read).toBe(true);
    expect(second.id).toBe(first.id);
    expect((await unread()).unread).toBe(0);
  });

  it("refuses an empty request rather than quietly marking everything", async () => {
    await notify(elysia, 3);
    expect((await markRead({})).status).toBe(400);
    expect((await markRead({ ids: [] })).status).toBe(400);
    expect((await unread()).unread).toBe(1);
  });

  it("ignores an id that is not one", async () => {
    await notify(elysia, 3);
    expect((await markRead({ ids: ["'; DELETE FROM notifications;--"] })).status).toBe(400);
    expect((await unread()).unread).toBe(1);
  });
});

describe("access", () => {
  it("refuses an unauthenticated caller", async () => {
    account = null;
    const response = await notifications.GET(new Request("http://test/api/notifications"));
    expect(response.status).toBe(401);
  });

  it("never returns another account's notifications", async () => {
    await notify(elysia, 3);
    account = { id: creator, email: null };
    expect((await list()).notifications).toEqual([]);
    expect((await unread()).unread).toBe(0);
  });
});
