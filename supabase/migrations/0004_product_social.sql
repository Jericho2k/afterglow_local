-- Public-product primitives: creator profiles, favorites, and reporting.

ALTER TABLE characters ADD COLUMN IF NOT EXISTS like_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS character_likes (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, character_id)
);

CREATE TABLE IF NOT EXISTS character_reports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
  reason text NOT NULL,
  details text NOT NULL DEFAULT '',
  character_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE character_reports ADD CONSTRAINT character_reports_reason_allowed
    CHECK (reason IN ('underage','nonconsensual','real_person','stolen','harassment','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE character_reports ADD CONSTRAINT character_reports_status_allowed
    CHECK (status IN ('pending','reviewing','resolved','dismissed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS character_likes_user_idx ON character_likes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS character_reports_user_idx ON character_reports (user_id, created_at DESC);

ALTER TABLE character_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_likes FORCE ROW LEVEL SECURITY;
ALTER TABLE character_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_reports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS character_likes_all_own ON character_likes;
CREATE POLICY character_likes_all_own ON character_likes
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS character_reports_select_own ON character_reports;
CREATE POLICY character_reports_select_own ON character_reports
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS character_reports_insert_own ON character_reports;
CREATE POLICY character_reports_insert_own ON character_reports
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() AND status = 'pending');

-- A username is the creator's explicit opt-in to a public creator profile.
DROP POLICY IF EXISTS profiles_select_own ON profiles;
DROP POLICY IF EXISTS profiles_select_own_or_public ON profiles;
CREATE POLICY profiles_select_own_or_public ON profiles
  FOR SELECT TO authenticated USING (id = auth.uid() OR username IS NOT NULL);

CREATE OR REPLACE FUNCTION public.refresh_character_like_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_character_id uuid;
BEGIN
  target_character_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.character_id ELSE NEW.character_id END;
  UPDATE characters
  SET like_count = (SELECT count(*) FROM character_likes WHERE character_id = target_character_id)
  WHERE id = target_character_id;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS character_like_count_trigger ON character_likes;
CREATE TRIGGER character_like_count_trigger
  AFTER INSERT OR DELETE ON character_likes
  FOR EACH ROW EXECUTE FUNCTION public.refresh_character_like_count();

GRANT SELECT, INSERT, DELETE ON character_likes TO authenticated;
GRANT SELECT, INSERT ON character_reports TO authenticated;
