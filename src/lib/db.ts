import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AppSettings, Character, Conversation, Memory, Message } from "./types";

const globalForDb = globalThis as unknown as { afterglowPool?: Pool; afterglowSchemaPromise?: Promise<void> };

export function pool() {
  if (!globalForDb.afterglowPool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
    globalForDb.afterglowPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    });
  }
  return globalForDb.afterglowPool;
}

async function schema() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS characters (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      tagline text NOT NULL DEFAULT '',
      avatar_url text NOT NULL DEFAULT '',
      accent text NOT NULL DEFAULT '#e879a9',
      backstory text NOT NULL DEFAULT '',
      personality text NOT NULL DEFAULT '',
      scenario text NOT NULL DEFAULT '',
      greeting text NOT NULL DEFAULT '',
      example_dialogue text NOT NULL DEFAULT '',
      response_directive text NOT NULL DEFAULT '',
      boundaries text NOT NULL DEFAULT '',
      nsfw_enabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id uuid PRIMARY KEY,
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title text NOT NULL DEFAULT 'New conversation',
      summary text NOT NULL DEFAULT '',
      message_count integer NOT NULL DEFAULT 0,
      last_consolidated_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      content text NOT NULL,
      variants jsonb NOT NULL DEFAULT '[]'::jsonb,
      selected_variant integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_time_idx ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS memories (
      id uuid PRIMARY KEY,
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
      content text NOT NULL,
      importance smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
      keywords text[] NOT NULL DEFAULT '{}',
      pinned boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memories_character_idx ON memories(character_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS usage_events (
      id uuid PRIMARY KEY,
      conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
      model text NOT NULL,
      prompt_tokens integer NOT NULL DEFAULT 0,
      completion_tokens integer NOT NULL DEFAULT 0,
      cache_hit_tokens integer NOT NULL DEFAULT 0,
      cache_miss_tokens integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS app_settings (
      id text PRIMARY KEY,
      owner_name text NOT NULL DEFAULT 'You',
      owner_profile text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT 'deepseek-v4-flash',
      temperature double precision NOT NULL DEFAULT 0.95,
      max_tokens integer NOT NULL DEFAULT 1800,
      context_messages integer NOT NULL DEFAULT 30,
      consolidation_interval integer NOT NULL DEFAULT 10,
      memory_limit integer NOT NULL DEFAULT 8,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS selected_variant integer NOT NULL DEFAULT 0");
  await pool().query(
    "INSERT INTO app_settings (id, owner_name, owner_profile, model) VALUES ('owner',$1,$2,$3) ON CONFLICT (id) DO NOTHING",
    [process.env.OWNER_NAME || "You", process.env.OWNER_PROFILE || "", process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"],
  );
}

export async function ensureSchema() {
  globalForDb.afterglowSchemaPromise ??= schema();
  return globalForDb.afterglowSchemaPromise;
}

export function setPoolForTesting(value: Pool) {
  if (process.env.NODE_ENV !== "test") throw new Error("Database pool injection is test-only");
  globalForDb.afterglowPool = value;
  globalForDb.afterglowSchemaPromise = undefined;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  await ensureSchema();
  return pool().query<T>(text, values);
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function characterFromRow(row: Record<string, unknown>): Character {
  return {
    id: String(row.id), name: String(row.name), tagline: String(row.tagline),
    avatarUrl: String(row.avatar_url), accent: String(row.accent), backstory: String(row.backstory),
    personality: String(row.personality), scenario: String(row.scenario), greeting: String(row.greeting),
    exampleDialogue: String(row.example_dialogue), responseDirective: String(row.response_directive),
    boundaries: String(row.boundaries), nsfwEnabled: Boolean(row.nsfw_enabled),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function conversationFromRow(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id), characterId: String(row.character_id), title: String(row.title),
    summary: String(row.summary), messageCount: Number(row.message_count),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function messageFromRow(row: Record<string, unknown>): Message {
  const content = String(row.content);
  const role = row.role as Message["role"];
  const stored = Array.isArray(row.variants) ? row.variants.filter((item): item is string => typeof item === "string") : [];
  const variants = role === "assistant" ? (stored.length ? stored : [content]) : [];
  const requested = Number(row.selected_variant ?? 0);
  const selectedVariant = variants.length ? Math.min(Math.max(Number.isInteger(requested) ? requested : 0, 0), variants.length - 1) : 0;
  return { id: String(row.id), conversationId: String(row.conversation_id), role, content, variants, selectedVariant, createdAt: new Date(String(row.created_at)).toISOString() };
}

export function memoryFromRow(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id), characterId: String(row.character_id), conversationId: row.conversation_id ? String(row.conversation_id) : null,
    content: String(row.content), importance: Number(row.importance), keywords: (row.keywords as string[]) ?? [],
    pinned: Boolean(row.pinned), createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function settingsFromRow(row: Record<string, unknown>): AppSettings {
  return {
    ownerName: String(row.owner_name), ownerProfile: String(row.owner_profile), model: String(row.model),
    temperature: Number(row.temperature), maxTokens: Number(row.max_tokens), contextMessages: Number(row.context_messages),
    consolidationInterval: Number(row.consolidation_interval), memoryLimit: Number(row.memory_limit),
  };
}

export async function getSettings() {
  const result = await query("SELECT * FROM app_settings WHERE id='owner'");
  return settingsFromRow(result.rows[0]);
}
