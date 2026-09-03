-- Privacy-safe state used to compare structural prompt reuse with provider cache hits.
--
-- The value contains only SHA-256 fingerprints, roles and token counts; prompt
-- text is never stored. The chat path writes it only for Afterglow admin
-- accounts while cache experiments are being run.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS writer_cache_probe_state jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN conversations.writer_cache_probe_state IS
  'Admin cache diagnostics: hashes/token counts of the previous writer request, never prompt text.';
