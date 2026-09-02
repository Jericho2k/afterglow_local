-- Admin-owned background model routing, and the Scene Ledger reduced to what a
-- reply actually uses.
--
-- TWO CHANGES THAT LOOK UNRELATED AND ARE THE SAME CHANGE. Background inference
-- was expensive in two independent ways: the memory work ran on a route only a
-- deploy could change, so nobody could measure a cheaper one; and the Scene
-- State extractor carried the largest prompt in the whole background workload
-- to maintain a physical simulation of every character's limbs, once per
-- generated reply. This migration is the storage half of fixing both.
--
-- NOTHING HERE REWRITES HISTORY, and that is the invariant the whole sprint is
-- built on. No memory is regenerated, no summary re-extracted, no scene row
-- back-filled. Changing which model does the next piece of background work is
-- the only thing the routing table does, and the ledger columns are additive.

-- ---------------------------------------------------------------------------
-- Which model does the background work.
-- ---------------------------------------------------------------------------
--
-- WHY A TABLE RATHER THAN AN ENVIRONMENT VARIABLE. The question this answers is
-- not "what should the memory model be forever" but "run this one for a
-- fortnight and show me what it did to quality and to the bill". An A/B whose
-- smallest unit of change is a deploy is an A/B nobody runs, and the incumbent
-- therefore never gets challenged by anything but an argument.
--
-- WHAT IT DELIBERATELY CANNOT DO, on the same principle as curated_model_routes:
-- it cannot invent a model or name a slug. `candidate_id` refers to an entry in
-- src/lib/background-routing.ts that already exists in this build, and a row
-- naming something unknown is ignored rather than conjured into existence. The
-- environment routes remain underneath as the emergency lever that still works
-- when this table does not.
--
-- Deployment-global on purpose: one row per job, not one per account. A memory
-- extractor that varied by reader would make the quality comparison meaningless
-- and the cost report unattributable.
CREATE TABLE IF NOT EXISTS background_model_routes (
  task text PRIMARY KEY,
  candidate_id text NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE background_model_routes ADD CONSTRAINT background_model_routes_task_allowed
    CHECK (task IN ('memory_consolidation', 'memory_curation', 'scene_state'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Server-owned, like every other routing table here. A browser that could write
-- this could choose which model reads every reader's transcript.
ALTER TABLE background_model_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_model_routes NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON background_model_routes FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The per-conversation override.
-- ---------------------------------------------------------------------------
--
-- For a controlled side-by-side inside one story: same character, same engine,
-- same reader, different extractor. Null on every conversation by default,
-- which means "follow the global setting", and no reader-facing surface sets
-- them — the admin API is the only writer.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS memory_model_override text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS scene_model_override text;

-- ---------------------------------------------------------------------------
-- Scene Ledger Lite.
-- ---------------------------------------------------------------------------
--
-- `present_people` carries a rough position beside each name — "on the sofa",
-- "beside User", "near the window" — which is the part of the old physical
-- model a reply actually used. `time_kind` says how precise the stored time is,
-- so "around 9 PM" can be stored as what it is instead of being rounded up into
-- a clock reading the story never gave or down into a period that loses the
-- hour.
--
-- Both are additive and both read correctly for rows written before them: a row
-- with no `present_people` reads as its names with no positions, and a row with
-- no `time_kind` is read as exact when it has a `time_text` and as a period
-- when it has only a `time_of_day`. Nothing is back-filled and nothing is
-- promoted.
ALTER TABLE conversation_scene_states
  ADD COLUMN IF NOT EXISTS present_people jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE conversation_scene_states
  ADD COLUMN IF NOT EXISTS time_kind text NOT NULL DEFAULT '';

DO $$ BEGIN
  ALTER TABLE conversation_scene_states ADD CONSTRAINT conversation_scene_states_present_shape
    CHECK (jsonb_typeof(present_people) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE conversation_scene_states ADD CONSTRAINT conversation_scene_states_time_kind_allowed
    CHECK (time_kind IN ('', 'exact', 'approximate', 'period', 'relative', 'unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- The physical-simulation columns are RETAINED, EMPTY.
-- ---------------------------------------------------------------------------
--
-- `physical_actors`, `physical_contacts`, `physical_constraints` and
-- `active_situation` stop being written and stop being read as of this release.
-- They are deliberately not dropped.
--
-- Dropping them would make a rollback lossy — a deployment that reverts one
-- release would find the arrangement it used to hold gone rather than stale —
-- and they cost essentially nothing sitting at their defaults. A later release
-- can drop them once the reduction has held in production for long enough that
-- nobody wants the old ledger back; that is a decision with evidence behind it
-- rather than a tidy-up performed on the same day as the change.
