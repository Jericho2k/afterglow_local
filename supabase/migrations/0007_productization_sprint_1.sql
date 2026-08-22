-- Productization Sprint 1 preferences and branch request idempotency.
-- All changes are additive so existing conversations continue to inherit the
-- same account-level behavior they had before this migration.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS response_length text NOT NULL DEFAULT 'natural';
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS response_length text NOT NULL DEFAULT 'natural';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS response_length text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS temperature double precision;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS branch_request_id uuid;

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS response_length text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS ttft_ms integer;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS upstream_provider text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS authored_event_id uuid;
UPDATE messages SET authored_event_id=id WHERE role='user' AND authored_event_id IS NULL;

DO $$ BEGIN
  ALTER TABLE user_settings ADD CONSTRAINT user_settings_response_length_allowed
    CHECK (response_length IN ('concise','natural','detailed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE app_settings ADD CONSTRAINT app_settings_response_length_allowed
    CHECK (response_length IN ('concise','natural','detailed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_response_length_allowed
    CHECK (response_length IS NULL OR response_length IN ('concise','natural','detailed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_temperature_allowed
    CHECK (temperature IS NULL OR (temperature >= 0 AND temperature <= 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_branch_request_idx
  ON conversations (user_id,branch_request_id);
