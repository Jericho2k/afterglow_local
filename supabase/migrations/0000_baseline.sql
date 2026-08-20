-- Afterglow baseline schema.
--
-- Mirrors the tables the application created at runtime before the Supabase
-- migration, so a brand new project reaches the same starting point that the
-- existing Railway database is already at. Applying this to a database that
-- already holds data is a no-op.
--
-- The multi-tenant columns, constraints and row level security live in
-- 0001_multi_tenant_foundation.sql, which is applied on top of this file.

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

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation',
  summary text NOT NULL DEFAULT '',
  persona_id uuid REFERENCES personas(id) ON DELETE SET NULL,
  provider_id text NOT NULL DEFAULT 'deepseek',
  model_id text NOT NULL DEFAULT 'deepseek-v4-flash',
  rp_engine_id text NOT NULL DEFAULT 'immersive',
  instruction_presets text[] NOT NULL DEFAULT '{}',
  custom_instructions text NOT NULL DEFAULT '',
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
CREATE INDEX IF NOT EXISTS memories_conversation_status_idx ON memories(conversation_id, status, kind);

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
  provider_id text NOT NULL DEFAULT 'deepseek',
  rp_engine_id text NOT NULL DEFAULT 'immersive',
  funding_source text NOT NULL DEFAULT 'afterglow',
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
  provider_id text NOT NULL DEFAULT 'deepseek',
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

INSERT INTO app_settings (id) VALUES ('owner') ON CONFLICT (id) DO NOTHING;
