-- Conversation-owned inference writer configuration.
--
-- These columns deliberately live beside, rather than inside, Afterglow's
-- continuity data. Switching provider/model/engine changes only the writer for
-- the next response; transcript, summaries, memories, arcs, world, persona and
-- character state remain untouched.

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model_id text NOT NULL DEFAULT 'deepseek-v4-flash';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS rp_engine_id text NOT NULL DEFAULT 'immersive';

-- Existing conversations inherit the account's current defaults once. Future
-- settings changes do not rewrite them.
UPDATE conversations c
SET provider_id = COALESCE(NULLIF(s.provider_id,''),'deepseek'),
    model_id = COALESCE(NULLIF(s.model,''),'deepseek-v4-flash'),
    rp_engine_id = COALESCE(NULLIF(s.roleplay_preset,''),'immersive')
FROM user_settings s
WHERE c.user_id = s.user_id
  AND c.provider_id = 'deepseek'
  AND c.model_id = 'deepseek-v4-flash'
  AND c.rp_engine_id = 'immersive';

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_id text NOT NULL DEFAULT 'deepseek';
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS rp_engine_id text NOT NULL DEFAULT 'immersive';
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS funding_source text NOT NULL DEFAULT 'afterglow';

CREATE INDEX IF NOT EXISTS usage_events_writer_idx
  ON usage_events (user_id, provider_id, model, rp_engine_id, created_at DESC);

DO $$ BEGIN
  ALTER TABLE usage_events ADD CONSTRAINT usage_events_funding_source_allowed
    CHECK (funding_source IN ('afterglow','byok','self_hosted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
