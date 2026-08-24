-- Scene State / Temporal Continuity.
--
-- Additive and backward compatible. Memory V2 remains the retrieval system;
-- this layer only records where/when/who/what is happening NOW, and stamps a
-- little of that grounding onto memories and arcs so a retrieved historical
-- event can be presented as THEN rather than as current state.
--
-- Lineage is the integer message position already used by
-- memories.source_message_count and memory_arcs.end_message_count, so branch
-- copying and edit/rewind invalidation reuse the existing semantics exactly.

CREATE TABLE IF NOT EXISTS conversation_scene_states (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
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
  present_characters text[] NOT NULL DEFAULT '{}',
  active_situation text[] NOT NULL DEFAULT '{}',
  changed_fields text[] NOT NULL DEFAULT '{}',
  extraction_model text NOT NULL DEFAULT '',
  extraction_provider text NOT NULL DEFAULT '',
  extraction_latency_ms integer NOT NULL DEFAULT 0,
  failure_reason text NOT NULL DEFAULT '',
  token_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The application can create the shell table during startup on a plain
-- PostgreSQL database. Tighten it when this migration follows.
ALTER TABLE conversation_scene_states ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE conversation_scene_states ALTER COLUMN user_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE conversation_scene_states ADD CONSTRAINT conversation_scene_states_user_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE conversation_scene_states ADD CONSTRAINT conversation_scene_states_conversation_owner_fkey
    FOREIGN KEY (conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE conversation_scene_states ADD CONSTRAINT conversation_scene_states_status_allowed
    CHECK (status IN ('ok','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE conversation_scene_states ADD CONSTRAINT conversation_scene_states_date_kind_allowed
    CHECK (date_kind IN ('exact','relative','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE conversation_scene_states ADD CONSTRAINT conversation_scene_states_location_confidence_allowed
    CHECK (location_confidence IN ('stated','inferred','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per lineage position. A retry at the same position replaces it.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_scene_states_position_idx
  ON conversation_scene_states (conversation_id,through_message_count);
CREATE INDEX IF NOT EXISTS conversation_scene_states_current_idx
  ON conversation_scene_states (user_id,conversation_id,through_message_count DESC);

ALTER TABLE conversation_scene_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_scene_states FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_scene_states_all_own ON conversation_scene_states;
CREATE POLICY conversation_scene_states_all_own ON conversation_scene_states
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());

GRANT SELECT,INSERT,UPDATE,DELETE ON conversation_scene_states TO authenticated;

-- Lightweight historical grounding on the archive itself. Every column is
-- nullable/empty by default: memories written before this release keep no
-- scene metadata and are presented without a chronology tag rather than being
-- back-dated by guesswork.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS scene_story_day integer;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS scene_time_of_day text NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS scene_location text NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS scene_present text[] NOT NULL DEFAULT '{}';

ALTER TABLE memory_arcs ADD COLUMN IF NOT EXISTS story_day_start integer;
ALTER TABLE memory_arcs ADD COLUMN IF NOT EXISTS story_day_end integer;
ALTER TABLE memory_arcs ADD COLUMN IF NOT EXISTS scene_locations text[] NOT NULL DEFAULT '{}';

-- Scene extraction takes the same per-conversation lease as the other
-- maintenance jobs, so two workers cannot extract the same turn twice.
ALTER TABLE memory_job_leases DROP CONSTRAINT IF EXISTS memory_job_type_allowed;
ALTER TABLE memory_job_leases ADD CONSTRAINT memory_job_type_allowed
  CHECK (job_type IN ('consolidation','curation','embedding_backfill','scene_state'));
