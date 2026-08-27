-- Physical continuity inside Scene State.
--
-- Scene State already answers where, when and who. It does not answer HOW THE
-- BODIES ARE ARRANGED, and that is the gap the sprint reports: during intimacy,
-- fights, grappling, dancing, carrying, hugging and anything on a bed or a
-- couch, models reliably produce configurations that are impossible — a hand in
-- two places, someone standing who was just lying down, a character holding
-- something they put down four replies ago. It happens across essentially every
-- model because nothing in the request carries the arrangement forward.
--
-- So three columns, all additive, all defaulting to empty:
--
--   physical_actors      one JSON object per character with a tracked body.
--   physical_contacts    the points where people are actually touching.
--   physical_constraints what the space imposes: furniture, walls, restraints.
--
-- Empty means UNKNOWN, and unknown is both the default and a correct answer.
-- Every row written before this migration therefore reads exactly as it should:
-- a scene where nothing about the bodies was ever recorded. Nothing is
-- back-filled, because there is nothing to back-fill from — inventing an
-- arrangement for a historical scene is precisely the failure this exists to
-- prevent.
--
-- `physical_actors` is jsonb rather than a table of its own on purpose. It is
-- read and written as one value with the rest of the scene, it is never queried
-- across conversations, and it inherits the row's lineage — the branch copy,
-- the regeneration drop and the edit invalidation all already move whole rows,
-- so the arrangement follows the scene it belongs to without a second lineage
-- to keep in step.

ALTER TABLE conversation_scene_states
  ADD COLUMN IF NOT EXISTS physical_actors jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE conversation_scene_states
  ADD COLUMN IF NOT EXISTS physical_contacts text[] NOT NULL DEFAULT '{}';
ALTER TABLE conversation_scene_states
  ADD COLUMN IF NOT EXISTS physical_constraints text[] NOT NULL DEFAULT '{}';

-- A malformed value can only ever come from a bug in the extractor path, and
-- the constraint is cheap: an array is the only shape anything reads.
DO $$ BEGIN
  ALTER TABLE conversation_scene_states ADD CONSTRAINT conversation_scene_states_physical_shape
    CHECK (jsonb_typeof(physical_actors) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
