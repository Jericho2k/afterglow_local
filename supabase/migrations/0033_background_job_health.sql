-- Whether the background work actually happened.
--
-- THE FAILURE THIS EXISTS FOR. A reader chatted normally for a while and found
-- out much later that the conversation had NO MEMORIES. Every consolidation had
-- failed against an experimental route; every failure had been written to a
-- console nobody was watching; and the chat request — which is deliberately not
-- coupled to background work, and correctly so — was cheerful throughout.
--
-- THE USAGE LEDGER CANNOT ANSWER THIS, and that is not a gap in the ledger. A
-- `usage_events` row exists when a model ran and reported tokens. A run of empty
-- responses, a run of 429s, and a route that was never selectable all leave the
-- same trace there: none. Absence of evidence is indistinguishable from absence
-- of work, which is exactly the question an operator is asking.
--
-- So success and failure are BOTH recorded, per conversation and per job, with
-- the smallest set of facts that answers "is it working, when did it last work,
-- what broke, how many times in a row, and is the fallback carrying it".

CREATE TABLE IF NOT EXISTS background_job_health (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task text NOT NULL,

  last_success_at timestamptz,
  last_success_model text NOT NULL DEFAULT '',
  last_success_candidate text,
  -- Stored on the SUCCESS rather than on the failure it followed, because
  -- "memory is being written, but only because the control keeps rescuing the
  -- route you chose" is a different answer from "memory is being written".
  last_success_used_fallback boolean NOT NULL DEFAULT false,

  last_failure_at timestamptz,
  last_failure_model text NOT NULL DEFAULT '',
  last_failure_candidate text,
  -- A CATEGORY, NEVER A BODY. `empty_response`, `rate_limited`,
  -- `malformed_output`. This column is rendered in a browser, and the upstream
  -- text belongs in the server log where `ProviderError.diagnostic` puts it.
  -- Bounded so a future caller cannot turn it into a place to put a payload.
  last_failure_reason text NOT NULL DEFAULT '',

  -- Resets to zero on any success. The number an operator actually reads.
  consecutive_failures integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, task)
);

DO $$ BEGIN
  ALTER TABLE background_job_health ADD CONSTRAINT background_job_health_task_allowed
    CHECK (task IN ('memory_consolidation', 'memory_curation', 'scene_state'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE background_job_health ADD CONSTRAINT background_job_health_counts_sane
    CHECK (consecutive_failures >= 0 AND length(last_failure_reason) <= 60);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS background_job_health_user_idx
  ON background_job_health (user_id, conversation_id);

-- ---------------------------------------------------------------------------
-- Access.
-- ---------------------------------------------------------------------------
--
-- It carries a user_id and is read and written only through narrow,
-- user-scoped server SQL, exactly like the rest of a conversation's derived
-- state. The health of one account's memory jobs is that account's business.
ALTER TABLE background_job_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_job_health FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS background_job_health_all_own ON background_job_health;
CREATE POLICY background_job_health_all_own ON background_job_health
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());

GRANT SELECT,INSERT,UPDATE,DELETE ON background_job_health TO authenticated;
