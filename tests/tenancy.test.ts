import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAccount, createAccount, migratedPool, tenancyDatabaseUrl, visibleCount } from "./helpers/tenancy";

/**
 * Cross-account isolation, verified against the real policies.
 *
 * Skipped when TEST_DATABASE_URL is absent so `npm test` still runs anywhere;
 * CI provides a PostgreSQL service so these do run there.
 */
const describeTenancy = tenancyDatabaseUrl ? describe : describe.skip;

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const alicePrivateCharacter = "aaaaaaaa-0000-4000-8000-000000000001";
const alicePublicCharacter = "aaaaaaaa-0000-4000-8000-000000000002";
const aliceConversation = "cccccccc-0000-4000-8000-000000000001";
const aliceMessage = "dddddddd-0000-4000-8000-000000000001";
const aliceMemory = "eeeeeeee-0000-4000-8000-000000000001";
const aliceArc = "ffffffff-0000-4000-8000-000000000001";
const alicePublicWorld = "aaaaaaaa-0000-4000-8000-000000000021";
const aliceWorld = "12121212-0000-4000-8000-000000000001";
const alicePersona = "13131313-0000-4000-8000-000000000001";
const aliceCanon = "14141414-0000-4000-8000-000000000001";
const aliceRetrieval = "15151515-0000-4000-8000-000000000001";
const aliceScene = "16161616-0000-4000-8000-000000000001";

describeTenancy("multi-tenant isolation", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await migratedPool();
    await createAccount(pool, alice, "alice@example.com");
    await createAccount(pool, bob, "bob@example.com");

    await asAccount(pool, alice, async (run) => {
      await run("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Alice Private',$3,'private'),($2,'Alice Public',$3,'public')", [alicePrivateCharacter, alicePublicCharacter, alice]);
      await run("INSERT INTO worlds (id,name,content,user_id) VALUES ($1,'Alice World','Secret canon',$2)", [aliceWorld, alice]);
      await run("INSERT INTO worlds (id,name,content,user_id,visibility) VALUES ($1,'Alice Public World','Published canon',$2,'public')", [alicePublicWorld, alice]);
      await run("INSERT INTO personas (id,name,user_id,is_default) VALUES ($1,'Alice Persona',$2,true)", [alicePersona, alice]);
      await run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Alice private chat')", [aliceConversation, alicePrivateCharacter, alice]);
      await run("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user','Alice said something private')", [aliceMessage, aliceConversation, alice]);
      await run("INSERT INTO memories (id,character_id,conversation_id,user_id,content) VALUES ($1,$2,NULL,$3,'Alice character-level secret')", [aliceMemory, alicePublicCharacter, alice]);
      await run("INSERT INTO memory_arcs (id,conversation_id,user_id,summary) VALUES ($1,$2,$3,'Alice arc')", [aliceArc, aliceConversation, alice]);
      await run("INSERT INTO core_canon_entries (id,conversation_id,character_id,user_id,content) VALUES ($1,$2,$3,$4,'Alice foundational canon')",[aliceCanon,aliceConversation,alicePrivateCharacter,alice]);
      await run("INSERT INTO memory_retrieval_runs (id,conversation_id,user_id,recalled_memory_ids) VALUES ($1,$2,$3,$4)",[aliceRetrieval,aliceConversation,alice,[aliceMemory]]);
      await run(
        "INSERT INTO conversation_scene_states (id,conversation_id,user_id,through_message_count,story_day,location_place,location_sub,present_characters,active_situation) VALUES ($1,$2,$3,4,7,'Alice private apartment','bedroom',$4,$5)",
        [aliceScene,aliceConversation,alice,["Alice","Maya"],["They are still arguing."]],
      );
      await run("INSERT INTO usage_events (id,user_id,model,usage_type,estimated_cost_usd) VALUES (gen_random_uuid(),$1,'deepseek-v4-flash','chat',1.25)", [alice]);
    });
  });

  afterAll(async () => { await pool?.end(); });

  it("hides a private character from another account", async () => {
    expect(await visibleCount(pool, bob, "characters", "id=$1", [alicePrivateCharacter])).toBe(0);
  });

  it("lets another account read a published character", async () => {
    expect(await visibleCount(pool, bob, "characters", "id=$1", [alicePublicCharacter])).toBe(1);
  });

  it("refuses to let another account modify a published character", async () => {
    await asAccount(pool, bob, async (run) => {
      const updated = await run("UPDATE characters SET name='hijacked' WHERE id=$1", [alicePublicCharacter]);
      expect(updated.rowCount).toBe(0);
      const deleted = await run("DELETE FROM characters WHERE id=$1", [alicePublicCharacter]);
      expect(deleted.rowCount).toBe(0);
    });
    const name = await asAccount(pool, alice, async (run) => {
      const result = await run("SELECT name FROM characters WHERE id=$1", [alicePublicCharacter]);
      return String(result.rows[0].name);
    });
    expect(name).toBe("Alice Public");
  });

  it("keeps conversations, messages and arcs private", async () => {
    expect(await visibleCount(pool, bob, "conversations")).toBe(0);
    expect(await visibleCount(pool, bob, "messages")).toBe(0);
    expect(await visibleCount(pool, bob, "memory_arcs")).toBe(0);
    expect(await visibleCount(pool, bob, "core_canon_entries")).toBe(0);
    expect(await visibleCount(pool, bob, "memory_retrieval_runs")).toBe(0);
    expect(await visibleCount(pool, alice, "core_canon_entries", "id=$1",[aliceCanon])).toBe(1);
  });

  it("keeps memories private even when they hang off a public character", async () => {
    // The character is readable by Bob; the memory Alice recorded against it is not.
    expect(await visibleCount(pool, bob, "memories", "character_id=$1", [alicePublicCharacter])).toBe(0);
    expect(await visibleCount(pool, alice, "memories", "id=$1", [aliceMemory])).toBe(1);
  });

  it("keeps the usage ledger private per account", async () => {
    expect(await visibleCount(pool, bob, "usage_events")).toBe(0);
    expect(await visibleCount(pool, alice, "usage_events")).toBe(1);
  });

  it("keeps worlds and personas private", async () => {
    expect(await visibleCount(pool, bob, "worlds", "id=$1", [aliceWorld])).toBe(0);
    expect(await visibleCount(pool, bob, "personas", "id=$1", [alicePersona])).toBe(0);
  });

  it("keeps profiles private to their owner", async () => {
    expect(await visibleCount(pool, bob, "profiles", "id=$1", [alice])).toBe(0);
    expect(await visibleCount(pool, bob, "profiles", "id=$1", [bob])).toBe(1);
  });

  it("publishes only creator profiles that explicitly choose a username", async () => {
    const creator = "44444444-4444-4444-8444-444444444444";
    await createAccount(pool, creator, "creator@example.com");
    expect(await visibleCount(pool, bob, "profiles", "id=$1", [creator])).toBe(0);
    await asAccount(pool, creator, (run) => run("UPDATE profiles SET username='public_creator' WHERE id=$1", [creator]));
    expect(await visibleCount(pool, bob, "profiles", "id=$1", [creator])).toBe(1);
  });

  it("isolates favorites while maintaining a public aggregate count", async () => {
    await asAccount(pool, bob, (run) => run("INSERT INTO character_likes (user_id,character_id) VALUES ($1,$2)", [bob,alicePublicCharacter]));
    expect(await visibleCount(pool, bob, "character_likes", "character_id=$1", [alicePublicCharacter])).toBe(1);
    expect(await visibleCount(pool, alice, "character_likes", "character_id=$1", [alicePublicCharacter])).toBe(0);
    const count = await asAccount(pool, alice, async (run) => Number((await run("SELECT like_count FROM characters WHERE id=$1",[alicePublicCharacter])).rows[0].like_count));
    expect(count).toBe(1);
  });

  it("keeps moderation reports visible only to the reporter", async () => {
    const report = "45454545-4545-4545-8545-454545454545";
    await asAccount(pool, bob, (run) => run("INSERT INTO character_reports (id,user_id,character_id,reason,character_name) VALUES ($1,$2,$3,'other','Alice Public')",[report,bob,alicePublicCharacter]));
    expect(await visibleCount(pool, bob, "character_reports", "id=$1",[report])).toBe(1);
    expect(await visibleCount(pool, alice, "character_reports", "id=$1",[report])).toBe(0);
  });

  it("keeps a gallery readable where its character is and writable only by its owner", async () => {
    const image = "51515151-5151-4151-8151-515151515151";
    await asAccount(pool, alice, (run) => run(
      "INSERT INTO character_gallery (id,character_id,user_id,storage_path) VALUES ($1,$2,$3,'users/a/g/1.png')",
      [image, alicePublicCharacter, alice],
    ));
    // Bob can see the published character's gallery but cannot alter it.
    expect(await visibleCount(pool, bob, "character_gallery", "id=$1", [image])).toBe(1);
    await asAccount(pool, bob, async (run) => {
      expect((await run("UPDATE character_gallery SET caption='hijacked' WHERE id=$1", [image])).rowCount).toBe(0);
      expect((await run("DELETE FROM character_gallery WHERE id=$1", [image])).rowCount).toBe(0);
    });
    // And a private character's gallery is not visible at all.
    const privateImage = "52525252-5252-4252-8252-525252525252";
    await asAccount(pool, alice, (run) => run(
      "INSERT INTO character_gallery (id,character_id,user_id,storage_path) VALUES ($1,$2,$3,'users/a/g/2.png')",
      [privateImage, alicePrivateCharacter, alice],
    ));
    expect(await visibleCount(pool, bob, "character_gallery", "id=$1", [privateImage])).toBe(0);
  });

  it("keeps comments public with the character and editable only by their author", async () => {
    const comment = "53535353-5353-4353-8353-535353535353";
    await asAccount(pool, bob, (run) => run(
      "INSERT INTO character_comments (id,character_id,user_id,body) VALUES ($1,$2,$3,'Great character')",
      [comment, alicePublicCharacter, bob],
    ));
    expect(await visibleCount(pool, alice, "character_comments", "id=$1", [comment])).toBe(1);
    // Alice owns the character, so she may remove a comment from her page but
    // must not be able to rewrite what somebody else said.
    await asAccount(pool, alice, async (run) => {
      expect((await run("UPDATE character_comments SET body='rewritten' WHERE id=$1", [comment])).rowCount).toBe(0);
    });
    await asAccount(pool, bob, async (run) => {
      expect((await run("UPDATE character_comments SET body='edited by author' WHERE id=$1", [comment])).rowCount).toBe(1);
    });
    await asAccount(pool, alice, async (run) => {
      expect((await run("DELETE FROM character_comments WHERE id=$1", [comment])).rowCount).toBe(1);
    });
  });

  it("refuses to attach a gallery image to a character the account does not own", async () => {
    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO character_gallery (id,character_id,user_id,storage_path) VALUES (gen_random_uuid(),$1,$2,'users/b/g/1.png')",
      [alicePublicCharacter, bob],
    ))).rejects.toThrow(/foreign key constraint|row-level security/i);
  });

  it("keeps per-account settings separate", async () => {
    expect(await visibleCount(pool, bob, "user_settings", "user_id=$1", [alice])).toBe(0);
    expect(await visibleCount(pool, bob, "user_settings", "user_id=$1", [bob])).toBe(1);
  });

  it("lets a second account start a private chat from a published character", async () => {
    const bobConversation = "cccccccc-0000-4000-8000-000000000002";
    await asAccount(pool, bob, async (run) => {
      await run(
        "INSERT INTO conversations (id,character_id,user_id,title,character_snapshot) VALUES ($1,$2,$3,'Bob chat',$4::jsonb)",
        [bobConversation, alicePublicCharacter, bob, JSON.stringify({ name: "Alice Public", greeting: "Hello" })],
      );
      await run("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES (gen_random_uuid(),$1,$2,'user','Bob speaks')", [bobConversation, bob]);
    });
    // Bob's story exists and stays invisible to the character's creator.
    expect(await visibleCount(pool, bob, "conversations", "id=$1", [bobConversation])).toBe(1);
    expect(await visibleCount(pool, alice, "conversations", "id=$1", [bobConversation])).toBe(0);
    expect(await visibleCount(pool, alice, "messages", "conversation_id=$1", [bobConversation])).toBe(0);
  });

  it("refuses to attach a message to another account's conversation", async () => {
    await expect(asAccount(pool, bob, (run) =>
      run("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES (gen_random_uuid(),$1,$2,'user','smuggled')", [aliceConversation, bob]),
    )).rejects.toThrow(/foreign key constraint/i);
  });

  it("refuses to claim another account's row as your own", async () => {
    await expect(asAccount(pool, bob, (run) =>
      run("INSERT INTO characters (id,name,user_id) VALUES (gen_random_uuid(),'Impersonated',$1)", [alice]),
    )).rejects.toThrow(/row-level security/i);
  });

  it("refuses to delete a published character other accounts are chatting with", async () => {
    await expect(asAccount(pool, alice, (run) =>
      run("DELETE FROM characters WHERE id=$1", [alicePublicCharacter]),
    )).rejects.toThrow(/character_in_use_by_other_accounts/);
  });

  it("O — hides one account's scene state from another", async () => {
    expect(await visibleCount(pool, bob, "conversation_scene_states")).toBe(0);
    expect(await visibleCount(pool, bob, "conversation_scene_states", "id=$1", [aliceScene])).toBe(0);
    expect(await visibleCount(pool, alice, "conversation_scene_states", "id=$1", [aliceScene])).toBe(1);
  });

  it("O — refuses to let another account read, rewrite, or delete a scene", async () => {
    await asAccount(pool, bob, async (run) => {
      const leaked = await run("SELECT location_place FROM conversation_scene_states WHERE id=$1", [aliceScene]);
      expect(leaked.rowCount).toBe(0);
      const updated = await run("UPDATE conversation_scene_states SET location_place='hijacked' WHERE id=$1", [aliceScene]);
      expect(updated.rowCount).toBe(0);
      const deleted = await run("DELETE FROM conversation_scene_states WHERE id=$1", [aliceScene]);
      expect(deleted.rowCount).toBe(0);
    });
    expect(await visibleCount(pool, alice, "conversation_scene_states", "location_place='Alice private apartment'")).toBe(1);
  });

  it("O — refuses to write a scene into another account's conversation", async () => {
    await expect(asAccount(pool, bob, (run) =>
      run("INSERT INTO conversation_scene_states (id,conversation_id,user_id,through_message_count) VALUES (gen_random_uuid(),$1,$2,1)", [aliceConversation, bob]),
    )).rejects.toThrow(/foreign key constraint/i);
    await expect(asAccount(pool, bob, (run) =>
      run("INSERT INTO conversation_scene_states (id,conversation_id,user_id,through_message_count) VALUES (gen_random_uuid(),$1,$2,1)", [aliceConversation, alice]),
    )).rejects.toThrow(/row-level security/i);
  });


  /**
   * Worlds V2.
   *
   * A world is now a public object with its own saves and its own discussion,
   * so it needs the same isolation guarantees a creation has: published canon
   * is readable by everybody, private canon by nobody but its owner, and the
   * two social relations behind it are private to whoever wrote them.
   */
  it("lets another account read a published world and never a private one", async () => {
    expect(await visibleCount(pool, bob, "worlds", "id=$1", [alicePublicWorld])).toBe(1);
    expect(await visibleCount(pool, bob, "worlds", "id=$1", [aliceWorld])).toBe(0);
  });

  it("lets the owner read their own private world", async () => {
    expect(await visibleCount(pool, alice, "worlds", "id=$1", [aliceWorld])).toBe(1);
  });

  it("refuses to let another account edit or delete a world", async () => {
    await asAccount(pool, bob, (run) => run("UPDATE worlds SET name='Hijacked' WHERE id=$1", [alicePublicWorld]));
    await asAccount(pool, bob, (run) => run("DELETE FROM worlds WHERE id=$1", [alicePublicWorld]));
    const rows = await asAccount(pool, alice, (run) => run("SELECT name FROM worlds WHERE id=$1", [alicePublicWorld]));
    expect(rows.rows[0]?.name).toBe("Alice Public World");
  });

  it("keeps a saved-worlds library private to the account that saved", async () => {
    await asAccount(pool, bob, (run) => run("INSERT INTO world_saves (user_id,world_id) VALUES ($1,$2)", [bob, alicePublicWorld]));
    expect(await visibleCount(pool, bob, "world_saves", "world_id=$1", [alicePublicWorld])).toBe(1);
    // Not even the world's own creator can see who saved it — only the total,
    // which lives on the world row and is maintained by the trigger.
    expect(await visibleCount(pool, alice, "world_saves", "world_id=$1", [alicePublicWorld])).toBe(0);
    const total = await asAccount(pool, alice, (run) => run("SELECT save_count FROM worlds WHERE id=$1", [alicePublicWorld]));
    expect(Number(total.rows[0]?.save_count)).toBe(1);
  });

  it("refuses to record a save in somebody else's name", async () => {
    await expect(asAccount(pool, bob, (run) =>
      run("INSERT INTO world_saves (user_id,world_id) VALUES ($1,$2)", [alice, alicePublicWorld]),
    )).rejects.toThrow(/row-level security/i);
  });

  it("keeps world comments public with the world and editable only by their author", async () => {
    const comment = "bbbbbbbb-0000-4000-8000-000000000031";
    await asAccount(pool, bob, (run) =>
      run("INSERT INTO world_comments (id,world_id,user_id,body) VALUES ($1,$2,$3,'Great setting')", [comment, alicePublicWorld, bob]));
    expect(await visibleCount(pool, alice, "world_comments", "id=$1", [comment])).toBe(1);

    await asAccount(pool, alice, (run) => run("UPDATE world_comments SET body='Rewritten' WHERE id=$1", [comment]));
    const rows = await asAccount(pool, bob, (run) => run("SELECT body FROM world_comments WHERE id=$1", [comment]));
    expect(rows.rows[0]?.body).toBe("Great setting");
  });

  it("refuses a comment on a world the account cannot read", async () => {
    await expect(asAccount(pool, bob, (run) =>
      run("INSERT INTO world_comments (id,world_id,user_id,body) VALUES (gen_random_uuid(),$1,$2,'Peeking')", [aliceWorld, bob]),
    )).rejects.toThrow(/row-level security/i);
  });

  it("lets a world's owner remove a comment from their own page", async () => {
    const comment = "bbbbbbbb-0000-4000-8000-000000000032";
    await asAccount(pool, bob, (run) =>
      run("INSERT INTO world_comments (id,world_id,user_id,body) VALUES ($1,$2,$3,'To be removed')", [comment, alicePublicWorld, bob]));
    await asAccount(pool, alice, (run) => run("DELETE FROM world_comments WHERE id=$1", [comment]));
    expect(await visibleCount(pool, bob, "world_comments", "id=$1", [comment])).toBe(0);
  });

  it("keeps Discovery preferences on the account rather than shared", async () => {
    await asAccount(pool, alice, (run) =>
      run(`UPDATE user_settings SET discovery_preferences='{"tags":["Fantasy"]}'::jsonb WHERE user_id=$1`, [alice]));
    const mine = await asAccount(pool, alice, (run) => run("SELECT discovery_preferences FROM user_settings WHERE user_id=$1", [alice]));
    expect(mine.rows[0]?.discovery_preferences).toMatchObject({ tags: ["Fantasy"] });
    // Bob cannot read Alice's row at all, so her filters can never reach him.
    expect(await visibleCount(pool, bob, "user_settings", "user_id=$1", [alice])).toBe(0);
  });

  it("does not let an account write another account's preferences", async () => {
    await asAccount(pool, bob, (run) =>
      run(`UPDATE user_settings SET discovery_preferences='{"tags":["Horror"]}'::jsonb WHERE user_id=$1`, [alice]));
    const mine = await asAccount(pool, alice, (run) => run("SELECT discovery_preferences FROM user_settings WHERE user_id=$1", [alice]));
    expect(mine.rows[0]?.discovery_preferences).toMatchObject({ tags: ["Fantasy"] });
  });

  it("does not let another account read rich content belonging to a private world", async () => {
    await asAccount(pool, alice, (run) =>
      run(`UPDATE worlds SET content_rich='[{"type":"image","path":"users/a/secret-map.png","url":"","caption":"The hidden route"}]'::jsonb WHERE id=$1`, [aliceWorld]));
    const rows = await asAccount(pool, bob, (run) => run("SELECT content_rich FROM worlds WHERE id=$1", [aliceWorld]));
    expect(rows.rowCount).toBe(0);
  });

  it("gives every account its own default persona", async () => {
    await asAccount(pool, bob, (run) => run("INSERT INTO personas (id,name,user_id,is_default) VALUES (gen_random_uuid(),'Bob Persona',$1,true)", [bob]));
    expect(await visibleCount(pool, bob, "personas", "is_default")).toBe(1);
    expect(await visibleCount(pool, alice, "personas", "is_default")).toBe(1);
  });

  it("creates a profile and settings row for every new account", async () => {
    const carol = "33333333-3333-4333-8333-333333333333";
    await createAccount(pool, carol, "carol@example.com");
    expect(await visibleCount(pool, carol, "profiles", "id=$1", [carol])).toBe(1);
    expect(await visibleCount(pool, carol, "user_settings", "user_id=$1", [carol])).toBe(1);
  });

  it("does not let an account rewrite the server-managed defaults", async () => {
    await expect(asAccount(pool, bob, (run) =>
      run("UPDATE app_settings SET model='free-money' WHERE id='owner'"),
    )).rejects.toThrow(/permission denied|row-level security/i);
  });
});
