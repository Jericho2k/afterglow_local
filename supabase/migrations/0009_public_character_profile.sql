-- Public character profile enrichment.
--
-- Everything here is optional. A character created through the simple flow has
-- no tags, no quick facts, no gallery and no world, and its public page is
-- simply shorter — the page hides sections rather than padding them with empty
-- placeholders. Existing characters keep working untouched.
--
-- The counters are denormalised on purpose. Global "how many people chat with
-- this character" cannot be computed from conversations at read time, because
-- row level security correctly hides other accounts' rows. Maintaining them
-- with SECURITY DEFINER triggers keeps the aggregate public while the
-- underlying stories stay private, following the existing like_count pattern.

-- ---------------------------------------------------------------------------
-- Creator-configurable public fields
-- ---------------------------------------------------------------------------

ALTER TABLE characters ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
-- Ordered [{ "label": "Age", "value": "24" }]. Generic on purpose: the six
-- labels the design shows are a starting set, not a fixed schema.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS quick_facts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS chat_count integer NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_tags_bounded CHECK (array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_quick_facts_bounded
    CHECK (jsonb_typeof(quick_facts) = 'array' AND jsonb_array_length(quick_facts) <= 6);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS characters_tags_idx ON characters USING gin (tags);

-- Worlds become first-class public objects with their own page, so they need
-- their own cover art rather than borrowing a character's.
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS cover_path text NOT NULL DEFAULT '';
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS cover_url text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- Gallery
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS character_gallery (
  id uuid PRIMARY KEY,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path text NOT NULL DEFAULT '',
  external_url text NOT NULL DEFAULT '',
  caption text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS character_gallery_character_idx ON character_gallery (character_id, position, created_at);

-- A gallery row must belong to the same account as its character, enforced by
-- the database rather than by the route that happens to write it.
DO $$ BEGIN
  ALTER TABLE character_gallery ADD CONSTRAINT character_gallery_owner_fkey
    FOREIGN KEY (character_id, user_id) REFERENCES characters (id, user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE character_gallery ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_gallery FORCE ROW LEVEL SECURITY;

-- Readable wherever the character itself is readable; writable only by its owner.
DROP POLICY IF EXISTS character_gallery_select ON character_gallery;
CREATE POLICY character_gallery_select ON character_gallery
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM characters c
    WHERE c.id = character_gallery.character_id
      AND (c.user_id = auth.uid() OR c.visibility IN ('public', 'unlisted'))
  ));

DROP POLICY IF EXISTS character_gallery_write_own ON character_gallery;
CREATE POLICY character_gallery_write_own ON character_gallery
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Comments
--
-- Social comments, not star reviews. Threading is left for later, but the
-- self-referencing parent column exists now so replies do not need a rewrite.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS character_comments (
  id uuid PRIMARY KEY,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES character_comments(id) ON DELETE CASCADE,
  body text NOT NULL,
  like_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS character_comments_character_idx ON character_comments (character_id, created_at DESC);

DO $$ BEGIN
  ALTER TABLE character_comments ADD CONSTRAINT character_comments_body_bounded CHECK (char_length(body) BETWEEN 1 AND 2000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE character_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_comments FORCE ROW LEVEL SECURITY;

-- Comments are public where the character is public. Authors may edit and
-- delete their own; the character's owner may also remove one from their page.
DROP POLICY IF EXISTS character_comments_select ON character_comments;
CREATE POLICY character_comments_select ON character_comments
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM characters c
    WHERE c.id = character_comments.character_id
      AND (c.user_id = auth.uid() OR c.visibility IN ('public', 'unlisted'))
  ));

DROP POLICY IF EXISTS character_comments_insert_own ON character_comments;
CREATE POLICY character_comments_insert_own ON character_comments
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM characters c
    WHERE c.id = character_comments.character_id
      AND (c.user_id = auth.uid() OR c.visibility IN ('public', 'unlisted'))
  ));

DROP POLICY IF EXISTS character_comments_update_own ON character_comments;
CREATE POLICY character_comments_update_own ON character_comments
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS character_comments_delete_own_or_character_owner ON character_comments;
CREATE POLICY character_comments_delete_own_or_character_owner ON character_comments
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM characters c WHERE c.id = character_comments.character_id AND c.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- Public counters
--
-- SECURITY DEFINER because the writer is rarely the character's owner: a
-- reader starting a chat with somebody else's published character must still
-- move that character's public total, without being able to see or touch the
-- owner's rows themselves.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_character_chat_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_character_id uuid;
BEGIN
  target_character_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.character_id ELSE NEW.character_id END;
  IF target_character_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  UPDATE characters
  SET chat_count = (SELECT count(*) FROM conversations WHERE character_id = target_character_id)
  WHERE id = target_character_id;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS character_chat_count_trigger ON conversations;
CREATE TRIGGER character_chat_count_trigger
  AFTER INSERT OR DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.refresh_character_chat_count();

-- Messages are counted incrementally rather than recounted: a busy character
-- would otherwise rescan its entire history on every single reply.
CREATE OR REPLACE FUNCTION public.bump_character_message_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_character_id uuid;
BEGIN
  SELECT character_id INTO target_character_id FROM conversations WHERE id = NEW.conversation_id;
  IF target_character_id IS NOT NULL THEN
    UPDATE characters SET message_count = message_count + 1 WHERE id = target_character_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS character_message_count_trigger ON messages;
CREATE TRIGGER character_message_count_trigger
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_character_message_count();

-- Backfill so existing characters do not read as brand new.
UPDATE characters c
SET chat_count = COALESCE((SELECT count(*) FROM conversations v WHERE v.character_id = c.id), 0),
    message_count = COALESCE((
      SELECT count(*) FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.character_id = c.id
    ), 0)
WHERE c.chat_count = 0 AND c.message_count = 0;

GRANT SELECT, INSERT, UPDATE, DELETE ON character_gallery, character_comments TO authenticated;
