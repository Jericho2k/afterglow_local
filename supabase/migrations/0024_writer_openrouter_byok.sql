-- Writer-only OpenRouter BYOK.
--
-- The credential relation is deliberately not part of the browser-visible
-- account data model. Authenticated/anon receive no table privileges and no
-- RLS policies. The server's database role owns the table and reaches it only
-- through user-scoped statements in src/lib/byok.ts.

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
  PRIMARY KEY (user_id, provider),
  CONSTRAINT user_provider_credentials_provider_allowed
    CHECK (provider IN ('openrouter')),
  CONSTRAINT user_provider_credentials_key_version_positive
    CHECK (key_version > 0),
  CONSTRAINT user_provider_credentials_suffix_safe
    CHECK (key_suffix ~ '^[A-Za-z0-9_-]{4}$')
);

ALTER TABLE user_provider_credentials ENABLE ROW LEVEL SECURITY;

-- RLS narrows privileges; revocation removes the browser's ability to address
-- the relation in the first place. There are intentionally no authenticated
-- policies, including no metadata-only SELECT policy.
REVOKE ALL ON user_provider_credentials FROM PUBLIC, anon, authenticated;
