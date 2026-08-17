import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureSchema, getSettings, messageFromRow, query, setPoolForTesting, transaction } from "@/lib/db";

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
});

describe("PostgreSQL persistence", () => {
  it("creates every durable application table and default settings", async () => {
    const tables = await query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(["characters","conversations","messages","memories","usage_events","app_settings"]));
    const settings = await getSettings();
    expect(settings.model).toMatch(/^deepseek-/);
    expect(settings.roleplayPreset).toBe("immersive");
    expect(settings.memoryLimit).toBe(8);
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
          created_at > (SELECT created_at FROM messages WHERE id=$2)
          OR (created_at = (SELECT created_at FROM messages WHERE id=$2) AND id::text > $2)
        )`,
        [conversationId,userId],
      );
      const updated = await client.query("UPDATE messages SET content='After' WHERE id=$1 RETURNING *",[userId]);
      expect(updated.rowCount).toBe(1);
    });
    const remaining = await query<{ id: string; content: string }>("SELECT id,content FROM messages WHERE conversation_id=$1",[conversationId]);
    expect(remaining.rows).toEqual([{ id:userId, content:"After" }]);
  });
});
