import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureSchema, getDefaultSettings, messageFromRow, query, setPoolForTesting, transaction } from "@/lib/db";
import { invalidateDerivedContinuity, relevantMemories } from "@/lib/memory";
import { deleteMessagesFromPosition, lockMessageForMutation, persistedMessagePosition, truncateMessagesAfterPosition } from "@/lib/message-mutations";

const ownerId = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
});

describe("PostgreSQL persistence", () => {
  it("upgrades the pre-archive schema before creating indexes on new columns", async () => {
    const oldDb = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true }); const adapter = oldDb.adapters.createPg();
    const oldPool = new adapter.Pool() as unknown as Pool;
    await oldPool.query(`
      CREATE TABLE characters (id uuid PRIMARY KEY,name text NOT NULL,tagline text NOT NULL DEFAULT '',avatar_url text NOT NULL DEFAULT '',accent text NOT NULL DEFAULT '#e879a9',backstory text NOT NULL DEFAULT '',personality text NOT NULL DEFAULT '',scenario text NOT NULL DEFAULT '',greeting text NOT NULL DEFAULT '',example_dialogue text NOT NULL DEFAULT '',response_directive text NOT NULL DEFAULT '',boundaries text NOT NULL DEFAULT '',nsfw_enabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE conversations (id uuid PRIMARY KEY,character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,title text NOT NULL DEFAULT '',summary text NOT NULL DEFAULT '',message_count integer NOT NULL DEFAULT 0,last_consolidated_count integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE messages (id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role text NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE memories (id uuid PRIMARY KEY,character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,content text NOT NULL,kind text NOT NULL DEFAULT 'event',importance smallint NOT NULL DEFAULT 3,keywords text[] NOT NULL DEFAULT '{}',pinned boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE usage_events (id uuid PRIMARY KEY,conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,model text NOT NULL,prompt_tokens integer NOT NULL DEFAULT 0,completion_tokens integer NOT NULL DEFAULT 0,cache_hit_tokens integer NOT NULL DEFAULT 0,cache_miss_tokens integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE app_settings (id text PRIMARY KEY,owner_name text NOT NULL DEFAULT 'You',owner_profile text NOT NULL DEFAULT '',model text NOT NULL DEFAULT 'deepseek-v4-flash',temperature double precision NOT NULL DEFAULT .95,max_tokens integer NOT NULL DEFAULT 1800,context_messages integer NOT NULL DEFAULT 30,consolidation_interval integer NOT NULL DEFAULT 10,memory_limit integer NOT NULL DEFAULT 8,updated_at timestamptz NOT NULL DEFAULT now());
    `);
    setPoolForTesting(oldPool); await expect(ensureSchema()).resolves.toBeUndefined();
    const columns = await query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_name='memories'");
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(["status","source_message_count","recall_count"]));
    const tables = await query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    expect(tables.rows.map((row) => row.table_name)).toContain("memory_arcs");
  });

  it("creates every durable application table and defaults without ownerless user data", async () => {
    const tables = await query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(["characters","conversations","messages","memories","memory_arcs","usage_events","app_settings","personas","worlds","character_worlds","user_provider_credentials"]));
    const settings = await getDefaultSettings();
    expect(settings.model).toMatch(/^deepseek-/);
    expect(settings.providerId).toBe("deepseek");
    expect(settings.roleplayPreset).toBe("immersive");
    expect(settings.memoryLimit).toBe(8);
    expect(settings.contextTokenBudget).toBe(12000);
    expect(settings.memoryTokenBudget).toBe(6000);
    // Personas belong to authenticated accounts; schema startup must never
    // recreate the obsolete installation-wide persona without a user_id.
    expect(Number((await query("SELECT COUNT(*) count FROM personas")).rows[0].count)).toBe(0);
  });

  it("reuses worlds across characters and isolates persona instructions by conversation", async () => {
    const firstCharacter = crypto.randomUUID(); const secondCharacter = crypto.randomUUID(); const worldId = crypto.randomUUID(); const personaId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara'),($2,'Iris')",[firstCharacter,secondCharacter]);
    await query("INSERT INTO worlds (id,name,content) VALUES ($1,'Shared city','Paris canon')",[worldId]);
    await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$3),($2,$3)",[firstCharacter,secondCharacter,worldId]);
    await query("INSERT INTO personas (id,name,description) VALUES ($1,'Alex','A private detective')",[personaId]);
    await query("INSERT INTO conversations (id,character_id,title,persona_id,instruction_presets,custom_instructions) VALUES ($1,$2,'Case',$3,$4,'Use clipped dialogue')",[conversationId,firstCharacter,personaId,["stay_focused"]]);
    expect(Number((await query("SELECT COUNT(*) count FROM character_worlds WHERE world_id=$1",[worldId])).rows[0].count)).toBe(2);
    const conversation = await query<{persona_id:string;instruction_presets:string[];custom_instructions:string}>("SELECT persona_id,instruction_presets,custom_instructions FROM conversations WHERE id=$1",[conversationId]);
    expect(String(conversation.rows[0].persona_id)).toBe(personaId);
    expect(conversation.rows[0].instruction_presets).toEqual(["stay_focused"]);
    expect(conversation.rows[0].custom_instructions).toBe("Use clipped dialogue");
  });

  it("persists a conversation writer independently from continuity", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title,provider_id,model_id,rp_engine_id,summary) VALUES ($1,$2,'Writer switch','deepseek','deepseek-v4-pro','cinematic','Existing continuity')",[conversationId,characterId]);
    await query("UPDATE conversations SET model_id='deepseek-v4-flash',rp_engine_id='raw' WHERE id=$1",[conversationId]);
    const result = await query<Record<string,unknown>>("SELECT * FROM conversations WHERE id=$1",[conversationId]);
    expect(result.rows[0].summary).toBe("Existing continuity");
    expect(result.rows[0].model_id).toBe("deepseek-v4-flash");
    expect(result.rows[0].rp_engine_id).toBe("raw");
  });

  it("persists a complete character conversation with cascading cleanup", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Paris rain')",[conversationId,characterId]);
    await query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Hello')",[crypto.randomUUID(),conversationId]);
    await query("INSERT INTO memories (id,character_id,conversation_id,content) VALUES ($1,$2,$3,'They met in Paris.')",[crypto.randomUUID(),characterId,conversationId]);
    expect(Number((await query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1",[conversationId])).rows[0].count)).toBe(1);
    await query("DELETE FROM characters WHERE id=$1",[characterId]);
    expect(Number((await query("SELECT COUNT(*) count FROM conversations WHERE id=$1",[conversationId])).rows[0].count)).toBe(0);
    expect(Number((await query("SELECT COUNT(*) count FROM memories WHERE character_id=$1",[characterId])).rows[0].count)).toBe(0);
  });

  it("commits multi-step writes through one pooled transaction", async () => {
    const characterId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    await transaction(async (client) => {
      await client.query("INSERT INTO characters (id,name) VALUES ($1,'Transactional')",[characterId]);
      await client.query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Atomic story')",[conversationId,characterId]);
    });
    expect(Number((await query("SELECT COUNT(*) count FROM conversations WHERE id=$1",[conversationId])).rows[0].count)).toBe(1);
  });

  it("loads conversation and character rows for chat context", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name,backstory) VALUES ($1,'Mara','A careful archivist.')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Archive')",[conversationId,characterId]);
    const conversation = await query<Record<string, unknown>>("SELECT * FROM conversations WHERE id=$1",[conversationId]);
    const loadedCharacter = await query<Record<string, unknown>>("SELECT * FROM characters WHERE id=$1",[conversation.rows[0].character_id]);
    expect(loadedCharacter.rows[0].name).toBe("Mara");
  });

  it("persists selectable assistant response variants", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID(); const messageId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Versions')",[conversationId,characterId]);
    await query(
      "INSERT INTO messages (id,conversation_id,role,content,variants,selected_variant) VALUES ($1,$2,'assistant','Second',$3::jsonb,1)",
      [messageId,conversationId,JSON.stringify(["First","Second"])],
    );
    const result = await query("SELECT * FROM messages WHERE id=$1",[messageId]);
    const message = messageFromRow(result.rows[0]);
    expect(message.variants).toEqual(["First","Second"]);
    expect(message.selectedVariant).toBe(1);
    expect(message.content).toBe("Second");
    expect(message.memoryIds).toEqual([]);
    expect(message.arcIds).toEqual([]);
  });

  it("truncates after an edited message without deleting the edited message itself", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    const userId = crypto.randomUUID(); const assistantId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Edit test')",[conversationId,characterId]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'user','Before',$3)",[userId,conversationId,"2026-08-17T10:42:00.123456Z"]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'assistant','Later',$3)",[assistantId,conversationId,"2026-08-17T10:42:01.123456Z"]);
    await transaction(async (client) => {
      await client.query(
        `DELETE FROM messages WHERE conversation_id=$1 AND (
          created_at > $2::timestamptz
          OR (created_at = $2::timestamptz AND id::text > $3::text)
        )`,
        [conversationId,"2026-08-17T10:42:00.123456Z",userId],
      );
      const updated = await client.query("UPDATE messages SET content='After' WHERE id=$1 RETURNING *",[userId]);
      expect(updated.rowCount).toBe(1);
    });
    const remaining = await query<{ id: string; content: string }>("SELECT id,content FROM messages WHERE conversation_id=$1",[conversationId]);
    expect(remaining.rows).toEqual([{ id:userId, content:"After" }]);
  });

  it("deletes the selected message and every later message", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    const firstId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const laterId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title,message_count) VALUES ($1,$2,'Delete test',3)",[conversationId,characterId]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'assistant','Keep',$3)",[firstId,conversationId,"2026-08-17T10:42:00.000000Z"]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'user','Delete',$3)",[targetId,conversationId,"2026-08-17T10:42:01.123456Z"]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'assistant','Also delete',$3)",[laterId,conversationId,"2026-08-17T10:42:02.000000Z"]);
    await transaction(async (client) => {
      await client.query(
        `DELETE FROM messages WHERE conversation_id=$1 AND (
          created_at > $2::timestamptz
          OR (created_at = $2::timestamptz AND id::text >= $3::text)
        )`,
        [conversationId,"2026-08-17T10:42:01.123456Z",targetId],
      );
      await client.query("UPDATE conversations SET message_count=(SELECT COUNT(*) FROM messages WHERE conversation_id=$1) WHERE id=$1",[conversationId]);
    });
    const remaining = await query<{ id:string }>("SELECT id FROM messages WHERE conversation_id=$1",[conversationId]);
    const conversation = await query<{ message_count:number }>("SELECT message_count FROM conversations WHERE id=$1",[conversationId]);
    expect(remaining.rows).toEqual([{ id:firstId }]);
    expect(Number(conversation.rows[0].message_count)).toBe(1);
  });

  it("never recalls generated memories from another chat with the same character", async () => {
    const characterId = crypto.randomUUID();
    const firstChatId = crypto.randomUUID();
    const secondChatId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'First')",[firstChatId,characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Second')",[secondChatId,characterId]);
    await query(
      "INSERT INTO memories (id,character_id,conversation_id,content,importance,keywords) VALUES ($1,$2,$3,'They had their first dinner at the rooftop restaurant.',5,$4)",
      [crypto.randomUUID(),characterId,firstChatId,["restaurant"]],
    );
    await query(
      "INSERT INTO memories (id,character_id,conversation_id,user_id,content,importance,keywords) VALUES ($1,$2,$3,$5,'This story began at the train station.',5,$4)",
      [crypto.randomUUID(),characterId,secondChatId,["station"],ownerId],
    );
    await query(
      "INSERT INTO memories (id,character_id,conversation_id,user_id,content,importance,keywords) VALUES ($1,$2,NULL,$4,'Mara always drinks black coffee.',5,$3)",
      [crypto.randomUUID(),characterId,["coffee"],ownerId],
    );

    const recalled = await transaction((client) => relevantMemories(client,ownerId,characterId,secondChatId,"restaurant station coffee",8));
    expect(recalled.map((memory) => memory.content)).toEqual(expect.arrayContaining([
      "This story began at the train station.",
      "Mara always drinks black coffee.",
    ]));
    expect(recalled.map((memory) => memory.content)).not.toContain("They had their first dinner at the rooftop restaurant.");
  });

  it("retrieves a relevant event even after more than 300 newer memories", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Long story')",[conversationId,characterId]);
    await query(
      "INSERT INTO memories (id,character_id,conversation_id,user_id,content,importance,keywords,created_at) VALUES ($1,$2,$3,$6,'They hid the obsidian locket beneath the pier.',5,$4,$5)",
      [crypto.randomUUID(),characterId,conversationId,["obsidian locket"],"2020-01-01T00:00:00Z",ownerId],
    );
    for (let index = 0; index < 305; index += 1) await query(
      "INSERT INTO memories (id,character_id,conversation_id,user_id,content,importance,created_at) VALUES ($1,$2,$3,$6,$4,1,$5)",
      [crypto.randomUUID(),characterId,conversationId,`Routine detail ${index}`,new Date(Date.UTC(2026,0,1,index)).toISOString(),ownerId],
    );
    const recalled = await transaction((client) => relevantMemories(client,ownerId,characterId,conversationId,"Where is the obsidian locket?",8,2000));
    expect(recalled.map((memory) => memory.content)).toContain("They hid the obsidian locket beneath the pier.");
  });

  it("invalidates only derived continuity beyond an edited timeline position", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title,summary,last_consolidated_count) VALUES ($1,$2,'Branch','Stale future',4)",[conversationId,characterId]);
    for (const content of ["One","Two"]) await query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user',$3)",[crypto.randomUUID(),conversationId,content]);
    const keepId = crypto.randomUUID(); const removeId = crypto.randomUUID();
    await query("INSERT INTO memories (id,character_id,conversation_id,content,source_message_count) VALUES ($1,$2,$3,'Keep',2)",[keepId,characterId,conversationId]);
    await query("INSERT INTO memories (id,character_id,conversation_id,content,source_message_count) VALUES ($1,$2,$3,'Ghost future',4)",[removeId,characterId,conversationId]);
    await query("INSERT INTO memory_arcs (id,conversation_id,summary,end_message_count) VALUES ($1,$2,'Ghost chapter',4)",[crypto.randomUUID(),conversationId]);
    await transaction((client) => invalidateDerivedContinuity(client,conversationId,2));
    expect((await query<{id:string}>("SELECT id FROM memories WHERE conversation_id=$1 ORDER BY id",[conversationId])).rows.map((row) => row.id)).toEqual([keepId]);
    expect(Number((await query("SELECT COUNT(*) count FROM memory_arcs WHERE conversation_id=$1",[conversationId])).rows[0].count)).toBe(0);
    const conversation = (await query<{summary:string;message_count:number}>("SELECT summary,message_count FROM conversations WHERE id=$1",[conversationId])).rows[0];
    expect(conversation.summary).toBe(""); expect(Number(conversation.message_count)).toBe(2);
  });

  it("recovers a persisted message by conversation position when its browser ID is stale", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    const firstId = crypto.randomUUID(); const secondId = crypto.randomUUID();
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Identity sync')",[conversationId,characterId]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'assistant','First','2026-01-01T00:00:00Z')",[firstId,conversationId]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'user','Second','2026-01-01T00:00:01Z')",[secondId,conversationId]);

    const recovered = await transaction((client) => lockMessageForMutation(client,crypto.randomUUID(),{ conversationId,messagePosition:2 }));
    expect(String(recovered?.id)).toBe(secondId);
  });

  it("truncates by stable position without deleting the edited message", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    const ids = [crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Truncate safely')",[conversationId,characterId]);
    for (let index = 0; index < ids.length; index += 1) await query(
      "INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'assistant',$3,$4)",
      [ids[index],conversationId,`Message ${index + 1}`,new Date(Date.UTC(2026,0,1,0,0,index)).toISOString()],
    );

    await transaction((client) => truncateMessagesAfterPosition(client,conversationId,2));
    expect((await query<{id:string}>("SELECT id FROM messages WHERE conversation_id=$1 ORDER BY created_at,id",[conversationId])).rows.map((row) => row.id)).toEqual(ids.slice(0,2));
    await transaction((client) => deleteMessagesFromPosition(client,conversationId,2));
    expect((await query<{id:string}>("SELECT id FROM messages WHERE conversation_id=$1 ORDER BY created_at,id",[conversationId])).rows.map((row) => row.id)).toEqual(ids.slice(0,1));
  });

  it("calculates message position entirely from persisted timestamps", async () => {
    const characterId = crypto.randomUUID(); const conversationId = crypto.randomUUID();
    // Fixed, ascending ids rather than random ones. The two rows differ only
    // below the millisecond, which the in-memory database truncates away, so a
    // random pair would leave the id tiebreak to decide the order and the
    // assertion would pass or fail by chance.
    const ids = ["aaaaaaaa-0000-4000-8000-000000000001","bbbbbbbb-0000-4000-8000-000000000002"];
    await query("INSERT INTO characters (id,name) VALUES ($1,'Mara')",[characterId]);
    await query("INSERT INTO conversations (id,character_id,title) VALUES ($1,$2,'Precise position')",[conversationId,characterId]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'assistant','First','2026-01-01T00:00:00.123456Z')",[ids[0],conversationId]);
    await query("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ($1,$2,'user','Second','2026-01-01T00:00:00.123789Z')",[ids[1],conversationId]);
    expect(await transaction((client) => persistedMessagePosition(client,conversationId,ids[0]))).toBe(1);
    expect(await transaction((client) => persistedMessagePosition(client,conversationId,ids[1]))).toBe(2);
  });
});
