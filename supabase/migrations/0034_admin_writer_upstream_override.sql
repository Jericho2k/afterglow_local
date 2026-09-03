-- Admin-only per-model upstream pins for writer/cache experiments.
--
-- The row already belongs to the account and is protected by the existing
-- user_settings RLS policies. This column is never trusted on its own: the
-- chat path additionally requires the caller to be an Afterglow admin before
-- an override is allowed to influence OpenRouter routing.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS admin_writer_upstream_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN user_settings.admin_writer_upstream_overrides IS
  'Admin-only map of Afterglow model id to exact OpenRouter provider tag for writer routing experiments.';
