-- Writer-only BYOK and creation moderation.

CREATE TABLE IF NOT EXISTS user_provider_credentials (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  key_suffix text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  validated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  CONSTRAINT user_provider_credentials_provider CHECK (provider IN ('openrouter')),
  CONSTRAINT user_provider_credentials_suffix CHECK (key_suffix ~ '^[A-Za-z0-9_-]{4}$')
);

ALTER TABLE user_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_provider_credentials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON user_provider_credentials FROM anon, authenticated;

ALTER TABLE characters ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'active';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS moderated_at timestamptz;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS moderated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS moderation_reason text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS pre_moderation_visibility text;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_moderation_status_allowed
    CHECK (moderation_status IN ('active','removed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_pre_moderation_visibility_allowed
    CHECK (pre_moderation_visibility IS NULL OR pre_moderation_visibility IN ('private','unlisted','public'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_removed_is_private
    CHECK (moderation_status='active' OR visibility='private');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Removed rows stay owner-readable but cannot be changed or republished by the
-- creator. Moderators use a separately authorised privileged server path.
DROP POLICY IF EXISTS characters_select_own_or_published ON characters;
CREATE POLICY characters_select_own_or_published ON characters
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR (moderation_status='active' AND visibility IN ('public','unlisted')));

DROP POLICY IF EXISTS characters_update_own ON characters;
CREATE POLICY characters_update_own ON characters
  FOR UPDATE TO authenticated
  USING (user_id=auth.uid() AND moderation_status='active')
  WITH CHECK (user_id=auth.uid() AND moderation_status='active'
    AND moderated_at IS NULL AND moderated_by IS NULL
    AND moderation_reason='' AND pre_moderation_visibility IS NULL);

DROP POLICY IF EXISTS characters_delete_own ON characters;
CREATE POLICY characters_delete_own ON characters
  FOR DELETE TO authenticated USING (user_id=auth.uid() AND moderation_status='active');

ALTER TABLE character_reports ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE character_reports ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE character_reports DROP CONSTRAINT IF EXISTS character_reports_reason_allowed;
ALTER TABLE character_reports ADD CONSTRAINT character_reports_reason_allowed
  CHECK (reason IN ('underage','real_person','stolen','other','nonconsensual','harassment'));

CREATE UNIQUE INDEX IF NOT EXISTS character_reports_one_active_idx
  ON character_reports (user_id, character_id)
  WHERE status IN ('pending','reviewing') AND character_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS character_reports_queue_idx
  ON character_reports (reason, created_at DESC)
  WHERE status IN ('pending','reviewing');

-- Reporters can submit but cannot inspect moderation state or legacy reasons.
DROP POLICY IF EXISTS character_reports_select_own ON character_reports;
DROP POLICY IF EXISTS character_reports_insert_own ON character_reports;
REVOKE ALL ON character_reports FROM authenticated;

CREATE TABLE IF NOT EXISTS character_report_evidence (
  report_id uuid PRIMARY KEY REFERENCES character_reports(id) ON DELETE CASCADE,
  character_id uuid,
  creator_user_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE character_report_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_report_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON character_report_evidence FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS moderation_actions (
  id uuid PRIMARY KEY,
  character_id uuid,
  -- Identifiers are retained even if the referenced account/report later goes
  -- away; foreign-key cleanup would mutate an immutable audit row.
  report_id uuid,
  moderator_user_id uuid NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_actions_action_allowed CHECK
    (action IN ('mark_reviewing','dismiss','resolve_no_removal','remove_creation','restore_creation'))
);
CREATE INDEX IF NOT EXISTS moderation_actions_character_idx ON moderation_actions(character_id,created_at DESC);
ALTER TABLE moderation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_actions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON moderation_actions FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.prevent_moderation_action_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation_actions_is_immutable';
END;
$$;
DROP TRIGGER IF EXISTS moderation_actions_immutable_update ON moderation_actions;
CREATE TRIGGER moderation_actions_immutable_update BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_moderation_action_mutation();

-- Restoration is an administrative correction, not a new publication.
CREATE OR REPLACE FUNCTION public.announce_published_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('afterglow.suppress_publish_notification', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.moderation_status <> 'active' OR NEW.visibility <> 'public' OR NEW.published_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.visibility = 'public' AND OLD.published_at IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM public.ensure_public_username(NEW.user_id);
  PERFORM public.fanout_creation_notifications(NEW.id);
  RETURN NEW;
END;
$$;
