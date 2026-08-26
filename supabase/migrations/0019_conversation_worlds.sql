-- Worlds belong to a STORY, not only to a Creation.
--
-- The semantics this fixes are the sprint's, and they are worth stating
-- plainly: a Creation is authored once, and a story evolves away from it.
-- Attaching "Night City" inside one conversation must not push Night City into
-- the Creation itself, into every other reader's story, or into the creator's
-- published canon — which is exactly what happened, because there was nowhere
-- else for the attachment to live. The chat's world picker read
-- `characters.world_ids`, wrote them back through `PATCH /api/characters/{id}`,
-- and that endpoint rewrites `character_worlds`.
--
-- So a conversation gets its own world set. `character_worlds` is untouched and
-- keeps meaning what it has always meant: the creator's DEFAULTS, edited in the
-- studio, shown on the creation page, and copied into a story when the story
-- begins.
--
-- Everything here is additive and idempotent.

-- ---------------------------------------------------------------------------
-- The relation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_worlds (
  conversation_id uuid NOT NULL,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  -- Denormalised deliberately. `character_worlds` has no owner column and
  -- therefore needs an EXISTS subquery in every policy; a conversation's world
  -- set has exactly one owner, so the policy is a column comparison and the
  -- composite foreign key below makes the denormalisation impossible to get
  -- wrong — a row can only name a conversation that this same account owns.
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, world_id)
);

ALTER TABLE conversation_worlds ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE conversation_worlds ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  ALTER TABLE conversation_worlds ADD CONSTRAINT conversation_worlds_user_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The composite key is the real guarantee: a world can only be attached to a
-- conversation by the account that owns that conversation, enforced by the
-- database rather than by the route that happens to write it.
DO $$ BEGIN
  ALTER TABLE conversation_worlds ADD CONSTRAINT conversation_worlds_conversation_owner_fkey
    FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS conversation_worlds_conversation_idx
  ON conversation_worlds (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS conversation_worlds_world_idx
  ON conversation_worlds (world_id);

ALTER TABLE conversation_worlds ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_worlds FORCE ROW LEVEL SECURITY;

-- A story's world set is as private as the story. There is no published form
-- of it, and no other account may read, add or remove one.
DROP POLICY IF EXISTS conversation_worlds_all_own ON conversation_worlds;
CREATE POLICY conversation_worlds_all_own ON conversation_worlds
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    -- Attach only worlds this account may actually read. Row level security on
    -- `worlds` says the same thing on the way out; saying it again on the way
    -- IN means a private world cannot be linked into a prompt at all, rather
    -- than being linked and then filtered.
    AND EXISTS (
      SELECT 1 FROM worlds w
      WHERE w.id = conversation_worlds.world_id
        AND (w.user_id = auth.uid() OR w.visibility IN ('public', 'unlisted'))
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_worlds TO authenticated;

-- ---------------------------------------------------------------------------
-- Snapshot state
-- ---------------------------------------------------------------------------
--
-- Without this flag an empty world set is ambiguous: it could mean "this story
-- deliberately has no worlds" or "this story has never been given one". The
-- first must stay empty forever; the second is what a pre-migration
-- conversation looks like. One boolean settles it, and detaching the last world
-- from a story is therefore a decision the product remembers.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS worlds_initialized boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
--
-- The rule is CONSERVATIVE ON PURPOSE: reproduce the set each existing story
-- was already being written with, and nothing more. Before this migration the
-- chat route loaded worlds only when the creation was the caller's own, and
-- only worlds the caller themselves owned:
--
--   SELECT w.* FROM worlds w JOIN character_worlds cw ON cw.world_id = w.id
--   WHERE cw.character_id = $1 AND w.user_id = $2
--
-- so that is exactly what is copied. Three things follow, and all three are
-- wanted:
--
--   NO RUNNING STORY CHANGES. Every conversation keeps the canon it has been
--   written with, byte for byte, on its next reply.
--
--   NOTHING LEAKS. A world this account cannot read is not selected, so the
--   backfill cannot introduce another creator's private lore into a prompt it
--   was never in. A creation belonging to somebody else contributes nothing,
--   which is also its current behaviour.
--
--   THE INHERITANCE STOPS. Every existing conversation is marked initialized
--   below, whether or not it received any rows, so a creator changing their
--   Creation's worlds tomorrow no longer silently rewrites a long-running
--   story that started before the change.
INSERT INTO conversation_worlds (conversation_id, world_id, user_id)
SELECT v.id, w.id, v.user_id
FROM conversations v
JOIN characters c ON c.id = v.character_id AND c.user_id = v.user_id
JOIN character_worlds cw ON cw.character_id = c.id
JOIN worlds w ON w.id = cw.world_id AND w.user_id = v.user_id
WHERE v.worlds_initialized = false
ON CONFLICT (conversation_id, world_id) DO NOTHING;

UPDATE conversations SET worlds_initialized = true WHERE worlds_initialized = false;
