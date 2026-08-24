-- Per-account Discovery preferences.
--
-- Filters a creator sets are a preference, not a URL: re-entering them on every
-- visit is the kind of small friction that makes a product feel unfinished.
-- They belong to the account rather than to the browser, so they live on the
-- existing per-account `user_settings` row — which already has row level
-- security, already survives sign-out and sign-in, and already follows the
-- account across devices. No new table, no new policy, no new subsystem.
--
-- A single jsonb column rather than a column per filter: the filter vocabulary
-- is the tag taxonomy, which changes with the product, and a schema migration
-- per new filter would be the wrong cost. The shape is validated in the
-- application, and an unrecognised key is ignored rather than trusted.
--
-- Deliberately NOT stored here: the free-text search term. A search is
-- something somebody is doing right now, not something they prefer.

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS discovery_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE user_settings ADD CONSTRAINT user_settings_discovery_preferences_object
    CHECK (jsonb_typeof(discovery_preferences) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
