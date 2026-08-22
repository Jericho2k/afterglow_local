import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { responseLengths, roleplayEngineIds, type AppSettings, type Character, type ChatInstructionPreset, type Conversation, type CoreCanonEntry, type Memory, type MemoryArc, type Message, type Persona, type World } from "./types";

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
      like_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id uuid PRIMARY KEY,
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title text NOT NULL DEFAULT 'New conversation',
      summary text NOT NULL DEFAULT '',
      persona_id uuid,
      provider_id text NOT NULL DEFAULT 'deepseek',
      model_id text NOT NULL DEFAULT 'deepseek-v4-flash',
      rp_engine_id text NOT NULL DEFAULT 'immersive',
      instruction_presets text[] NOT NULL DEFAULT '{}',
      custom_instructions text NOT NULL DEFAULT '',
      response_length text,
      temperature double precision,
      branch_request_id uuid,
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
    CREATE TABLE IF NOT EXISTS core_canon_entries (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      content text NOT NULL,
      category text NOT NULL DEFAULT 'event',
      importance smallint NOT NULL DEFAULT 4 CHECK (importance BETWEEN 1 AND 5),
      status text NOT NULL DEFAULT 'active',
      source_memory_ids uuid[] NOT NULL DEFAULT '{}',
      source_arc_ids uuid[] NOT NULL DEFAULT '{}',
      source_message_count integer NOT NULL DEFAULT 0,
      token_count integer NOT NULL DEFAULT 0,
      curation_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS core_canon_conversation_idx ON core_canon_entries(conversation_id,status,importance DESC);
    CREATE TABLE IF NOT EXISTS memory_retrieval_runs (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id uuid,
      retrieval_version text NOT NULL DEFAULT 'v2',
      semantic_available boolean NOT NULL DEFAULT false,
      fallback_reason text NOT NULL DEFAULT '',
      total_stored_memories integer NOT NULL DEFAULT 0,
      core_canon_tokens integer NOT NULL DEFAULT 0,
      retrieved_episodic_tokens integer NOT NULL DEFAULT 0,
      arc_tokens integer NOT NULL DEFAULT 0,
      recalled_memory_ids uuid[] NOT NULL DEFAULT '{}',
      recalled_arc_ids uuid[] NOT NULL DEFAULT '{}',
      score_details jsonb NOT NULL DEFAULT '[]'::jsonb,
      latency_ms integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memory_retrieval_runs_conversation_idx ON memory_retrieval_runs(conversation_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS memory_job_leases (
      conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      job_type text NOT NULL,
      lease_token uuid NOT NULL,
      locked_until timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id uuid PRIMARY KEY,
      conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
      model text NOT NULL,
      provider_id text NOT NULL DEFAULT 'deepseek',
      rp_engine_id text NOT NULL DEFAULT 'immersive',
      funding_source text NOT NULL DEFAULT 'afterglow',
      usage_type text NOT NULL DEFAULT 'chat',
      prompt_tokens integer NOT NULL DEFAULT 0,
      completion_tokens integer NOT NULL DEFAULT 0,
      cache_hit_tokens integer NOT NULL DEFAULT 0,
      cache_miss_tokens integer NOT NULL DEFAULT 0,
      cache_write_tokens integer NOT NULL DEFAULT 0,
      reasoning_tokens integer NOT NULL DEFAULT 0,
      estimated_cost_usd numeric(20,10),
      provider_cost_usd numeric(20,10),
      upstream_cost_usd numeric(20,10),
      actual_provider_model text,
      catalog_model_id text,
      task_route text,
      latency_ms integer,
      provider_request_id text,
      provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      response_length text,
      ttft_ms integer,
      upstream_provider text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS app_settings (
      id text PRIMARY KEY,
      owner_name text NOT NULL DEFAULT 'You',
      owner_profile text NOT NULL DEFAULT '',
      provider_id text NOT NULL DEFAULT 'deepseek',
      model text NOT NULL DEFAULT 'deepseek-v4-flash',
      roleplay_preset text NOT NULL DEFAULT 'immersive',
      response_length text NOT NULL DEFAULT 'natural',
      temperature double precision NOT NULL DEFAULT 0.95,
      max_tokens integer NOT NULL DEFAULT 1800,
      context_messages integer NOT NULL DEFAULT 30,
      context_token_budget integer NOT NULL DEFAULT 12000,
      consolidation_interval integer NOT NULL DEFAULT 10,
      memory_limit integer NOT NULL DEFAULT 8,
      memory_token_budget integer NOT NULL DEFAULT 6000,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS personas (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      avatar_url text NOT NULL DEFAULT '',
      accent text NOT NULL DEFAULT '#e879a9',
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS personas_single_default_idx ON personas (is_default) WHERE is_default;
    CREATE TABLE IF NOT EXISTS worlds (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS character_worlds (
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      PRIMARY KEY (character_id, world_id)
    );
    CREATE TABLE IF NOT EXISTS character_likes (
      user_id uuid NOT NULL,
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS character_reports (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
      reason text NOT NULL,
      details text NOT NULL DEFAULT '',
      character_name text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS profile_type text NOT NULL DEFAULT 'single'");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS cast_members jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS lorebook text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS alternate_greetings jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS source_material text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS like_count integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS persona_id uuid REFERENCES personas(id) ON DELETE SET NULL");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek'");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model_id text NOT NULL DEFAULT 'deepseek-v4-flash'");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS rp_engine_id text NOT NULL DEFAULT 'immersive'");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS instruction_presets text[] NOT NULL DEFAULT '{}'");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS custom_instructions text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS response_length text");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS temperature double precision");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS branch_request_id uuid");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_curated_message_count integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS canon_version integer NOT NULL DEFAULT 0");
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
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek'");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS rp_engine_id text NOT NULL DEFAULT 'immersive'");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS funding_source text NOT NULL DEFAULT 'afterglow'");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(20,10)");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cache_write_tokens integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS reasoning_tokens integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_cost_usd numeric(20,10)");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS upstream_cost_usd numeric(20,10)");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS actual_provider_model text");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS catalog_model_id text");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS task_route text");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS latency_ms integer");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_request_id text");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS response_length text");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS ttft_ms integer");
  await pool().query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS upstream_provider text");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS authored_event_id uuid");
  await pool().query("UPDATE messages SET authored_event_id=id WHERE role='user' AND authored_event_id IS NULL");
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
  await pool().query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek'");
  await pool().query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS context_token_budget integer NOT NULL DEFAULT 12000");
  await pool().query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS memory_token_budget integer NOT NULL DEFAULT 6000");
  await pool().query("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS response_length text NOT NULL DEFAULT 'natural'");
  await pool().query(
    "INSERT INTO app_settings (id, owner_name, owner_profile, model) VALUES ('owner',$1,$2,$3) ON CONFLICT (id) DO NOTHING",
    [process.env.OWNER_NAME || "You", process.env.OWNER_PROFILE || "", process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"],
  );
  // Do not seed the old installation-wide persona here. Personas are now
  // account-owned resources and production correctly requires user_id. An
  // ownerless INSERT fails before ON CONFLICT can discard the fixed legacy id,
  // which used to make every cold start fail once the multi-tenant migration
  // had made personas.user_id NOT NULL. Existing legacy rows are assigned to
  // their owner by scripts/migrate-legacy-owner.mjs; new personas are created
  // only through the authenticated API.
  // Multi-tenant columns.
  //
  // supabase/migrations is authoritative for a deployed database: it adds the
  // same columns plus the auth.users foreign keys, row level security and
  // policies. This block keeps a plain PostgreSQL (and the in-memory test
  // database, which supports neither roles nor RLS) on the identical column
  // set so the application's SQL is the same everywhere.
  for (const table of ["characters","worlds","personas","conversations","messages","memories","memory_arcs","core_canon_entries","memory_retrieval_runs","memory_job_leases","usage_events"]) {
    await pool().query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS user_id uuid`);
  }
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS avatar_path text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS published_at timestamptz");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS origin_character_id uuid");
  await pool().query("ALTER TABLE worlds ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'");
  await pool().query("ALTER TABLE personas ADD COLUMN IF NOT EXISTS avatar_path text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS character_snapshot jsonb");
  await pool().query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id uuid PRIMARY KEY,
      username text UNIQUE,
      display_name text NOT NULL DEFAULT '',
      avatar_path text NOT NULL DEFAULT '',
      bio text NOT NULL DEFAULT '',
      plan text NOT NULL DEFAULT 'free',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id uuid PRIMARY KEY,
      owner_name text NOT NULL DEFAULT 'You',
      owner_profile text NOT NULL DEFAULT '',
      provider_id text NOT NULL DEFAULT 'deepseek',
      model text NOT NULL DEFAULT 'deepseek-v4-flash',
      roleplay_preset text NOT NULL DEFAULT 'immersive',
      response_length text NOT NULL DEFAULT 'natural',
      temperature double precision NOT NULL DEFAULT 0.95,
      max_tokens integer NOT NULL DEFAULT 1800,
      context_messages integer NOT NULL DEFAULT 30,
      context_token_budget integer NOT NULL DEFAULT 12000,
      consolidation_interval integer NOT NULL DEFAULT 10,
      memory_limit integer NOT NULL DEFAULT 8,
      memory_token_budget integer NOT NULL DEFAULT 6000,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool().query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek'");
  await pool().query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS response_length text NOT NULL DEFAULT 'natural'");
  // One default persona per account rather than per installation.
  await pool().query("DROP INDEX IF EXISTS personas_single_default_idx");
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS personas_user_default_idx ON personas (user_id) WHERE is_default");
  await pool().query("CREATE INDEX IF NOT EXISTS characters_user_idx ON characters (user_id, updated_at DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, updated_at DESC)");
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS conversations_branch_request_idx ON conversations (user_id,branch_request_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id, character_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS usage_events_user_idx ON usage_events (user_id, created_at DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS core_canon_user_idx ON core_canon_entries (user_id, conversation_id, status)");
  await pool().query("CREATE INDEX IF NOT EXISTS memory_retrieval_runs_user_idx ON memory_retrieval_runs (user_id, conversation_id, created_at DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS character_likes_user_idx ON character_likes (user_id, created_at DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS character_reports_user_idx ON character_reports (user_id, created_at DESC)");

  const legacyLorebooks = await pool().query("SELECT id,name,lorebook,user_id FROM characters WHERE lorebook<>''");
  for (const character of legacyLorebooks.rows) {
    const worldId = randomUUID();
    // Preserve ownership while converting the old embedded lorebook. This
    // remains compatible with a plain legacy PostgreSQL database, where
    // user_id is nullable, while satisfying the production NOT NULL/RLS model.
    await pool().query(
      "INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,$3,$4,$5,'private')",
      [worldId,character.user_id ?? null,`${character.name} world`,"Imported from the original embedded character lorebook.",character.lorebook],
    );
    await pool().query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)", [character.id,worldId]);
    await pool().query("UPDATE characters SET lorebook='' WHERE id=$1", [character.id]);
  }
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// pg-mem, which backs the schema and memory-engine unit tests, implements
// neither roles nor set_config. Probed once per pool so a real deployment can
// refuse to run without policy enforcement while the in-memory suite still
// exercises the same SQL.
let rlsSessionSupported: boolean | null = null;

export function resetUserSessionSupportForTesting() {
  if (process.env.NODE_ENV !== "test") throw new Error("Session support reset is test-only");
  rlsSessionSupported = null;
}

async function probeUserSessionSupport() {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claims','{}',true)");
    return true;
  } catch {
    return false;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function userSessionSupported() {
  if (rlsSessionSupported === null) rlsSessionSupported = await probeUserSessionSupport();
  if (!rlsSessionSupported && process.env.NODE_ENV !== "test") {
    throw new Error(
      "This database cannot assume the authenticated role, so row level security would not be enforced. Apply supabase/migrations before serving traffic.",
    );
  }
  return rlsSessionSupported;
}

/**
 * Runs a unit of work as the given account.
 *
 * The pool authenticates as a privileged database role, so every statement
 * would otherwise bypass row level security. Assuming the `authenticated` role
 * and publishing the caller's id as `request.jwt.claims` makes `auth.uid()`
 * resolve exactly as it does through PostgREST, which turns the policies in
 * supabase/migrations into the real enforcement layer rather than a second
 * opinion on top of application checks.
 *
 * Both settings are transaction-scoped (SET LOCAL), so a connection returned to
 * the pool never carries one account's identity into the next request.
 */
export async function asUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>) {
  if (!uuidPattern.test(userId)) throw new Error("A database session requires a valid account id");
  await ensureSchema();
  const enforced = await userSessionSupported();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    if (enforced) {
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Single user-scoped statement. Shorthand for the common one-query case. */
export async function userQuery<T extends QueryResultRow>(userId: string, text: string, values: unknown[] = []) {
  return asUser(userId, (client) => client.query<T>(text, values));
}

export function characterFromRow(row: Record<string, unknown>, viewerId?: string): Character {
  const ownedByViewer = viewerId ? String(row.user_id ?? "") === viewerId : true;
  const cast = Array.isArray(row.cast_members) ? row.cast_members.filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === "object").map((member) => ({
    name: String(member.name || ""), role: String(member.role || ""), description: String(member.description || ""),
  })).filter((member) => member.name) : [];
  const alternateGreetings = Array.isArray(row.alternate_greetings) ? row.alternate_greetings.filter((item): item is string => typeof item === "string") : [];
  const worldIds = textArrayFromRow(row.world_ids);
  return {
    id: String(row.id), name: String(row.name), profileType: row.profile_type === "ensemble" ? "ensemble" : "single", tagline: String(row.tagline),
    avatarUrl: String(row.avatar_url), avatarPath: String(row.avatar_path || ""), accent: String(row.accent), backstory: String(row.backstory),
    cast, lorebook: String(row.lorebook || ""), personality: String(row.personality), scenario: String(row.scenario), greeting: String(row.greeting), alternateGreetings,
    exampleDialogue: String(row.example_dialogue), responseDirective: String(row.response_directive),
    boundaries: String(row.boundaries),
    // The original import paste is the creator's working material and often
    // holds private notes. Publishing a character shares the card, not that.
    sourceMaterial: ownedByViewer ? String(row.source_material || "") : "",
    worldIds,
    visibility: (["private","unlisted","public"].includes(String(row.visibility)) ? String(row.visibility) : "private") as Character["visibility"],
    nsfwEnabled: Boolean(row.nsfw_enabled),
    likeCount: Number(row.like_count || 0), likedByViewer: Boolean(row.liked_by_viewer),
    creator: row.creator_id ? { id: String(row.creator_id), username: String(row.creator_username || ""), displayName: String(row.creator_display_name || ""), avatarPath: String(row.creator_avatar_path || "") } : null,
    ownedByViewer,
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function conversationFromRow(row: Record<string, unknown>): Conversation {
  const allowed = new Set<ChatInstructionPreset>(["reduce_repetition","stay_focused","advance_plot"]);
  const instructionPresets = textArrayFromRow(row.instruction_presets).filter((item): item is ChatInstructionPreset => allowed.has(item as ChatInstructionPreset));
  return {
    id: String(row.id), characterId: String(row.character_id), title: String(row.title),
    summary: String(row.summary), personaId: row.persona_id ? String(row.persona_id) : null,
    providerId: String(row.provider_id || "deepseek"), modelId: String(row.model_id || "deepseek-v4-flash"),
    rpEngineId: (roleplayEngineIds.includes(String(row.rp_engine_id) as Conversation["rpEngineId"]) ? String(row.rp_engine_id) : "immersive") as Conversation["rpEngineId"],
    instructionPresets, customInstructions: String(row.custom_instructions || ""),
    responseLength: responseLengths.includes(String(row.response_length) as Conversation["responseLength"] & string) ? row.response_length as Conversation["responseLength"] : null,
    temperature: row.temperature == null ? null : Number(row.temperature), messageCount: Number(row.message_count),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function personaFromRow(row: Record<string, unknown>): Persona {
  return {
    id: String(row.id), name: String(row.name), description: String(row.description || ""), avatarUrl: String(row.avatar_url || ""),
    avatarPath: String(row.avatar_path || ""), accent: String(row.accent || "#e879a9"), isDefault: Boolean(row.is_default),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function worldFromRow(row: Record<string, unknown>): World {
  return {
    id: String(row.id), name: String(row.name), description: String(row.description || ""), content: String(row.content || ""),
    visibility: (["private","unlisted","public"].includes(String(row.visibility)) ? String(row.visibility) : "private") as World["visibility"],
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

/** Removes memory-retrieval diagnostics from ordinary product responses. */
export function messageForViewer(message: Message, includeDiagnostics: boolean): Message {
  return includeDiagnostics ? message : { ...message, memoryIds: [], arcIds: [] };
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

export function coreCanonFromRow(row: Record<string, unknown>): CoreCanonEntry {
  const storedStatus = String(row.status || "active");
  const storedCategory = String(row.category || "event");
  return {
    id: String(row.id), conversationId: String(row.conversation_id), characterId: String(row.character_id),
    content: String(row.content),
    category: (["identity","relationship","event","promise","preference","boundary","open_loop"].includes(storedCategory) ? storedCategory : "event") as CoreCanonEntry["category"],
    importance: Number(row.importance || 3),
    status: (["active","superseded","demoted"].includes(storedStatus) ? storedStatus : "active") as CoreCanonEntry["status"],
    sourceMemoryIds: textArrayFromRow(row.source_memory_ids), sourceArcIds: textArrayFromRow(row.source_arc_ids),
    sourceMessageCount: Number(row.source_message_count || 0), tokenCount: Number(row.token_count || 0),
    curationVersion: Number(row.curation_version || 1),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function settingsFromRow(row: Record<string, unknown>): AppSettings {
  const storedPreset = String(row.roleplay_preset || "immersive");
  const roleplayPreset: AppSettings["roleplayPreset"] = roleplayEngineIds.includes(storedPreset as AppSettings["roleplayPreset"])
    ? storedPreset as AppSettings["roleplayPreset"] : "immersive";
  return {
    ownerName: String(row.owner_name), ownerProfile: String(row.owner_profile), providerId: String(row.provider_id || "deepseek"), model: String(row.model),
    roleplayPreset,
    responseLength: responseLengths.includes(String(row.response_length) as AppSettings["responseLength"]) ? row.response_length as AppSettings["responseLength"] : "natural",
    temperature: Number(row.temperature), maxTokens: Number(row.max_tokens), contextMessages: Number(row.context_messages), contextTokenBudget: Number(row.context_token_budget || 12000),
    consolidationInterval: Number(row.consolidation_interval), memoryLimit: Number(row.memory_limit), memoryTokenBudget: Number(row.memory_token_budget || 6000),
  };
}

/** Server-managed defaults. Never user-writable; used to seed new accounts. */
export async function getDefaultSettings() {
  const result = await query("SELECT * FROM app_settings WHERE id='owner'");
  return settingsFromRow(result.rows[0]);
}

/**
 * The calling account's settings, creating the row on first read so an account
 * that predates the settings table still resolves.
 */
export async function getUserSettings(client: PoolClient, userId: string) {
  const existing = await client.query("SELECT * FROM user_settings WHERE user_id=$1", [userId]);
  if (existing.rowCount) return settingsFromRow(existing.rows[0]);
  const created = await client.query(
    "INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING *",
    [userId],
  );
  return settingsFromRow(created.rows[0]);
}

export function profileFromRow(row: Record<string, unknown>) {
  const plan = String(row.plan || "free");
  return {
    id: String(row.id), username: String(row.username || ""), displayName: String(row.display_name || ""),
    avatarPath: String(row.avatar_path || ""), bio: String(row.bio || ""),
    plan: (["free","beta","pro"].includes(plan) ? plan : "free") as "free" | "beta" | "pro",
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}
