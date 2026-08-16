import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureSchema, getSettings, query, setPoolForTesting, transaction } from "@/lib/db";

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
});
