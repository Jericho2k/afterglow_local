-- Memory Retrieval V2 is additive. memories and memory_arcs remain the durable
-- source of truth; canon, vectors and retrieval runs are derived layers.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO authenticated;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_curated_message_count integer NOT NULL DEFAULT 0;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS canon_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS core_canon_entries (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
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

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id uuid PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  embedding extensions.vector(1024) NOT NULL,
  embedding_model text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_arc_embeddings (
  arc_id uuid PRIMARY KEY REFERENCES memory_arcs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  embedding extensions.vector(1024) NOT NULL,
  embedding_model text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_retrieval_runs (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
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

-- A single database lease per conversation prevents two Railway workers from
-- consolidating/curating the same story at once. Expired leases are stealable.
CREATE TABLE IF NOT EXISTS memory_job_leases (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  job_type text NOT NULL,
  lease_token uuid NOT NULL,
  locked_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The application can create the non-vector shell tables during startup on a
-- plain PostgreSQL database. Tighten those shells when this migration follows.
ALTER TABLE core_canon_entries ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE memory_retrieval_runs ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE memory_job_leases ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE core_canon_entries ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE memory_retrieval_runs ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE memory_job_leases ALTER COLUMN user_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE core_canon_entries ADD CONSTRAINT core_canon_user_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE memory_retrieval_runs ADD CONSTRAINT memory_retrieval_runs_user_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE memory_job_leases ADD CONSTRAINT memory_job_leases_user_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE core_canon_entries ADD CONSTRAINT core_canon_status_allowed
    CHECK (status IN ('active','superseded','demoted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE memory_job_leases ADD CONSTRAINT memory_job_type_allowed
    CHECK (job_type IN ('consolidation','curation','embedding_backfill'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS core_canon_conversation_idx
  ON core_canon_entries(user_id,conversation_id,status,importance DESC);
CREATE INDEX IF NOT EXISTS memory_retrieval_runs_conversation_idx
  ON memory_retrieval_runs(user_id,conversation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS memory_embeddings_vector_idx
  ON memory_embeddings USING hnsw (embedding extensions.vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memory_arc_embeddings_vector_idx
  ON memory_arc_embeddings USING hnsw (embedding extensions.vector_cosine_ops);

ALTER TABLE core_canon_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_canon_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_arc_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_arc_embeddings FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_retrieval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_retrieval_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_job_leases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS core_canon_entries_all_own ON core_canon_entries;
CREATE POLICY core_canon_entries_all_own ON core_canon_entries
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
DROP POLICY IF EXISTS memory_embeddings_all_own ON memory_embeddings;
CREATE POLICY memory_embeddings_all_own ON memory_embeddings
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
DROP POLICY IF EXISTS memory_arc_embeddings_all_own ON memory_arc_embeddings;
CREATE POLICY memory_arc_embeddings_all_own ON memory_arc_embeddings
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
DROP POLICY IF EXISTS memory_retrieval_runs_all_own ON memory_retrieval_runs;
CREATE POLICY memory_retrieval_runs_all_own ON memory_retrieval_runs
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
DROP POLICY IF EXISTS memory_job_leases_all_own ON memory_job_leases;
CREATE POLICY memory_job_leases_all_own ON memory_job_leases
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());

GRANT SELECT,INSERT,UPDATE,DELETE ON
  core_canon_entries,memory_embeddings,memory_arc_embeddings,memory_job_leases
TO authenticated;
GRANT SELECT,INSERT ON memory_retrieval_runs TO authenticated;

DO $$ BEGIN
  ALTER TABLE core_canon_entries ADD CONSTRAINT core_canon_conversation_owner_fkey
    FOREIGN KEY (conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_arc_embeddings ADD CONSTRAINT memory_arc_embeddings_conversation_owner_fkey
    FOREIGN KEY (conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_retrieval_runs ADD CONSTRAINT memory_retrieval_runs_conversation_owner_fkey
    FOREIGN KEY (conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_job_leases ADD CONSTRAINT memory_job_leases_conversation_owner_fkey
    FOREIGN KEY (conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
