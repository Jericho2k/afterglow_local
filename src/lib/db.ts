import { randomUUID } from "node:crypto";
import { maxLoreBlockText, normalizeBlocks } from "./rich-content";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { responseLengths, roleplayEngineIds, type AppSettings, type Character, type ChatInstructionPreset, type Conversation, type CoreCanonEntry, type CreationSummary, type Memory, type MemoryArc, type Message, type OwnedCreationSummary, type Persona, type ScenePhysical, type SceneStamp, type SceneState, type World, type WorldSummary } from "./types";

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
      last_consolidated_offset integer NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS memory_feedback (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      retrieval_run_id uuid,
      category text NOT NULL,
      note text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, message_id)
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
    CREATE TABLE IF NOT EXISTS conversation_scene_states (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      through_message_count integer NOT NULL DEFAULT 0,
      through_message_id uuid,
      through_message_fingerprint text NOT NULL DEFAULT '',
      provisional boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'ok',
      story_day integer,
      date_kind text NOT NULL DEFAULT 'unknown',
      date_text text NOT NULL DEFAULT '',
      time_of_day text NOT NULL DEFAULT '',
      time_text text NOT NULL DEFAULT '',
      location_place text NOT NULL DEFAULT '',
      location_sub text NOT NULL DEFAULT '',
      location_confidence text NOT NULL DEFAULT 'unknown',
      present_characters text[] NOT NULL DEFAULT ARRAY[]::text[],
      active_situation text[] NOT NULL DEFAULT ARRAY[]::text[],
      physical_actors jsonb NOT NULL DEFAULT '[]'::jsonb,
      physical_contacts text[] NOT NULL DEFAULT ARRAY[]::text[],
      physical_constraints text[] NOT NULL DEFAULT ARRAY[]::text[],
      changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
      extraction_model text NOT NULL DEFAULT '',
      extraction_provider text NOT NULL DEFAULT '',
      extraction_latency_ms integer NOT NULL DEFAULT 0,
      failure_reason text NOT NULL DEFAULT '',
      token_count integer NOT NULL DEFAULT 0,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_scene_states_position_idx ON conversation_scene_states(conversation_id,through_message_count);
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
    CREATE TABLE IF NOT EXISTS profile_follows (
      follower_user_id uuid NOT NULL,
      creator_user_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (follower_user_id, creator_user_id)
    );
    CREATE TABLE IF NOT EXISTS creator_stats (
      user_id uuid PRIMARY KEY,
      published_creations integer NOT NULL DEFAULT 0,
      published_worlds integer NOT NULL DEFAULT 0,
      user_messages bigint NOT NULL DEFAULT 0,
      saves bigint NOT NULL DEFAULT 0,
      followers integer NOT NULL DEFAULT 0,
      rank integer,
      rank_total integer NOT NULL DEFAULT 0,
      computed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS creator_stats_refresh (
      id boolean PRIMARY KEY DEFAULT true,
      refreshed_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    CREATE TABLE IF NOT EXISTS profile_achievements (
      user_id uuid NOT NULL,
      achievement_id text NOT NULL,
      unlocked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, achievement_id)
    );
    CREATE TABLE IF NOT EXISTS profile_activity (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      kind text NOT NULL,
      key text NOT NULL DEFAULT '',
      title text NOT NULL,
      subject text NOT NULL DEFAULT '',
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS conversation_worlds (
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, world_id)
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
    CREATE TABLE IF NOT EXISTS user_provider_credentials (
      user_id uuid NOT NULL,
      provider text NOT NULL,
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL,
      auth_tag bytea NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      key_suffix text NOT NULL,
      validated_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id,provider)
    );
    CREATE TABLE IF NOT EXISTS character_report_evidence (
      report_id uuid PRIMARY KEY REFERENCES character_reports(id) ON DELETE CASCADE,
      character_id uuid,
      creator_user_id uuid NOT NULL,
      snapshot jsonb NOT NULL,
      captured_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS moderation_actions (
      id uuid PRIMARY KEY,
      character_id uuid,
      report_id uuid REFERENCES character_reports(id) ON DELETE SET NULL,
      moderator_user_id uuid NOT NULL,
      action text NOT NULL,
      reason text NOT NULL DEFAULT '',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
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
  // Where inside an oversized message the next consolidation pass resumes; see
  // migration 0027 and `planConsolidationBatch`.
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_consolidated_offset integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS selected_variant integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS memory_ids uuid[] NOT NULL DEFAULT '{}'");
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS memory_arc_ids uuid[] NOT NULL DEFAULT '{}'");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'event'");
  // Memory transparency (migration 0026). `context_provenance` records what one
  // reply was written from; `origin` and the supersession stamps make a
  // reader-owned archive editable without losing what older replies read.
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS context_provenance jsonb NOT NULL DEFAULT '{}'::jsonb");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'consolidation'");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by uuid");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_at timestamptz");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'active'");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS moderated_at timestamptz");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS moderated_by uuid");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS moderation_reason text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS pre_moderation_visibility text");
  await pool().query("ALTER TABLE character_reports ADD COLUMN IF NOT EXISTS reviewed_at timestamptz");
  await pool().query("ALTER TABLE character_reports ADD COLUMN IF NOT EXISTS reviewed_by uuid");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS resolution text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS resolved_at timestamptz");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_recalled_at timestamptz");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS recall_count integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_message_count integer NOT NULL DEFAULT 0");
  await pool().query("CREATE INDEX IF NOT EXISTS memories_conversation_status_idx ON memories(conversation_id, status, kind)");
  // Scene State grounding on the permanent archive (migration 0013). Empty by
  // design on everything written earlier: an un-annotated memory is presented
  // without a chronology tag rather than being given an invented one.
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS scene_story_day integer");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS scene_time_of_day text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS scene_location text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS scene_present text[] NOT NULL DEFAULT ARRAY[]::text[]");
  await pool().query("ALTER TABLE memory_arcs ADD COLUMN IF NOT EXISTS story_day_start integer");
  await pool().query("ALTER TABLE memory_arcs ADD COLUMN IF NOT EXISTS story_day_end integer");
  await pool().query("ALTER TABLE memory_arcs ADD COLUMN IF NOT EXISTS scene_locations text[] NOT NULL DEFAULT ARRAY[]::text[]");
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
  await pool().query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS generation_started_at timestamptz");
  await pool().query("CREATE TABLE IF NOT EXISTS afterglow_runtime_migrations (key text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
  try {
    await pool().query("ALTER TABLE afterglow_runtime_migrations ENABLE ROW LEVEL SECURITY");
    await pool().query("REVOKE ALL ON afterglow_runtime_migrations FROM anon,authenticated");
  } catch (error) {
    if(process.env.NODE_ENV!=="test")throw error;
  }
  const canonicalBackfill=await pool().query("INSERT INTO afterglow_runtime_migrations(key) VALUES ('0008_canonical_generated_user_messages') ON CONFLICT DO NOTHING RETURNING key");
  if(canonicalBackfill.rowCount)await pool().query("UPDATE messages SET generation_started_at=created_at WHERE role='user' AND generation_started_at IS NULL");
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
  for (const table of ["characters","worlds","personas","conversations","messages","memories","memory_arcs","core_canon_entries","memory_retrieval_runs","memory_job_leases","conversation_scene_states","usage_events"]) {
    await pool().query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS user_id uuid`);
  }
  await pool().query("CREATE INDEX IF NOT EXISTS messages_canonical_user_event_idx ON messages(user_id,authored_event_id) WHERE role='user' AND generation_started_at IS NOT NULL");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS avatar_path text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS published_at timestamptz");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS origin_character_id uuid");
  await pool().query("ALTER TABLE worlds ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'");
  // Public character profile enrichment (migration 0009). All optional: a
  // character created through the simple flow simply has a shorter page.
  // Spelled as an array constructor rather than '{}' so the in-memory engine
  // the tests run against defaults to a real empty array, exactly as Postgres
  // does. An existing column keeps whatever default it was created with.
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[]");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS quick_facts jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS chat_count integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0");
  // Creation model. Every column is additive with a default that reproduces
  // the previous behaviour, so a character written before this release keeps
  // rendering: an empty title falls back to the name, and an ensemble card
  // reads as a cast.
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS creation_type text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS user_role text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS hashtags text[] NOT NULL DEFAULT ARRAY[]::text[]");
  await pool().query("ALTER TABLE worlds ADD COLUMN IF NOT EXISTS cover_path text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE worlds ADD COLUMN IF NOT EXISTS cover_url text NOT NULL DEFAULT ''");
  await pool().query(`
    CREATE TABLE IF NOT EXISTS character_gallery (
      id uuid PRIMARY KEY,
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      user_id uuid,
      storage_path text NOT NULL DEFAULT '',
      external_url text NOT NULL DEFAULT '',
      caption text NOT NULL DEFAULT '',
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS character_comments (
      id uuid PRIMARY KEY,
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      user_id uuid,
      parent_id uuid,
      body text NOT NULL,
      like_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool().query("CREATE INDEX IF NOT EXISTS character_gallery_character_idx ON character_gallery (character_id, position, created_at)");
  await pool().query("CREATE INDEX IF NOT EXISTS character_comments_character_idx ON character_comments (character_id, created_at DESC)");
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
      writer_funding text NOT NULL DEFAULT 'afterglow',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool().query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek'");
  await pool().query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS response_length text NOT NULL DEFAULT 'natural'");
  await pool().query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS writer_funding text NOT NULL DEFAULT 'afterglow'");
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
  await pool().query("CREATE INDEX IF NOT EXISTS conversation_scene_states_current_idx ON conversation_scene_states (user_id, conversation_id, through_message_count DESC)");
  // Physical continuity. Additive, empty by default, and empty means unknown;
  // the constraints and the reasoning live in 0020_scene_physical_state.sql.
  await pool().query("ALTER TABLE conversation_scene_states ADD COLUMN IF NOT EXISTS physical_actors jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE conversation_scene_states ADD COLUMN IF NOT EXISTS physical_contacts text[] NOT NULL DEFAULT ARRAY[]::text[]");
  await pool().query("ALTER TABLE conversation_scene_states ADD COLUMN IF NOT EXISTS physical_constraints text[] NOT NULL DEFAULT ARRAY[]::text[]");
  /*
   * Creator Profile V2.
   *
   * The counters, triggers, policies and the ranking function live in
   * 0021_creator_profile_v2.sql. What is repeated here is only the shape a
   * plain PostgreSQL database needs to run the same code paths: the columns
   * the queries name, and the two relations they read. A deployment on
   * Supabase has all of this from the migration and these statements are
   * no-ops.
   */
  await pool().query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cover_path text NOT NULL DEFAULT ''");
  await pool().query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_border text NOT NULL DEFAULT 'default'");
  await pool().query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS featured_achievements text[] NOT NULL DEFAULT ARRAY[]::text[]");
  await pool().query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS follower_count integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS following_count integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS user_message_count integer NOT NULL DEFAULT 0");
  await pool().query("CREATE INDEX IF NOT EXISTS characters_creator_popular_idx ON characters (user_id, user_message_count DESC, id DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS profile_follows_creator_idx ON profile_follows (creator_user_id, created_at DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS profile_follows_follower_idx ON profile_follows (follower_user_id, created_at DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS profile_activity_user_idx ON profile_activity (user_id, occurred_at DESC)");
  /*
   * Social discovery.
   *
   * The policies, the fanout function and the ranking rebuild live in
   * 0022_social_discovery.sql. What is repeated here is only the shape a plain
   * PostgreSQL database needs to run the same code paths: the tables the
   * queries name and the indexes they read through. A deployment on Supabase
   * has all of this from the migration and these statements are no-ops.
   */
  await pool().query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      type text NOT NULL,
      actor_user_id uuid,
      character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
      dedupe_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    );
  `);
  await pool().query("CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC, id DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL");
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications (user_id, dedupe_key)");
  await pool().query(`
    CREATE TABLE IF NOT EXISTS creation_rankings (
      character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      category text NOT NULL DEFAULT '',
      rank integer NOT NULL,
      rank_total integer NOT NULL DEFAULT 0,
      user_messages integer NOT NULL DEFAULT 0,
      computed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (character_id, category)
    );
  `);
  await pool().query("CREATE INDEX IF NOT EXISTS creation_rankings_board_idx ON creation_rankings (category, rank)");
  await pool().query("CREATE INDEX IF NOT EXISTS creation_rankings_creation_idx ON creation_rankings (character_id, rank)");
  await pool().query(`
    CREATE TABLE IF NOT EXISTS creation_rankings_refresh (
      id boolean PRIMARY KEY DEFAULT true,
      refreshed_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
  `);
  await pool().query("INSERT INTO creation_rankings_refresh (id) VALUES (true) ON CONFLICT (id) DO NOTHING");
  await pool().query("CREATE INDEX IF NOT EXISTS characters_creator_published_idx ON characters (user_id, published_at DESC NULLS LAST, id DESC) WHERE visibility = 'public'");
  await pool().query("CREATE INDEX IF NOT EXISTS characters_messages_idx ON characters (user_message_count DESC, like_count DESC, id DESC) WHERE visibility = 'public'");
  await pool().query("CREATE INDEX IF NOT EXISTS creator_stats_messages_idx ON creator_stats (user_messages DESC, followers DESC, user_id)");
  // Worlds V2: saves, comments and the rich-content columns. Mirrors
  // migrations 0014-0016 so the in-memory test database matches production.
  await pool().query("ALTER TABLE worlds ADD COLUMN IF NOT EXISTS save_count integer NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE worlds ADD COLUMN IF NOT EXISTS content_rich jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS description_rich jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS greeting_rich jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS alternate_greetings_rich jsonb NOT NULL DEFAULT '[]'::jsonb");
  await pool().query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS discovery_preferences jsonb NOT NULL DEFAULT '{}'::jsonb");
  await pool().query(`
    CREATE TABLE IF NOT EXISTS world_saves (
      user_id uuid NOT NULL,
      world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, world_id)
    );
  `);
  await pool().query("CREATE INDEX IF NOT EXISTS world_saves_user_idx ON world_saves (user_id, created_at DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS world_saves_world_idx ON world_saves (world_id)");
  await pool().query(`
    CREATE TABLE IF NOT EXISTS world_comments (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      parent_id uuid,
      body text NOT NULL,
      like_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool().query("CREATE INDEX IF NOT EXISTS world_comments_world_idx ON world_comments (world_id, created_at DESC)");
  // A story's own world set. The full constraints, policies and the backfill
  // live in 0019_conversation_worlds.sql; this keeps a plain PostgreSQL
  // database — the one the tests and the legacy deployment use — able to run
  // the same code paths.
  await pool().query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS worlds_initialized boolean NOT NULL DEFAULT false");
  await pool().query("CREATE INDEX IF NOT EXISTS conversation_worlds_conversation_idx ON conversation_worlds (user_id, conversation_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS conversation_worlds_world_idx ON conversation_worlds (world_id)");
  await pool().query("CREATE INDEX IF NOT EXISTS character_likes_user_idx ON character_likes (user_id, created_at DESC)");
  await pool().query("CREATE INDEX IF NOT EXISTS character_likes_character_idx ON character_likes (character_id)");
  // One index per discovery ordering, matching the feed's ORDER BY so a page
  // is a range scan rather than a sort of every public creation.
  await pool().query("CREATE INDEX IF NOT EXISTS characters_discovery_new_idx ON characters (published_at DESC, created_at DESC, id DESC) WHERE visibility = 'public'");
  await pool().query("CREATE INDEX IF NOT EXISTS characters_discovery_popular_idx ON characters (like_count DESC, chat_count DESC, id DESC) WHERE visibility = 'public'");
  await pool().query("CREATE INDEX IF NOT EXISTS characters_discovery_chatted_idx ON characters (chat_count DESC, message_count DESC, id DESC) WHERE visibility = 'public'");
  await pool().query("CREATE INDEX IF NOT EXISTS character_reports_user_idx ON character_reports (user_id, created_at DESC)");
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS character_reports_one_active_idx ON character_reports (user_id,character_id) WHERE status IN ('pending','reviewing') AND character_id IS NOT NULL");
  await pool().query("CREATE INDEX IF NOT EXISTS character_reports_queue_idx ON character_reports (created_at DESC) WHERE status IN ('pending','reviewing')");
  // Branch-prefix reads: see migration 0023 and `branchConversation`.
  await pool().query("CREATE INDEX IF NOT EXISTS messages_branch_prefix_idx ON messages (conversation_id, created_at, id)");
  await pool().query("CREATE INDEX IF NOT EXISTS memories_branch_prefix_idx ON memories (conversation_id, source_message_count, created_at, id)");
  await pool().query("CREATE INDEX IF NOT EXISTS memory_arcs_branch_prefix_idx ON memory_arcs (conversation_id, end_message_count, created_at, id)");
  await pool().query("CREATE INDEX IF NOT EXISTS core_canon_branch_prefix_idx ON core_canon_entries (conversation_id, source_message_count, created_at, id)");
  await pool().query("CREATE INDEX IF NOT EXISTS scene_states_branch_prefix_idx ON conversation_scene_states (conversation_id, through_message_count DESC, created_at DESC)");

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

/** `BEGIN` and the account's identity, as one statement. See `asUser`. */
function beginAsUser(userId: string) {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" }).replace(/'/g, "''");
  return `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '${claims}', true);`;
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
    // One round trip, not three.
    //
    // Opening the transaction and publishing the identity are the same act, so
    // they are sent as one simple-protocol statement. Against a pooled remote
    // database each `query()` is a network leg, and this path runs on every
    // authenticated request in the product: three legs of ceremony before the
    // first real statement was a measurable share of every interaction.
    //
    // The claims are inlined rather than parameterised because the extended
    // protocol cannot carry a multi-statement command. That is safe here for a
    // structural reason, not a hopeful one: `userId` has already been checked
    // against `uuidPattern` above, so it can only be hexadecimal and hyphens,
    // and the quote-doubling below is the second lock on a door that has no
    // handle.
    await client.query(enforced ? beginAsUser(userId) : "BEGIN");
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

/** Ordered label/value pairs, bounded so a malformed row cannot flood the page. */
function quickFactsFromRow(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({ label: String(item.label ?? "").trim(), value: String(item.value ?? "").trim() }))
    .filter((item) => item.label && item.value)
    .slice(0, 6);
}

function galleryFromRow(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      id: String(item.id ?? ""),
      storagePath: String(item.storage_path ?? item.storagePath ?? ""),
      externalUrl: String(item.external_url ?? item.externalUrl ?? ""),
      caption: String(item.caption ?? ""),
      position: Number(item.position ?? 0),
    }))
    .filter((item) => item.id && (item.storagePath || item.externalUrl))
    .sort((left, right) => left.position - right.position);
}

/**
 * Cast members as stored. The portrait and public blurb are optional, so a
 * member written before those fields existed simply has neither.
 */
export function castMembersFromRow(value: unknown): Character["cast"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === "object")
    .map((member) => ({
      name: String(member.name || ""),
      id: String(member.id || ""),
      role: String(member.role || ""),
      description: String(member.description || ""),
      tagline: String(member.tagline || ""),
      avatarPath: String(member.avatarPath || ""),
      avatarUrl: String(member.avatarUrl || ""),
    }))
    .filter((member) => member.name);
}

export function characterFromRow(row: Record<string, unknown>, viewerId?: string): Character {
  const ownedByViewer = viewerId ? String(row.user_id ?? "") === viewerId : true;
  const cast = castMembersFromRow(row.cast_members);
  const alternateGreetings = Array.isArray(row.alternate_greetings) ? row.alternate_greetings.filter((item): item is string => typeof item === "string") : [];
  const worldIds = textArrayFromRow(row.world_ids);
  const profileType = row.profile_type === "ensemble" ? "ensemble" as const : "single" as const;
  // An empty creation_type is a row written before creations existed; the
  // ensemble flag is the only structural information it carries.
  const storedType = String(row.creation_type || "");
  const creationType = storedType === "character" || storedType === "cast" || storedType === "scenario"
    ? storedType as Character["creationType"]
    : profileType === "ensemble" ? "cast" : "character";
  return {
    id: String(row.id), name: String(row.name), creationType, title: String(row.title || ""), profileType, tagline: String(row.tagline),
    description: String(row.description || ""), userRole: String(row.user_role || ""),
    avatarUrl: String(row.avatar_url), avatarPath: String(row.avatar_path || ""), accent: String(row.accent), backstory: String(row.backstory),
    cast, lorebook: String(row.lorebook || ""), personality: String(row.personality), scenario: String(row.scenario), greeting: String(row.greeting), alternateGreetings,
    // Blocks are presentation. The text columns beside them are what every
    // prompt, snapshot and backup reads, so an illustrated creation reaches a
    // model as words alone without any caller having to know that.
    descriptionRich: normalizeBlocks(row.description_rich),
    greetingRich: normalizeBlocks(row.greeting_rich),
    alternateGreetingsRich: Array.isArray(row.alternate_greetings_rich)
      ? row.alternate_greetings_rich.map((entry) => normalizeBlocks(entry))
      : [],
    exampleDialogue: String(row.example_dialogue), responseDirective: String(row.response_directive),
    boundaries: String(row.boundaries),
    // The original import paste is the creator's working material and often
    // holds private notes. Publishing a character shares the card, not that.
    sourceMaterial: ownedByViewer ? String(row.source_material || "") : "",
    worldIds,
    tags: textArrayFromRow(row.tags),
    hashtags: textArrayFromRow(row.hashtags),
    quickFacts: quickFactsFromRow(row.quick_facts),
    gallery: galleryFromRow(row.gallery),
    publicStats: {
      messages: row.message_count == null ? null : Number(row.message_count),
      // The saves total lives in the `like_count` column, which predates the
      // rename. The column is the storage name; "saves" is the product name.
      saves: row.like_count == null ? null : Number(row.like_count),
      chats: row.chat_count == null ? null : Number(row.chat_count),
      // Ranking is not computed yet. Null keeps the slot in the interface and
      // renders as unavailable instead of inventing a position.
      rank: row.rank == null ? null : Number(row.rank),
      rankCategory: row.rank_category == null ? null : String(row.rank_category),
    },
    visibility: (["private","unlisted","public"].includes(String(row.visibility)) ? String(row.visibility) : "private") as Character["visibility"],
    moderationStatus:row.moderation_status==="removed"?"removed":"active",
    moderationReason:ownedByViewer?String(row.moderation_reason||""):"",
    nsfwEnabled: Boolean(row.nsfw_enabled),
    saveCount: Number(row.like_count || 0), savedByViewer: Boolean(row.saved_by_viewer),
    creator: row.creator_id ? { id: String(row.creator_id), username: String(row.creator_username || ""), displayName: String(row.creator_display_name || ""), avatarPath: String(row.creator_avatar_path || "") } : null,
    ownedByViewer,
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/**
 * The lean row a discovery card is built from.
 *
 * Paired with the column list in `/api/discovery`: nothing hidden is selected
 * there, and nothing hidden is read here, so a mistake in either place is a
 * missing field rather than a leaked definition.
 */
export function creationSummaryFromRow(row: Record<string, unknown>, viewerId: string): CreationSummary {
  const profileType = row.profile_type === "ensemble" ? "ensemble" as const : "single" as const;
  const storedType = String(row.creation_type || "");
  const type = storedType === "character" || storedType === "cast" || storedType === "scenario"
    ? storedType as CreationSummary["creationType"]
    : profileType === "ensemble" ? "cast" : "character";
  const creatorId = row.creator_id ? String(row.creator_id) : "";
  return {
    id: String(row.id),
    name: String(row.name || ""),
    title: String(row.title || ""),
    creationType: type,
    profileType,
    tagline: String(row.tagline || ""),
    avatarUrl: String(row.avatar_url || ""),
    avatarPath: String(row.avatar_path || ""),
    accent: String(row.accent || "#e879a9"),
    tags: textArrayFromRow(row.tags),
    hashtags: textArrayFromRow(row.hashtags),
    nsfwEnabled: Boolean(row.nsfw_enabled),
    messageCount: Number(row.message_count || 0),
    chatCount: Number(row.chat_count || 0),
    saveCount: Number(row.like_count || 0),
    savedByViewer: Boolean(row.saved_by_viewer),
    creator: creatorId
      ? { id: creatorId, username: String(row.creator_username || ""), displayName: String(row.creator_display_name || ""), avatarPath: String(row.creator_avatar_path || "") }
      : null,
    ownedByViewer: String(row.user_id ?? "") === viewerId,
    publishedAt: row.published_at ? new Date(String(row.published_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/**
 * The lean row the owner's management list is built from.
 *
 * Deliberately built on the discovery summary rather than beside it: the two
 * lists render the same card, so they read the same fields, and an owner's
 * grid cannot quietly start carrying greetings and response directives.
 */
export function ownedCreationFromRow(row: Record<string, unknown>, viewerId: string): OwnedCreationSummary {
  return {
    ...creationSummaryFromRow(row, viewerId),
    visibility: (["private", "unlisted", "public"].includes(String(row.visibility)) ? String(row.visibility) : "private") as OwnedCreationSummary["visibility"],
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
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

export function worldFromRow(row: Record<string, unknown>, viewerId?: string): World {
  const creatorId = row.creator_id ? String(row.creator_id) : "";
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description || ""),
    content: String(row.content || ""),
    contentRich: normalizeBlocks(row.content_rich, maxLoreBlockText),
    coverPath: String(row.cover_path || ""),
    coverUrl: String(row.cover_url || ""),
    visibility: (["private", "unlisted", "public"].includes(String(row.visibility)) ? String(row.visibility) : "private") as World["visibility"],
    saveCount: Number(row.save_count || 0),
    savedByViewer: Boolean(row.saved_by_viewer),
    ownedByViewer: viewerId ? String(row.user_id ?? "") === viewerId : true,
    creator: creatorId
      ? { id: creatorId, username: String(row.creator_username || ""), displayName: String(row.creator_display_name || ""), avatarPath: String(row.creator_avatar_path || "") }
      : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/**
 * The lean row a world card is built from.
 *
 * Paired with the column lists in the world routes: lore is never selected for
 * a listing, so a page of world cards cannot carry a page of canon documents,
 * and a private world's content has no path to a public surface.
 */
export function worldSummaryFromRow(row: Record<string, unknown>, viewerId: string): WorldSummary {
  const creatorId = row.creator_id ? String(row.creator_id) : "";
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description || ""),
    coverPath: String(row.cover_path || ""),
    coverUrl: String(row.cover_url || ""),
    visibility: (["private", "unlisted", "public"].includes(String(row.visibility)) ? String(row.visibility) : "private") as WorldSummary["visibility"],
    saveCount: Number(row.save_count || 0),
    savedByViewer: Boolean(row.saved_by_viewer),
    ownedByViewer: String(row.user_id ?? "") === viewerId,
    creationCount: Number(row.creation_count || 0),
    creator: creatorId
      ? { id: creatorId, username: String(row.creator_username || ""), displayName: String(row.creator_display_name || ""), avatarPath: String(row.creator_avatar_path || "") }
      : null,
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
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
    recallCount: Number(row.recall_count || 0), sourceMessageCount: Number(row.source_message_count || 0),
    scene: sceneStampFromRow(row.scene_story_day,row.scene_time_of_day,row.scene_location,row.scene_present),
    origin: (["consolidation","user","import"].includes(String(row.origin)) ? String(row.origin) : "consolidation") as Memory["origin"],
    supersededBy: row.superseded_by ? String(row.superseded_by) : null,
    supersededAt: row.superseded_at ? new Date(String(row.superseded_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : new Date(String(row.created_at)).toISOString(),
  };
}

/**
 * The compact when/where a memory or arc kept, or null when it kept none.
 *
 * A row written before Scene State existed has every field empty, and that has
 * to stay distinguishable from "day 0 at an unnamed place" so the prompt can
 * simply omit the tag instead of asserting an unknown chronology.
 */
function sceneStampFromRow(day: unknown, timeOfDay: unknown, location: unknown, present: unknown): SceneStamp | null {
  const storyDay = day == null || day === "" ? null : Number(day);
  const stamp: SceneStamp = {
    storyDay: Number.isFinite(storyDay) ? storyDay : null,
    timeOfDay: String(timeOfDay || ""),
    location: String(location || ""),
    present: textArrayFromRow(present),
  };
  return stamp.storyDay === null && !stamp.timeOfDay && !stamp.location && !stamp.present.length ? null : stamp;
}

export function memoryArcFromRow(row: Record<string, unknown>): MemoryArc {
  return {
    id: String(row.id), conversationId: String(row.conversation_id), summary: String(row.summary),
    keywords: textArrayFromRow(row.keywords), startMessageCount: Number(row.start_message_count),
    endMessageCount: Number(row.end_message_count),
    storyDayStart: row.story_day_start == null ? null : Number(row.story_day_start),
    storyDayEnd: row.story_day_end == null ? null : Number(row.story_day_end),
    locations: textArrayFromRow(row.scene_locations),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/**
 * The physical arrangement stored on a scene row.
 *
 * Written defensively because it is the one part of a scene that arrives as
 * free-form JSON. A row from before 0020 has no column at all, a row written by
 * a future version may have fields this one has never heard of, and neither may
 * produce anything other than a well-formed arrangement here — a broken shape
 * must read as "nothing established", which is the safe answer and also the
 * true one.
 */
function physicalFromRow(row: Record<string, unknown>): ScenePhysical {
  const raw = row.physical_actors;
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  const actors = Array.isArray(parsed) ? parsed : [];
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    actors: actors
      .filter((actor): actor is Record<string, unknown> => Boolean(actor) && typeof actor === "object")
      .map((actor) => ({
        name: text(actor.name),
        posture: text(actor.posture), facing: text(actor.facing),
        relativeTo: text(actor.relativeTo), support: text(actor.support),
        leftArm: text(actor.leftArm), rightArm: text(actor.rightArm),
        leftHand: text(actor.leftHand), rightHand: text(actor.rightHand),
        leftLeg: text(actor.leftLeg), rightLeg: text(actor.rightLeg),
        leftFoot: text(actor.leftFoot), rightFoot: text(actor.rightFoot),
        held: Array.isArray(actor.held) ? actor.held.filter((item): item is string => typeof item === "string") : [],
      }))
      .filter((actor) => actor.name),
    contacts: textArrayFromRow(row.physical_contacts),
    constraints: textArrayFromRow(row.physical_constraints),
  };
}

/** A persisted Scene State row. Unknown stays unknown: no field is defaulted. */
export function sceneStateFromRow(row: Record<string, unknown>): SceneState {
  const dateKind = String(row.date_kind || "unknown");
  const confidence = String(row.location_confidence || "unknown");
  const status = String(row.status || "ok");
  return {
    id: String(row.id), conversationId: String(row.conversation_id),
    throughMessageCount: Number(row.through_message_count || 0),
    throughMessageId: row.through_message_id ? String(row.through_message_id) : null,
    throughMessageFingerprint: String(row.through_message_fingerprint || ""),
    provisional: Boolean(row.provisional),
    status: (status === "failed" ? "failed" : "ok") as SceneState["status"],
    storyDay: row.story_day == null ? null : Number(row.story_day),
    dateKind: (["exact","relative","unknown"].includes(dateKind) ? dateKind : "unknown") as SceneState["dateKind"],
    dateText: String(row.date_text || ""),
    timeOfDay: String(row.time_of_day || ""), timeText: String(row.time_text || ""),
    location: {
      place: String(row.location_place || ""), sub: String(row.location_sub || ""),
      confidence: (["stated","inferred","unknown"].includes(confidence) ? confidence : "unknown") as SceneState["location"]["confidence"],
    },
    presentCharacters: textArrayFromRow(row.present_characters),
    activeSituation: textArrayFromRow(row.active_situation),
    physical: physicalFromRow(row),
    changedFields: textArrayFromRow(row.changed_fields),
    extractionModel: String(row.extraction_model || ""), extractionProvider: String(row.extraction_provider || ""),
    extractionLatencyMs: Number(row.extraction_latency_ms || 0), failureReason: String(row.failure_reason || ""),
    tokenCount: Number(row.token_count || 0), version: Number(row.version || 1),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
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
