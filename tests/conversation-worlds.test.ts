import { randomUUID } from "node:crypto";
import { DataType, newDb } from "pg-mem";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asUser, ensureSchema, query, setPoolForTesting } from "@/lib/db";
import {
  attachConversationWorld, conversationWorldRecords, conversationWorldSummaries,
  copyConversationWorldsForBranch, detachConversationWorld, ensureConversationWorlds,
  initializeConversationWorlds, readableDefaultWorldIds, setConversationWorlds,
} from "@/lib/conversation-worlds";

/**
 * A Creation is authored once; a story evolves away from it.
 *
 * That sentence is the whole feature, and every assertion here is one way of
 * checking it. The bug it replaces was structural rather than accidental: the
 * chat's world picker had nowhere to write except `character_worlds`, so
 * "add a world to this story" and "add a world to this Creation, permanently,
 * for everybody" were the same operation.
 *
 * The scenario the sprint specified is exercised end to end:
 *
 *   Creation has World A. Story 1 adds World B. Story 2 is started.
 *   → Story 1 is A + B, Story 2 is A, the Creation is still A.
 *   Story 1 removes A. The Creation changes its defaults.
 *   → Story 1 changed, the Creation did not, and Story 1 did not.
 */

const owner = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
const creationId = "33333333-3333-4333-8333-333333333333";

let worldA: string;
let worldB: string;
let strangerPrivate: string;
let strangerPublic: string;

async function makeWorld(userId: string, name: string, visibility = "private") {
  const id = randomUUID();
  await query(
    "INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, userId, name, `${name} description`, `${name} lore document`, visibility],
  );
  return id;
}

async function makeStory(userId: string, characterId = creationId) {
  const id = randomUUID();
  await query(
    "INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Story')",
    [id, userId, characterId],
  );
  return id;
}

async function startStory(userId: string, characterId = creationId) {
  const id = await makeStory(userId, characterId);
  await asUser(userId, (client) => initializeConversationWorlds(client, userId, id, characterId));
  return id;
}

/** The names a story's prompt would actually be built from. */
async function storyWorldNames(userId: string, conversationId: string) {
  const rows = await asUser(userId, (client) => conversationWorldRecords(client, userId, conversationId));
  return rows.map((row) => String(row.name)).sort();
}

/** The Creation's own defaults, straight from the link table. */
async function creationWorldIds() {
  const result = await query("SELECT world_id FROM character_worlds WHERE character_id=$1", [creationId]);
  return result.rows.map((row) => String(row.world_id)).sort();
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

  await query("INSERT INTO characters (id,user_id,name,visibility) VALUES ($1,$2,'Maya','public')", [creationId, owner]);
  worldA = await makeWorld(owner, "World A");
  worldB = await makeWorld(owner, "World B");
  strangerPrivate = await makeWorld(stranger, "Stranger Private");
  strangerPublic = await makeWorld(stranger, "Stranger Public", "public");
  await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [creationId, worldA]);
});

describe("a story starts from the Creation's defaults", () => {
  it("copies them once, at the moment the story begins", async () => {
    const story = await startStory(owner);
    expect(await storyWorldNames(owner, story)).toEqual(["World A"]);
  });

  it("marks the story initialized so an empty set stays empty", async () => {
    const story = await startStory(owner);
    await asUser(owner, (client) => detachConversationWorld(client, owner, story, worldA));
    await asUser(owner, (client) => setConversationWorlds(client, owner, story, []));

    // Re-opening must not resurrect the Creation's defaults. "No worlds" is a
    // decision; only "never asked" is a reason to copy.
    const row = (await query("SELECT * FROM conversations WHERE id=$1", [story])).rows[0];
    expect(await asUser(owner, (client) => ensureConversationWorlds(client, owner, row))).toBe(false);
    expect(await storyWorldNames(owner, story)).toEqual([]);
  });

  it("gives a story written before the relation existed its set on first use", async () => {
    const legacy = await makeStory(owner);
    const row = (await query("SELECT * FROM conversations WHERE id=$1", [legacy])).rows[0];
    expect(row.worlds_initialized).toBeFalsy();

    expect(await asUser(owner, (client) => ensureConversationWorlds(client, owner, row))).toBe(true);
    expect(await storyWorldNames(owner, legacy)).toEqual(["World A"]);

    // Once, and never again: the second open is free.
    const after = (await query("SELECT * FROM conversations WHERE id=$1", [legacy])).rows[0];
    expect(await asUser(owner, (client) => ensureConversationWorlds(client, owner, after))).toBe(false);
  });
});

describe("the sprint's scenario, exactly", () => {
  it("keeps three world sets apart", async () => {
    const storyOne = await startStory(owner);
    await asUser(owner, (client) => attachConversationWorld(client, owner, storyOne, worldB));
    const storyTwo = await startStory(owner);

    expect(await storyWorldNames(owner, storyOne)).toEqual(["World A", "World B"]);
    expect(await storyWorldNames(owner, storyTwo)).toEqual(["World A"]);
    // The Creation is untouched. This is the assertion the whole change exists
    // for: adding B inside a story never made B part of the Creation.
    expect(await creationWorldIds()).toEqual([worldA]);
  });

  it("lets a story remove a world without removing it from the Creation", async () => {
    const storyOne = await startStory(owner);
    await asUser(owner, (client) => detachConversationWorld(client, owner, storyOne, worldA));

    expect(await storyWorldNames(owner, storyOne)).toEqual([]);
    expect(await creationWorldIds()).toEqual([worldA]);
  });

  it("does not rewrite a running story when the Creation's defaults change later", async () => {
    const oldStory = await startStory(owner);
    // The creator adds World B to the Creation a month into somebody's story.
    await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [creationId, worldB]);

    expect(await storyWorldNames(owner, oldStory)).toEqual(["World A"]);
    // And a story started after the change gets the new defaults.
    expect(await storyWorldNames(owner, await startStory(owner))).toEqual(["World A", "World B"]);
  });

  it("does not rewrite a running story when a default is removed from the Creation", async () => {
    const oldStory = await startStory(owner);
    await query("DELETE FROM character_worlds WHERE character_id=$1 AND world_id=$2", [creationId, worldA]);
    expect(await storyWorldNames(owner, oldStory)).toEqual(["World A"]);
    expect(await storyWorldNames(owner, await startStory(owner))).toEqual([]);
  });
});

describe("the lore block's byte order is stable", () => {
  /*
   * This ordering is not presentation. It decides the byte order of the
   * LOREBOOK section, which sits near the top of the STABLE half of the writer
   * prompt — so everything after the first byte that moves is billed as fresh
   * input rather than served from the provider's cache.
   *
   * It used to be `w.updated_at DESC`, which was unstable twice over: worlds
   * attached together share a timestamp and tied rows may come back in either
   * order, and editing any attached world displaced every world after it.
   */
  it("does not change when an attached world is edited", async () => {
    const story = await startStory(owner);
    await asUser(owner, (client) => attachConversationWorld(client, owner, story, worldB));
    const before = await asUser(owner, (client) => conversationWorldRecords(client, owner, story));

    // Editing B's lore must move B's own text and nothing else's position.
    await query("UPDATE worlds SET content=$2, updated_at=now() WHERE id=$1", [worldB, "revised lore"]);
    const after = await asUser(owner, (client) => conversationWorldRecords(client, owner, story));

    expect(after.map((row) => String(row.id))).toEqual(before.map((row) => String(row.id)));
  });

  it("is the same on every read, so two consecutive turns serialise alike", async () => {
    const story = await startStory(owner);
    await asUser(owner, (client) => attachConversationWorld(client, owner, story, worldB));
    const reads = await Promise.all(Array.from({ length: 5 }, () =>
      asUser(owner, (client) => conversationWorldRecords(client, owner, story))));
    const orders = reads.map((rows) => rows.map((row) => String(row.id)).join(","));
    expect(new Set(orders).size).toBe(1);
  });
});

describe("private lore never travels", () => {
  it("omits another creator's private world from a visitor's defaults", async () => {
    // A public creation built on a private world: the association is real and
    // the creation page shows it as a locked card, but the lore is not this
    // reader's to receive and never enters their prompt.
    await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [creationId, strangerPrivate]);

    // The creation now defaults to two worlds, each private to a different
    // account, and each reader receives only the one that is theirs to read.
    expect(await asUser(owner, (client) => readableDefaultWorldIds(client, owner, creationId))).toEqual([worldA]);
    expect(await storyWorldNames(owner, await startStory(owner))).toEqual(["World A"]);
    expect(await storyWorldNames(stranger, await startStory(stranger))).toEqual(["Stranger Private"]);
  });

  it("does give a visitor the creator's published worlds", async () => {
    await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [creationId, strangerPublic]);
    const story = await startStory(owner);
    expect(await storyWorldNames(owner, story)).toEqual(["Stranger Public", "World A"]);
  });

  it("refuses to attach a world the account may not read", async () => {
    const story = await startStory(owner);
    expect(await asUser(owner, (client) => attachConversationWorld(client, owner, story, strangerPrivate))).toBe(false);
    expect(await storyWorldNames(owner, story)).toEqual(["World A"]);
  });

  it("stops feeding a prompt when an attached world is made private", async () => {
    await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [creationId, strangerPublic]);
    const story = await startStory(owner);
    expect(await storyWorldNames(owner, story)).toContain("Stranger Public");

    // The readability check happens on every read, not only on attach, so this
    // needs no cleanup pass to take effect.
    await query("UPDATE worlds SET visibility='private' WHERE id=$1", [strangerPublic]);
    expect(await storyWorldNames(owner, story)).toEqual(["World A"]);
  });

  it("keeps one account's story set invisible to another", async () => {
    const mine = await startStory(owner);
    expect(await asUser(stranger, (client) => conversationWorldSummaries(client, stranger, mine))).toEqual([]);
    expect(await asUser(stranger, (client) => attachConversationWorld(client, stranger, mine, strangerPublic))).toBe(false);
  });
});

describe("a set can be replaced wholesale", () => {
  it("adds and removes to reach exactly the requested set", async () => {
    const story = await startStory(owner);
    await asUser(owner, (client) => setConversationWorlds(client, owner, story, [worldB]));
    expect(await storyWorldNames(owner, story)).toEqual(["World B"]);
  });

  it("silently drops an id the account may not use rather than failing the lot", async () => {
    const story = await startStory(owner);
    await asUser(owner, (client) => setConversationWorlds(client, owner, story, [worldA, strangerPrivate]));
    expect(await storyWorldNames(owner, story)).toEqual(["World A"]);
  });

  it("is idempotent", async () => {
    const story = await startStory(owner);
    await asUser(owner, (client) => setConversationWorlds(client, owner, story, [worldA, worldB]));
    await asUser(owner, (client) => setConversationWorlds(client, owner, story, [worldA, worldB]));
    expect(await storyWorldNames(owner, story)).toEqual(["World A", "World B"]);
  });
});

describe("a branch continues this story's canon", () => {
  it("inherits the story's set, not the Creation's current defaults", async () => {
    const story = await startStory(owner);
    await asUser(owner, (client) => attachConversationWorld(client, owner, story, worldB));
    await asUser(owner, (client) => detachConversationWorld(client, owner, story, worldA));
    // Meanwhile the Creation has changed underneath.
    await query("DELETE FROM character_worlds WHERE character_id=$1", [creationId]);

    const branch = await makeStory(owner);
    await asUser(owner, (client) => copyConversationWorldsForBranch(client, {
      userId: owner, sourceConversationId: story, conversationId: branch,
    }));

    expect(await storyWorldNames(owner, branch)).toEqual(["World B"]);
  });

  it("is independent from the moment it is taken", async () => {
    const story = await startStory(owner);
    const branch = await makeStory(owner);
    await asUser(owner, (client) => copyConversationWorldsForBranch(client, {
      userId: owner, sourceConversationId: story, conversationId: branch,
    }));

    await asUser(owner, (client) => attachConversationWorld(client, owner, story, worldB));
    expect(await storyWorldNames(owner, branch)).toEqual(["World A"]);
    expect(await storyWorldNames(owner, story)).toEqual(["World A", "World B"]);
  });
});

describe("summaries never carry lore", () => {
  it("returns a card's worth of a world and no document", async () => {
    const story = await startStory(owner);
    const [card] = await asUser(owner, (client) => conversationWorldSummaries(client, owner, story));
    expect(card.name).toBe("World A");
    expect(card.description).toBe("World A description");
    expect(JSON.stringify(card)).not.toContain("lore document");
  });
});
