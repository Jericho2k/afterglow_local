-- Repair: background_job_health had row level security and no policy.
--
-- THE PRODUCTION ERROR, verbatim:
--
--   [background-health] could not record a success
--   new row violates row-level security policy for table "background_job_health"
--   code 42501
--
-- REPRODUCED, NOT GUESSED. Against a real PostgreSQL with the shipped
-- migrations and the exact session `asUser()` opens — `BEGIN; SET LOCAL ROLE
-- authenticated; set_config('request.jwt.claims', …)` — the three reachable
-- schema states give three different answers:
--
--   A. table created, RLS off, no grant       → "permission denied for table"
--   B. table created, RLS ON, granted,        → "new row violates row-level
--      NO POLICY                                 security policy" ← PRODUCTION
--   C. migration 0033 applied in full          → INSERT OK
--
-- So `auth.uid()` was never the problem: inside that transaction it evaluates
-- to the account id correctly, and state C proves the 0033 policy works exactly
-- as written. What production actually had was state B.
--
-- HOW A DATABASE REACHES STATE B. `ensureSchema()` in src/lib/db.ts creates
-- this table on every boot, because the application must be able to stand up a
-- plain PostgreSQL. `supabase/migrations` is applied BY HAND (see README). So a
-- deploy creates the table before anybody runs 0033 — and on a Supabase project,
-- where new public tables inherit grants to `authenticated` and RLS is enabled
-- for exposed tables, that lands precisely on "granted, protected, and no
-- policy": every write refused, including the server's own.
--
-- Nothing here disables RLS, drops FORCE, or introduces a service-role bypass.
-- The policy is the fix; its absence was the bug.
--
-- IDEMPOTENT AND ADDITIVE. If 0033 was applied this file re-asserts what is
-- already true. If it was not, this file completes it. Either way it is safe to
-- run again, which is what a repair migration has to be — production history is
-- not edited.

-- ---------------------------------------------------------------------------
-- The table, in case 0033 never ran at all.
-- ---------------------------------------------------------------------------
--
-- Deliberately repeated rather than assumed: a database in state B has the
-- table `ensureSchema()` made, which carries no foreign key to `auth.users`.
-- The columns are identical either way, so this is a no-op on a database that
-- has 0033 and the missing piece on one that does not.
CREATE TABLE IF NOT EXISTS background_job_health (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  task text NOT NULL,
  last_success_at timestamptz,
  last_success_model text NOT NULL DEFAULT '',
  last_success_candidate text,
  last_success_used_fallback boolean NOT NULL DEFAULT false,
  last_failure_at timestamptz,
  last_failure_model text NOT NULL DEFAULT '',
  last_failure_candidate text,
  last_failure_reason text NOT NULL DEFAULT '',
  consecutive_failures integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, task)
);

CREATE INDEX IF NOT EXISTS background_job_health_user_idx
  ON background_job_health (user_id, conversation_id);

-- ---------------------------------------------------------------------------
-- Access, re-asserted.
-- ---------------------------------------------------------------------------
--
-- The order matters on a database in state B: the policy has to exist before
-- the next write, and enabling RLS without one is exactly the state being
-- repaired. FORCE stays on — it is what makes the table owner subject to its own
-- policy, and dropping it to make an error go away would be removing the guard
-- rather than fixing it.
ALTER TABLE background_job_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_job_health FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS background_job_health_all_own ON background_job_health;
CREATE POLICY background_job_health_all_own ON background_job_health
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON background_job_health TO authenticated;

-- The browser roles get nothing beyond that policy, and `anon` gets nothing at
-- all: a signed-out visitor has no memory jobs to have health about.
REVOKE ALL ON background_job_health FROM anon;

-- ---------------------------------------------------------------------------
-- The constraints 0033 declared, in case it never ran.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE background_job_health ADD CONSTRAINT background_job_health_task_allowed
    CHECK (task IN ('memory_consolidation', 'memory_curation', 'scene_state'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE background_job_health ADD CONSTRAINT background_job_health_counts_sane
    CHECK (consecutive_failures >= 0 AND length(last_failure_reason) <= 60);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
