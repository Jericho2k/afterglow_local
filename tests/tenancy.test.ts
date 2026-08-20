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
const aliceWorld = "12121212-0000-4000-8000-000000000001";
const alicePersona = "13131313-0000-4000-8000-000000000001";

describeTenancy("multi-tenant isolation", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await migratedPool();
    await createAccount(pool, alice, "alice@example.com");
    await createAccount(pool, bob, "bob@example.com");

    await asAccount(pool, alice, async (run) => {
      await run("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Alice Private',$3,'private'),($2,'Alice Public',$3,'public')", [alicePrivateCharacter, alicePublicCharacter, alice]);
      await run("INSERT INTO worlds (id,name,content,user_id) VALUES ($1,'Alice World','Secret canon',$2)", [aliceWorld, alice]);
      await run("INSERT INTO personas (id,name,user_id,is_default) VALUES ($1,'Alice Persona',$2,true)", [alicePersona, alice]);
      await run("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Alice private chat')", [aliceConversation, alicePrivateCharacter, alice]);
      await run("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user','Alice said something private')", [aliceMessage, aliceConversation, alice]);
      await run("INSERT INTO memories (id,character_id,conversation_id,user_id,content) VALUES ($1,$2,NULL,$3,'Alice character-level secret')", [aliceMemory, alicePublicCharacter, alice]);
      await run("INSERT INTO memory_arcs (id,conversation_id,user_id,summary) VALUES ($1,$2,$3,'Alice arc')", [aliceArc, aliceConversation, alice]);
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
