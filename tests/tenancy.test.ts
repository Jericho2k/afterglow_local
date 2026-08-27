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
/** An account that has published nothing, which is what "private" now means. */
const hermit = "55555555-5555-4555-8555-555555555555";

describeTenancy("multi-tenant isolation", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await migratedPool();
    await createAccount(pool, alice, "alice@example.com");
    await createAccount(pool, bob, "bob@example.com");
    await createAccount(pool, hermit, "hermit@example.com");

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

  it("keeps the profile of an account that has published nothing private", async () => {
    expect(await visibleCount(pool, bob, "profiles", "id=$1", [hermit])).toBe(0);
    expect(await visibleCount(pool, hermit, "profiles", "id=$1", [hermit])).toBe(1);
  });

  /*
   * Publishing is the opt-in to public attribution.
   *
   * This used to be "choosing a username is the opt-in", and that is the whole
   * of the report that a creation showed its creator to its creator and to
   * nobody else: publishing had no attribution consequence, so a creator who
   * never found the username field was anonymous on a page everybody could
   * read. Now the act of showing work to strangers is what names its author.
   */
  it("names a creator the moment they publish, and not before", async () => {
    const creator = "44444444-4444-4444-8444-444444444444";
    await createAccount(pool, creator, "creator@example.com");
    expect(await visibleCount(pool, bob, "profiles", "id=$1", [creator])).toBe(0);

    await asAccount(pool, creator, (run) => run(
      "INSERT INTO characters (id,name,user_id,visibility) VALUES (gen_random_uuid(),'Draft',$1,'private')", [creator]));
    expect(await visibleCount(pool, bob, "profiles", "id=$1", [creator])).toBe(0);

    await asAccount(pool, creator, (run) => run(
      "INSERT INTO characters (id,name,user_id,visibility,published_at) VALUES (gen_random_uuid(),'Published',$1,'public',now())", [creator]));
    expect(await visibleCount(pool, bob, "profiles", "id=$1", [creator])).toBe(1);
  });

  /*
   * A handle is never derived from an email address.
   *
   * `handle_new_user` falls back to the email's local part when somebody signs
   * up without typing a display name, so deriving a public handle from the
   * stored display name would publish half of their email to the platform. The
   * placeholder is recognised and replaced instead.
   */
  it("never publishes an email fragment as a handle or a name", async () => {
    const shy = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";
    await createAccount(pool, shy, "verysecret.address@example.com");
    await asAccount(pool, shy, (run) => run(
      "INSERT INTO characters (id,name,user_id,visibility,published_at) VALUES (gen_random_uuid(),'Published',$1,'public',now())", [shy]));
    const profile = await asAccount(pool, shy, (run) => run("SELECT username,display_name FROM profiles WHERE id=$1", [shy]));
    const { username, display_name: displayName } = profile.rows[0] as { username: string; display_name: string };
    expect(username).toBeTruthy();
    expect(username).not.toContain("verysecret");
    expect(displayName).not.toContain("verysecret");
    expect(username).toMatch(/^[a-z0-9][a-z0-9_-]{2,29}$/);
  });

  it("keeps a chosen display name, and derives a readable handle from it", async () => {
    const named = "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b";
    await createAccount(pool, named, "n@example.com");
    await asAccount(pool, named, (run) => run("UPDATE profiles SET display_name='Nocturne Atelier' WHERE id=$1", [named]));
    await asAccount(pool, named, (run) => run(
      "INSERT INTO characters (id,name,user_id,visibility,published_at) VALUES (gen_random_uuid(),'Published',$1,'public',now())", [named]));
    const profile = await asAccount(pool, named, (run) => run("SELECT username,display_name FROM profiles WHERE id=$1", [named]));
    expect(profile.rows[0].username).toBe("nocturne_atelier");
    expect(profile.rows[0].display_name).toBe("Nocturne Atelier");
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
   * Conversation worlds.
   *
   * A story's world set is as private as the story, and it is the only place a
   * chat may write. The two guarantees it has to keep are that nobody else can
   * see or change it, and that it can never be pointed at lore its owner is not
   * allowed to read — which is why the check exists on the way IN as well as on
   * the way out.
   */
  it("W — keeps a story's world set private to the story's owner", async () => {
    await asAccount(pool, alice, (run) => run(
      "INSERT INTO conversation_worlds (conversation_id,world_id,user_id) VALUES ($1,$2,$3)",
      [aliceConversation, aliceWorld, alice],
    ));
    expect(await visibleCount(pool, alice, "conversation_worlds", "conversation_id=$1", [aliceConversation])).toBe(1);
    expect(await visibleCount(pool, bob, "conversation_worlds")).toBe(0);
  });

  it("W — refuses to let another account read, add or remove a story's worlds", async () => {
    await asAccount(pool, bob, async (run) => {
      expect((await run("SELECT world_id FROM conversation_worlds WHERE conversation_id=$1", [aliceConversation])).rowCount).toBe(0);
      expect((await run("DELETE FROM conversation_worlds WHERE conversation_id=$1", [aliceConversation])).rowCount).toBe(0);
    });
    expect(await visibleCount(pool, alice, "conversation_worlds", "conversation_id=$1", [aliceConversation])).toBe(1);
  });

  it("W — refuses to attach a world to another account's story", async () => {
    // Claiming the row as your own fails the composite foreign key: the pair
    // (conversation, owner) does not exist. Naming the true owner fails the
    // policy. Neither order gets through.
    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO conversation_worlds (conversation_id,world_id,user_id) VALUES ($1,$2,$3)",
      [aliceConversation, alicePublicWorld, bob],
    ))).rejects.toThrow(/foreign key constraint/i);
    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO conversation_worlds (conversation_id,world_id,user_id) VALUES ($1,$2,$3)",
      [aliceConversation, alicePublicWorld, alice],
    ))).rejects.toThrow(/row-level security/i);
  });

  it("W — refuses to attach a world the account cannot read", async () => {
    const bobConversation = "44444444-4444-4444-4444-444444444444";
    await asAccount(pool, bob, (run) => run(
      "INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Bob chat') ON CONFLICT DO NOTHING",
      [bobConversation, alicePublicCharacter, bob],
    ));
    // Alice's private world is not Bob's to put into a prompt, even though he
    // is chatting with the creation it is attached to.
    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO conversation_worlds (conversation_id,world_id,user_id) VALUES ($1,$2,$3)",
      [bobConversation, aliceWorld, bob],
    ))).rejects.toThrow(/row-level security/i);
    // Her published one is.
    await asAccount(pool, bob, (run) => run(
      "INSERT INTO conversation_worlds (conversation_id,world_id,user_id) VALUES ($1,$2,$3)",
      [bobConversation, alicePublicWorld, bob],
    ));
    expect(await visibleCount(pool, bob, "conversation_worlds", "conversation_id=$1", [bobConversation])).toBe(1);
  });

  /**
   * Creator Profile V2.
   *
   * Four new relations, and the question for each is the same: what does the
   * product intentionally make public, and what must stay private even though
   * it is about public work?
   *
   *   A FOLLOWER COUNT is public. The follower LIST is not — a creator learning
   *   exactly which accounts read their work is a different product with
   *   different consent.
   *
   *   AN ACHIEVEMENT and a MILESTONE are public, because they are thresholds on
   *   numbers that are already public. Writing one is self-only, so no account
   *   can grant another one anything.
   *
   *   A RANK is a public aggregate over public work, readable by anybody and
   *   writable by nobody: only the ranking function, which runs as its definer,
   *   may change a row.
   *
   * The creators here are their own accounts rather than Alice, because a
   * public profile requires a username and the suite above deliberately asserts
   * that Alice has never chosen one.
   */
  const nova = "77777777-7777-4777-8777-777777777777";
  const eris = "66666666-6666-4666-8666-666666666666";
  const novaCreation = "78787878-7878-4878-8878-787878787878";

  beforeAll(async () => {
    await createAccount(pool, nova, "nova@example.com");
    await createAccount(pool, eris, "eris@example.com");
    await asAccount(pool, nova, async (run) => {
      await run("UPDATE profiles SET username='nova' WHERE id=$1", [nova]);
      await run("INSERT INTO characters (id,name,user_id,visibility,user_message_count) VALUES ($1,'Nova Public',$2,'public',40)", [novaCreation, nova]);
      await run("INSERT INTO characters (id,name,user_id,visibility) VALUES (gen_random_uuid(),'Nova Private',$1,'private')", [nova]);
    });
    await asAccount(pool, eris, (run) => run("UPDATE profiles SET username='eris' WHERE id=$1", [eris]));
  });

  it("P — lets an account follow and unfollow, and nobody else do it for them", async () => {
    await asAccount(pool, bob, (run) => run(
      "INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [bob, nova]));
    expect(await visibleCount(pool, bob, "profile_follows", "creator_user_id=$1", [nova])).toBe(1);

    // Bob cannot make somebody else follow anybody.
    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2)", [eris, nova],
    ))).rejects.toThrow(/row-level security/i);
    // Nor delete somebody else's follow.
    await asAccount(pool, eris, async (run) => {
      expect((await run("DELETE FROM profile_follows WHERE follower_user_id=$1", [bob])).rowCount).toBe(0);
    });
    expect(await visibleCount(pool, bob, "profile_follows", "creator_user_id=$1", [nova])).toBe(1);
  });

  it("P — refuses a self-follow at the database, not just in a route", async () => {
    // Nova rather than Bob, because Bob has no public profile and would be
    // refused by the policy first — this asserts the CHECK constraint itself.
    await expect(asAccount(pool, nova, (run) => run(
      "INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$1)", [nova],
    ))).rejects.toThrow(/profile_follows_not_self/i);
  });

  it("P — refuses to follow an account that has published nothing", async () => {
    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2)", [bob, hermit],
    ))).rejects.toThrow(/row-level security/i);
  });

  it("P — is idempotent, so a double tap cannot double-count", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await asAccount(pool, bob, (run) => run(
        "INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [bob, nova]));
    }
    const count = await asAccount(pool, nova, (run) => run("SELECT follower_count FROM profiles WHERE id=$1", [nova]));
    expect(Number(count.rows[0].follower_count)).toBe(1);
  });

  it("P — publishes the follower count while keeping the follower list private", async () => {
    await asAccount(pool, bob, (run) => run(
      "INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [bob, nova]));

    // Carol sees Nova's count, and cannot see who is in it.
    const seen = await asAccount(pool, eris, (run) => run("SELECT follower_count FROM profiles WHERE id=$1", [nova]));
    expect(Number(seen.rows[0].follower_count)).toBe(1);
    expect(await visibleCount(pool, eris, "profile_follows", "creator_user_id=$1", [nova])).toBe(0);
    // The creator may see that somebody follows them; that is their own row.
    expect(await visibleCount(pool, nova, "profile_follows", "creator_user_id=$1", [nova])).toBe(1);
  });

  it("P — keeps achievements public-readable and self-writable only", async () => {
    await asAccount(pool, nova, (run) => run(
      "INSERT INTO profile_achievements (user_id,achievement_id) VALUES ($1,'creations_1') ON CONFLICT DO NOTHING", [nova]));
    // Public, because it is a threshold on numbers that are already public.
    expect(await visibleCount(pool, bob, "profile_achievements", "user_id=$1", [nova])).toBe(1);
    // But Bob cannot award one.
    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO profile_achievements (user_id,achievement_id) VALUES ($1,'rank_top_10')", [nova],
    ))).rejects.toThrow(/row-level security/i);
    await asAccount(pool, bob, async (run) => {
      expect((await run("DELETE FROM profile_achievements WHERE user_id=$1", [nova])).rowCount).toBe(0);
    });
  });

  it("P — hides an achievement belonging to an account that has published nothing", async () => {
    await asAccount(pool, hermit, (run) => run(
      "INSERT INTO profile_achievements (user_id,achievement_id) VALUES ($1,'creations_1') ON CONFLICT DO NOTHING", [hermit]));
    expect(await visibleCount(pool, bob, "profile_achievements", "user_id=$1", [hermit])).toBe(0);
    expect(await visibleCount(pool, hermit, "profile_achievements", "user_id=$1", [hermit])).toBe(1);
  });

  it("P — keeps activity public-readable, self-writable, and unrepeatable", async () => {
    await asAccount(pool, nova, (run) => run(
      "INSERT INTO profile_activity (id,user_id,kind,key,title,subject) VALUES (gen_random_uuid(),$1,'milestone','followers:100','Milestone reached','100 followers')", [nova]));
    expect(await visibleCount(pool, bob, "profile_activity", "user_id=$1", [nova])).toBe(1);

    // The same threshold cannot fire twice.
    await expect(asAccount(pool, nova, (run) => run(
      "INSERT INTO profile_activity (id,user_id,kind,key,title,subject) VALUES (gen_random_uuid(),$1,'milestone','followers:100','Milestone reached','100 followers')", [nova],
    ))).rejects.toThrow(/duplicate key|profile_activity_key_idx/i);

    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO profile_activity (id,user_id,kind,key,title,subject) VALUES (gen_random_uuid(),$1,'rank','rank:10','Entered the Top 10','Top 10 creator')", [nova],
    ))).rejects.toThrow(/row-level security/i);
  });

  it("P — publishes the standings and lets nobody write them", async () => {
    await asAccount(pool, nova, (run) => run("SELECT public.refresh_creator_stats()"));
    const seen = await asAccount(pool, bob, (run) => run("SELECT rank,user_messages,published_creations FROM creator_stats WHERE user_id=$1", [nova]));
    expect(seen.rowCount).toBe(1);
    expect(Number(seen.rows[0].rank)).toBeGreaterThan(0);
    expect(Number(seen.rows[0].user_messages)).toBe(40);
    // Only published work counts: Nova has one public creation and one private.
    expect(Number(seen.rows[0].published_creations)).toBe(1);

    await expect(asAccount(pool, bob, (run) => run(
      "UPDATE creator_stats SET rank=1 WHERE user_id=$1", [nova],
    ))).rejects.toThrow(/permission denied|row-level security/i);
    await expect(asAccount(pool, bob, (run) => run(
      "INSERT INTO creator_stats (user_id,rank) VALUES ($1,1)", [bob],
    ))).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("P — does not rank an account that has published nothing", async () => {
    await asAccount(pool, nova, (run) => run("SELECT public.refresh_creator_stats()"));
    expect(await visibleCount(pool, bob, "creator_stats", "user_id=$1", [eris])).toBe(0);
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

  /**
   * Locked world previews.
   *
   * A public creation may be built on a private world, and the creation page
   * shows that association without showing its content. Row level security
   * correctly refuses to return the world row itself, which is why the
   * association used to vanish entirely — so a preview function supplies the
   * four columns the card needs and nothing else. These are the tests that
   * matter: what a visitor gets, what they cannot get, and that the function
   * cannot be pointed at a creation they were never allowed to read.
   */
  it("previews a private world attached to a public creation without its lore", async () => {
    await asAccount(pool, alice, (run) => run("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [alicePublicCharacter, aliceWorld]));

    // The row itself is still invisible to Bob. Nothing was loosened.
    expect(await visibleCount(pool, bob, "worlds", "id=$1", [aliceWorld])).toBe(0);

    const preview = await asAccount(pool, bob, (run) => run("SELECT * FROM creation_world_previews($1)", [alicePublicCharacter]));
    const locked = preview.rows.find((row) => String(row.id) === aliceWorld);
    expect(locked).toBeTruthy();
    expect(locked?.name).toBe("Alice World");
    // Four columns, so there is no lore to omit rather than lore that was
    // omitted carefully.
    expect(Object.keys(locked ?? {}).sort()).toEqual(["cover_path", "cover_url", "id", "name"]);
    expect(JSON.stringify(preview.rows)).not.toContain("Secret canon");
  });

  it("refuses to preview the worlds of a creation the caller cannot read", async () => {
    await asAccount(pool, alice, (run) => run("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [alicePrivateCharacter, aliceWorld]));
    const preview = await asAccount(pool, bob, (run) => run("SELECT * FROM creation_world_previews($1)", [alicePrivateCharacter]));
    expect(preview.rows).toHaveLength(0);
    // The owner still sees their own.
    const owner = await asAccount(pool, alice, (run) => run("SELECT * FROM creation_world_previews($1)", [alicePrivateCharacter]));
    expect(owner.rows).toHaveLength(1);
  });

  /**
   * Continuity feedback.
   *
   * A label says "this reply broke my story", which implies what was in that
   * story. So it is strictly the reader's own: not the creator's to enumerate,
   * not attachable to somebody else's message, and never readable across
   * accounts.
   */
  it("keeps continuity feedback private to the reader who wrote it", async () => {
    await asAccount(pool, alice, (run) => run(
      `INSERT INTO memory_feedback (id,user_id,conversation_id,message_id,category,note)
       VALUES (gen_random_uuid(),$1,$2,$3,'forgot_something','she forgot the letters')`,
      [alice, aliceConversation, aliceMessage],
    ));
    expect(await visibleCount(pool, alice, "memory_feedback", "message_id=$1", [aliceMessage])).toBe(1);
    // Bob cannot see it, and neither could a creator whose creation it was.
    expect(await visibleCount(pool, bob, "memory_feedback", "message_id=$1", [aliceMessage])).toBe(0);
  });

  it("refuses to attach feedback to another account's message", async () => {
    await asAccount(pool, bob, (run) => run(
      `INSERT INTO memory_feedback (id,user_id,conversation_id,message_id,category)
       VALUES (gen_random_uuid(),$1,$2,$3,'other')`,
      [bob, aliceConversation, aliceMessage],
    )).catch(() => undefined);
    // Whether it failed the policy or the ownership predicate, nothing landed.
    expect(await visibleCount(pool, bob, "memory_feedback", "true")).toBe(0);
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
