import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AppSettings, Character, Conversation, Memory, MemoryArc, Message } from "./types";

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
      profile_type text NOT NULL DEFAULT 'single',
      tagline text NOT NULL DEFAULT '',
      avatar_url text NOT NULL DEFAULT '',
      accent text NOT NULL DEFAULT '#e879a9',
      backstory text NOT NULL DEFAULT '',
      cast_members jsonb NOT NULL DEFAULT '[]'::jsonb,
      lorebook text NOT NULL DEFAULT '',
      personality text NOT NULL DEFAULT '',
      scenario text NOT NULL DEFAULT '',
      greeting text NOT NULL DEFAULT '',
      alternate_greetings jsonb NOT NULL DEFAULT '[]'::jsonb,
      example_dialogue text NOT NULL DEFAULT '',
      response_directive text NOT NULL DEFAULT '',
      boundaries text NOT NULL DEFAULT '',
      source_material text NOT NULL DEFAULT '',
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
      memory_ids uuid[] NOT NULL DEFAULT '{}',
      memory_arc_ids uuid[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_time_idx ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS memories (
      id uuid PRIMARY KEY,
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
      content text NOT NULL,
      kind text NOT NULL DEFAULT 'event',
      importance smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
      keywords text[] NOT NULL DEFAULT '{}',
      pinned boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'active',
      resolution text NOT NULL DEFAULT '',
      resolved_at timestamptz,
      last_recalled_at timestamptz,
      recall_count integer NOT NULL DEFAULT 0,
      source_message_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memories_character_idx ON memories(character_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS memory_arcs (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      summary text NOT NULL,
      keywords text[] NOT NULL DEFAULT '{}',
      start_message_count integer NOT NULL DEFAULT 0,
      end_message_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memory_arcs_conversation_idx ON memory_arcs(conversation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS usage_events (
      id uuid PRIMARY KEY,
      conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
      model text NOT NULL,
      usage_type text NOT NULL DEFAULT 'chat',
      prompt_tokens integer NOT NULL DEFAULT 0,
      completion_tokens integer NOT NULL DEFAULT 0,
      cache_hit_tokens integer NOT NULL DEFAULT 0,
      cache_miss_tokens integer NOT NULL DEFAULT 0,
      estimated_cost_usd numeric(20,10),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS app_settings (
      id text PRIMARY KEY,
      owner_name text NOT NULL DEFAULT 'You',
      owner_profile text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT 'deepseek-v4-flash',
      roleplay_preset text NOT NULL DEFAULT 'immersive',
      temperature double precision NOT NULL DEFAULT 0.95,
      max_tokens integer NOT NULL DEFAULT 1800,
      context_messages integer NOT NULL DEFAULT 30,
      context_token_budget integer NOT NULL DEFAULT 12000,
      consolidation_interval integer NOT NULL DEFAULT 10,
      memory_limit integer NOT NULL DEFAULT 8,
      memory_token_budget integer NOT NULL DEFAULT 6000,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS profile_type text NOT NULL DEFAULT 'single'");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS cast_members jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS lorebook text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS alternate_greetings jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS source_material text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS selected_variant integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS memory_ids uuid[] NOT NULL DEFAULT '{}'");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS memory_arc_ids uuid[] NOT NULL DEFAULT '{}'");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'event'");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS resolution text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS resolved_at timestamptz");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_recalled_at timestamptz");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS recall_count integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_message_count integer NOT NULL DEFAULT 0");
  await pool().query("CREATE INDEX IF NOT EXISTS memories_conversation_status_idx ON memories(conversation_id, status, kind)");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS usage_type text NOT NULL DEFAULT 'chat'");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(20,10)");
  await pool().query(`
    UPDATE usage_events SET estimated_cost_usd = CASE model
      WHEN 'deepseek-v4-flash' THEN (
        cache_hit_tokens * 0.0028
        + (CASE WHEN cache_hit_tokens + cache_miss_tokens = 0 THEN prompt_tokens ELSE cache_miss_tokens END) * 0.14
        + completion_tokens * 0.28
      ) / 1000000
      WHEN 'deepseek-v4-pro' THEN (
        cache_hit_tokens * 0.003625
        + (CASE WHEN cache_hit_tokens + cache_miss_tokens = 0 THEN prompt_tokens ELSE cache_miss_tokens END) * 0.435
        + completion_tokens * 0.87
      ) / 1000000
      ELSE NULL END
    WHERE estimated_cost_usd IS NULL
  `);
  await pool().query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS roleplay_preset text NOT NULL DEFAULT 'immersive'");
  await pool().query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS context_token_budget integer NOT NULL DEFAULT 12000");
  await pool().query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS memory_token_budget integer NOT NULL DEFAULT 6000");
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
  const cast = Array.isArray(row.cast_members) ? row.cast_members.filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === "object").map((member) => ({
    name: String(member.name || ""), role: String(member.role || ""), description: String(member.description || ""),
  })).filter((member) => member.name) : [];
  const alternateGreetings = Array.isArray(row.alternate_greetings) ? row.alternate_greetings.filter((item): item is string => typeof item === "string") : [];
  return {
    id: String(row.id), name: String(row.name), profileType: row.profile_type === "ensemble" ? "ensemble" : "single", tagline: String(row.tagline),
    avatarUrl: String(row.avatar_url), accent: String(row.accent), backstory: String(row.backstory),
    cast, lorebook: String(row.lorebook || ""), personality: String(row.personality), scenario: String(row.scenario), greeting: String(row.greeting), alternateGreetings,
    exampleDialogue: String(row.example_dialogue), responseDirective: String(row.response_directive),
    boundaries: String(row.boundaries), sourceMaterial: String(row.source_material || ""), nsfwEnabled: Boolean(row.nsfw_enabled),
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
  return { id: String(row.id), conversationId: String(row.conversation_id), role, content, variants, selectedVariant,
    memoryIds: textArrayFromRow(row.memory_ids), arcIds: textArrayFromRow(row.memory_arc_ids), createdAt: new Date(String(row.created_at)).toISOString() };
}

function textArrayFromRow(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value === "{}") return [];
  return value.replace(/^\{|\}$/g, "").split(",").map((item) => item.replace(/^"|"$/g, "").trim()).filter(Boolean);
}

export function memoryFromRow(row: Record<string, unknown>): Memory {
  const storedStatus = String(row.status || "active");
  return {
    id: String(row.id), characterId: String(row.character_id), conversationId: row.conversation_id ? String(row.conversation_id) : null,
    content: String(row.content), kind: (["identity","relationship","event","promise","preference","boundary","open_loop"].includes(String(row.kind)) ? String(row.kind) : "event") as Memory["kind"], importance: Number(row.importance), keywords: textArrayFromRow(row.keywords),
    pinned: Boolean(row.pinned), status: (["active","resolved","superseded"].includes(storedStatus) ? storedStatus : "active") as Memory["status"],
    resolution: String(row.resolution || ""), resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)).toISOString() : null,
    lastRecalledAt: row.last_recalled_at ? new Date(String(row.last_recalled_at)).toISOString() : null,
    recallCount: Number(row.recall_count || 0), sourceMessageCount: Number(row.source_message_count || 0), createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function memoryArcFromRow(row: Record<string, unknown>): MemoryArc {
  return {
    id: String(row.id), conversationId: String(row.conversation_id), summary: String(row.summary),
    keywords: textArrayFromRow(row.keywords), startMessageCount: Number(row.start_message_count),
    endMessageCount: Number(row.end_message_count), createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function settingsFromRow(row: Record<string, unknown>): AppSettings {
  const storedPreset = String(row.roleplay_preset || "immersive");
  const roleplayPreset: AppSettings["roleplayPreset"] = ["immersive","raw","cinematic","deliberate"].includes(storedPreset)
    ? storedPreset as AppSettings["roleplayPreset"] : "immersive";
  return {
    ownerName: String(row.owner_name), ownerProfile: String(row.owner_profile), model: String(row.model),
    roleplayPreset,
    temperature: Number(row.temperature), maxTokens: Number(row.max_tokens), contextMessages: Number(row.context_messages), contextTokenBudget: Number(row.context_token_budget || 12000),
    consolidationInterval: Number(row.consolidation_interval), memoryLimit: Number(row.memory_limit), memoryTokenBudget: Number(row.memory_token_budget || 6000),
  };
}

export async function getSettings() {
  const result = await query("SELECT * FROM app_settings WHERE id='owner'");
  return settingsFromRow(result.rows[0]);
}
