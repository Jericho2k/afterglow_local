-- Provenance that cannot quietly become untrue.
--
-- The inspector answers "what exact story context did the writer have when this
-- exact reply was produced". Three things stopped that answer from being
-- reliable, and all three are fixed here.
--
-- ONE ROW HELD ONE ANSWER FOR SEVERAL GENERATIONS. Regenerate keeps every
-- attempt as a variant of the SAME message row, and the provenance columns on
-- that row were overwritten by each new attempt. Selecting an older variant
-- showed the newest variant's context. `message_generations` is one immutable
-- row per actual generation, unique on (message_id, variant_index).
--
-- MEMORY TEXT COULD BE EDITED AFTERWARDS. A reader who rewords a memory changed
-- what every past reply claimed to have read. Versions are recorded on edit and
-- a generation stores the version it was given, so an old reply keeps resolving
-- to the text that was actually in its prompt.
--
-- TRANSCRIPT TEXT COULD BE EDITED AFTERWARDS. Same problem, same fix: message
-- ids alone were never enough, because message content is mutable through the
-- inline editor.
--
-- WHY VERSION ROWS HOLD THE SUPERSEDED TEXT RATHER THAN THE CURRENT TEXT.
-- The obvious shape is an append-only table where every version including the
-- current one has a row and the parent points at it. That is one extra row for
-- every memory and every message in the product, forever, to record an edit
-- that most of them never receive. Instead the parent row carries the CURRENT
-- text and a `content_version` counter, and an edit archives the version it
-- replaced. Resolution is exact either way: a recorded version equal to the
-- parent's counter is the parent's own text, and anything lower is in the
-- archive. Nothing is reconstructed and nothing is inferred.
--
-- WHAT IS NOT VERSIONED, AND WHY IT DOES NOT NEED TO BE.
--   Core Canon    content is never updated; supersession writes a new row and
--                 flips a status. Ids resolve truthfully on their own.
--   Scene State   append-only; a new observation is a new row.
--   Arcs          never updated after creation.
--   Rolling summary  overwritten on every consolidation, and therefore reported
--                 as presence and size only. Storing its text per generation
--                 would be the only honest alternative and it is not worth the
--                 bytes.

-- ---------------------------------------------------------------------------
-- Superseded text, kept so history stays legible.
-- ---------------------------------------------------------------------------

ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS memory_versions (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version integer NOT NULL,
  content text NOT NULL,
  kind text NOT NULL DEFAULT 'event',
  importance smallint NOT NULL DEFAULT 3,
  keywords text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memory_id, version)
);

CREATE TABLE IF NOT EXISTS message_versions (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version integer NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, version)
);

-- ---------------------------------------------------------------------------
-- One immutable row per writer generation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_generations (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  -- Which stored variant of that message this generation produced. Continue and
  -- an ordinary send always write variant 0 of a NEW message; only regenerate
  -- ever writes a second variant of an existing one.
  variant_index integer NOT NULL,
  action text NOT NULL DEFAULT 'send',
  -- [{ "id": uuid, "v": integer }] — the exact memory versions supplied.
  memory_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "id": uuid, "v": integer }] — the exact transcript turns supplied.
  transcript_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  arc_ids uuid[] NOT NULL DEFAULT '{}',
  canon_ids uuid[] NOT NULL DEFAULT '{}',
  scene_state_id uuid,
  retrieval_run_id uuid,
  transcript_messages integer NOT NULL DEFAULT 0,
  transcript_tokens integer NOT NULL DEFAULT 0,
  transcript_trimmed integer NOT NULL DEFAULT 0,
  summary_used boolean NOT NULL DEFAULT false,
  summary_characters integer NOT NULL DEFAULT 0,
  continuity_placement text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, variant_index)
);

DO $$ BEGIN
  ALTER TABLE message_generations ADD CONSTRAINT message_generations_action_allowed
    CHECK (action IN ('send','regenerate','continue'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS message_generations_owner_message_idx
  ON message_generations(user_id,message_id,variant_index);
CREATE INDEX IF NOT EXISTS memory_versions_owner_memory_idx
  ON memory_versions(user_id,memory_id,version);
CREATE INDEX IF NOT EXISTS message_versions_owner_message_idx
  ON message_versions(user_id,message_id,version);

-- ---------------------------------------------------------------------------
-- Owner-scoped, forced. A generation names memory ids, transcript ids and a
-- retrieval run; being able to read one for somebody else's story would leak
-- the shape of that story even without its text.
-- ---------------------------------------------------------------------------

ALTER TABLE message_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE message_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_generations_all_own ON message_generations;
CREATE POLICY message_generations_all_own ON message_generations
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
DROP POLICY IF EXISTS memory_versions_all_own ON memory_versions;
CREATE POLICY memory_versions_all_own ON memory_versions
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
DROP POLICY IF EXISTS message_versions_all_own ON message_versions;
CREATE POLICY message_versions_all_own ON message_versions
  FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());

GRANT SELECT,INSERT,UPDATE,DELETE ON
  message_generations,memory_versions,message_versions
  TO authenticated;
