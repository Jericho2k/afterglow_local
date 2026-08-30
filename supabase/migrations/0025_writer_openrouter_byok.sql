-- Complete and harden writer-only OpenRouter BYOK after migration 0024.
--
-- Migration 0024 also introduced creation moderation and an initial credential
-- relation. This additive follow-up preserves that work while standardising the
-- writer-funding preference and credential layout used by the server-only BYOK
-- module.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS writer_funding text NOT NULL DEFAULT 'afterglow';

DO $$ BEGIN
  ALTER TABLE user_settings ADD CONSTRAINT user_settings_writer_funding_allowed
    CHECK (writer_funding IN ('afterglow', 'byok'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS user_provider_credentials (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version integer NOT NULL,
  key_suffix text NOT NULL,
  validated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- The initial 0024 relation called the AES-GCM nonce `iv`. Rename it without
-- rewriting ciphertext; fresh installations already have `nonce` above.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_provider_credentials' AND column_name='iv'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_provider_credentials' AND column_name='nonce'
  ) THEN
    ALTER TABLE user_provider_credentials RENAME COLUMN iv TO nonce;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE user_provider_credentials ADD CONSTRAINT user_provider_credentials_provider_allowed
    CHECK (provider IN ('openrouter'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE user_provider_credentials ADD CONSTRAINT user_provider_credentials_key_version_positive
    CHECK (key_version > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE user_provider_credentials ADD CONSTRAINT user_provider_credentials_suffix_safe
    CHECK (key_suffix ~ '^[A-Za-z0-9_-]{4}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE user_provider_credentials ENABLE ROW LEVEL SECURITY;
-- The server database role owns the table and uses narrow, user-scoped SQL.
-- Browser roles have no privileges or policies and cannot address the table.
ALTER TABLE user_provider_credentials NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON user_provider_credentials FROM PUBLIC, anon, authenticated;
