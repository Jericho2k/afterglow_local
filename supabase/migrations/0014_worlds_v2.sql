-- Worlds V2: saving, comments, and public discovery.
--
-- Worlds already had everything needed to be first-class — their own table,
-- their own owner, their own cover art and the same three-value visibility
-- enum characters use. What they never had was anywhere to be found, anything
-- to be saved into, or anywhere to be discussed. This migration adds those
-- three, and nothing else: no column is dropped, no policy is loosened, and no
-- existing world changes meaning.
--
-- The save and comment tables deliberately mirror `character_likes` and
-- `character_comments` rather than replacing them with one polymorphic table.
-- Those two carry a SECURITY DEFINER counter trigger, a composite primary key
-- and a foreign key straight into `characters`; making them generic would mean
-- rewriting a working, load-bearing relation for tidiness. The application
-- layer is where the two are shared — one save helper, one comment route —
-- which is where sharing costs nothing.

-- ---------------------------------------------------------------------------
-- Saves
-- ---------------------------------------------------------------------------

ALTER TABLE worlds ADD COLUMN IF NOT EXISTS save_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS world_saves (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, world_id)
);

CREATE INDEX IF NOT EXISTS world_saves_user_idx ON world_saves (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS world_saves_world_idx ON world_saves (world_id);

ALTER TABLE world_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_saves FORCE ROW LEVEL SECURITY;

-- A save row is the saving account's own business. The public total is a
-- column on `worlds`, maintained by the trigger below, so nobody needs — or
-- gets — the ability to enumerate who saved what.
DROP POLICY IF EXISTS world_saves_all_own ON world_saves;
CREATE POLICY world_saves_all_own ON world_saves
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- SECURITY DEFINER for the same reason the character counter is: the account
-- saving a world is almost never the account that owns it, and it must be able
-- to move the public total without being able to write the owner's row.
CREATE OR REPLACE FUNCTION public.refresh_world_save_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_world_id uuid;
BEGIN
  target_world_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.world_id ELSE NEW.world_id END;
  IF target_world_id IS NOT NULL THEN
    UPDATE worlds SET save_count = (SELECT count(*) FROM world_saves WHERE world_id = target_world_id)
    WHERE id = target_world_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS world_save_count_trigger ON world_saves;
CREATE TRIGGER world_save_count_trigger
  AFTER INSERT OR DELETE ON world_saves
  FOR EACH ROW EXECUTE FUNCTION public.refresh_world_save_count();

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS world_comments (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES world_comments(id) ON DELETE CASCADE,
  body text NOT NULL,
  like_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS world_comments_world_idx ON world_comments (world_id, created_at DESC);

DO $$ BEGIN
  ALTER TABLE world_comments ADD CONSTRAINT world_comments_body_bounded CHECK (char_length(body) BETWEEN 1 AND 2000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE world_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_comments FORCE ROW LEVEL SECURITY;

-- Readable exactly where the world is readable, which is the same rule
-- character comments follow. A private world's discussion is as private as its
-- lore.
DROP POLICY IF EXISTS world_comments_select ON world_comments;
CREATE POLICY world_comments_select ON world_comments
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM worlds w
    WHERE w.id = world_comments.world_id
      AND (w.user_id = auth.uid() OR w.visibility IN ('public', 'unlisted'))
  ));

DROP POLICY IF EXISTS world_comments_insert_own ON world_comments;
CREATE POLICY world_comments_insert_own ON world_comments
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM worlds w
    WHERE w.id = world_comments.world_id
      AND (w.user_id = auth.uid() OR w.visibility IN ('public', 'unlisted'))
  ));

DROP POLICY IF EXISTS world_comments_update_own ON world_comments;
CREATE POLICY world_comments_update_own ON world_comments
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS world_comments_delete_own_or_world_owner ON world_comments;
CREATE POLICY world_comments_delete_own_or_world_owner ON world_comments
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM worlds w WHERE w.id = world_comments.world_id AND w.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- Discovery
-- ---------------------------------------------------------------------------

-- Partial, like the character feed's indexes: world discovery reads published
-- rows only, so the index carries only published rows.
CREATE INDEX IF NOT EXISTS worlds_public_saved_idx
  ON worlds (save_count DESC, updated_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS worlds_public_new_idx
  ON worlds (created_at DESC, id DESC)
  WHERE visibility = 'public';

GRANT SELECT, INSERT, UPDATE, DELETE ON world_saves, world_comments TO authenticated;
