import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asAccount, createAccount, migratedPool, tenancyDatabaseUrl } from "./helpers/tenancy";

/**
 * What happens to stories that already existed.
 *
 * A migration that adds a relation is easy. A migration that has to decide what
 * a hundred thousand ongoing conversations were ALREADY being written with, and
 * then freeze that answer, is the part worth testing — and it cannot be tested
 * against a database where the migration has already run, so this suite builds
 * the schema as it stood at 0018, seeds pre-migration data into it, and then
 * applies 0019 to that.
 *
 * The rule the backfill implements is deliberately conservative: reproduce
 * exactly the set the chat route was already loading, which was
 *
 *   worlds the CONVERSATION'S OWNER owns, attached to a creation that
 *   CONVERSATION'S OWNER also owns
 *
 * and nothing else. Three properties follow, and each is asserted below: no
 * running story changes what it is written with, no story gains lore it was
 * never given, and every story stops inheriting from its Creation from here on.
 */

const describeBackfill = tenancyDatabaseUrl ? describe : describe.skip;

const alice = "a0000000-0000-4000-8000-00000000000a";
const bob = "b0000000-0000-4000-8000-00000000000b";
const aliceCreation = "c0000000-0000-4000-8000-000000000001";
const bobCreation = "c0000000-0000-4000-8000-000000000002";
const aliceWorld = "d0000000-0000-4000-8000-000000000001";
const alicePublicWorld = "d0000000-0000-4000-8000-000000000002";
const bobPrivateWorld = "d0000000-0000-4000-8000-000000000003";
const aliceStory = "e0000000-0000-4000-8000-000000000001";
const aliceStoryOnBobsCreation = "e0000000-0000-4000-8000-000000000002";
const bobStoryOnAlicesCreation = "e0000000-0000-4000-8000-000000000003";

describeBackfill("existing stories keep the canon they were already written with", () => {
  let pool: Pool;

  beforeAll(async () => {
    // The schema as it stood before conversation worlds existed.
    // Its own database: this suite rewinds the schema to 0018, and the isolation
    // suite next door rebuilds the same one from scratch in parallel.
    pool = await migratedPool({ through: "0018_memory_feedback.sql", database: "backfill" });
    await createAccount(pool, alice, "alice@example.com");
    await createAccount(pool, bob, "bob@example.com");

    await asAccount(pool, alice, async (run) => {
      await run("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Alice Creation',$2,'public')", [aliceCreation, alice]);
      await run("INSERT INTO worlds (id,name,content,user_id,visibility) VALUES ($1,'Alice World','Alice canon',$2,'private')", [aliceWorld, alice]);
      await run("INSERT INTO worlds (id,name,content,user_id,visibility) VALUES ($1,'Alice Public World','Published canon',$2,'public')", [alicePublicWorld, alice]);
      await run("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2),($1,$3)", [aliceCreation, aliceWorld, alicePublicWorld]);
      await run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Alice on her own creation')", [aliceStory, aliceCreation, alice]);
    });

    await asAccount(pool, bob, async (run) => {
      await run("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Bob Creation',$2,'public')", [bobCreation, bob]);
      await run("INSERT INTO worlds (id,name,content,user_id,visibility) VALUES ($1,'Bob World','Bob private canon',$2,'private')", [bobPrivateWorld, bob]);
      await run("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [bobCreation, bobPrivateWorld]);
      await run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Bob on Alice creation')", [bobStoryOnAlicesCreation, aliceCreation, bob]);
    });

    await asAccount(pool, alice, (run) =>
      run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Alice on Bob creation')", [aliceStoryOnBobsCreation, bobCreation, alice]));

    await applyMigrations(pool, ["0019_conversation_worlds.sql"]);
  });

  afterAll(async () => { await pool?.end(); });

  async function worldsOf(userId: string, conversationId: string) {
    return asAccount(pool, userId, async (run) => {
      const result = await run(
        `SELECT w.name FROM conversation_worlds cw JOIN worlds w ON w.id=cw.world_id
         WHERE cw.conversation_id=$1 ORDER BY w.name`,
        [conversationId],
      );
      return result.rows.map((row) => String(row.name));
    });
  }

  it("gives a creator's own story exactly the worlds it was already reading", async () => {
    // Both of Alice's worlds were being loaded before the migration, private
    // one included, because they are hers and the creation is hers.
    expect(await worldsOf(alice, aliceStory)).toEqual(["Alice Public World", "Alice World"]);
  });

  it("gives a visitor's story nothing, because it was reading nothing", async () => {
    // Before this migration the chat route loaded worlds only for a creation
    // the caller owned. Bob's story with Alice's creation had no world canon,
    // and the backfill must not invent any — least of all Alice's private
    // world, which he has never been allowed to read.
    expect(await worldsOf(bob, bobStoryOnAlicesCreation)).toEqual([]);
    expect(await worldsOf(alice, aliceStoryOnBobsCreation)).toEqual([]);
  });

  it("never copies a world into a story whose owner cannot read it", async () => {
    const leaked = await asAccount(pool, alice, (run) => run(
      `SELECT count(*)::int count FROM conversation_worlds cw
       JOIN worlds w ON w.id=cw.world_id
       WHERE w.user_id<>cw.user_id AND w.visibility='private'`,
    ));
    expect(Number(leaked.rows[0].count)).toBe(0);
  });

  it("marks every existing story initialized, so none keeps inheriting", async () => {
    const pending = await asAccount(pool, alice, (run) =>
      run("SELECT count(*)::int count FROM conversations WHERE worlds_initialized=false"));
    expect(Number(pending.rows[0].count)).toBe(0);
  });

  it("leaves a story unchanged when the Creation's defaults change afterwards", async () => {
    await asAccount(pool, alice, (run) =>
      run("DELETE FROM character_worlds WHERE character_id=$1 AND world_id=$2", [aliceCreation, aliceWorld]));
    expect(await worldsOf(alice, aliceStory)).toEqual(["Alice Public World", "Alice World"]);
  });

  it("is safe to apply twice", async () => {
    await applyMigrations(pool, ["0019_conversation_worlds.sql"]);
    expect(await worldsOf(alice, aliceStory)).toEqual(["Alice Public World", "Alice World"]);
  });

  it("removes a story's link when the world itself is deleted", async () => {
    await asAccount(pool, alice, (run) => run("DELETE FROM worlds WHERE id=$1", [alicePublicWorld]));
    expect(await worldsOf(alice, aliceStory)).toEqual(["Alice World"]);
  });

  it("removes the whole set when the story is deleted", async () => {
    await asAccount(pool, alice, (run) => run("DELETE FROM conversations WHERE id=$1", [aliceStory]));
    expect(await worldsOf(alice, aliceStory)).toEqual([]);
  });
});
