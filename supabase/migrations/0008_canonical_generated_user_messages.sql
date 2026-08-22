-- A canonical product message is a user-authored event that reached the model
-- workflow. Branch copies preserve both the lineage id and this timestamp;
-- regenerate/continue have no user row and therefore cannot inflate counts.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS generation_started_at timestamptz;

-- Historical user turns predate explicit workflow acknowledgement. Preserve
-- today's totals while making all new writes exact from this migration onward.
UPDATE messages
SET generation_started_at=created_at
WHERE role='user' AND generation_started_at IS NULL;

CREATE TABLE IF NOT EXISTS afterglow_runtime_migrations (
  key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE afterglow_runtime_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON afterglow_runtime_migrations FROM anon, authenticated;
INSERT INTO afterglow_runtime_migrations(key) VALUES ('0008_canonical_generated_user_messages') ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS messages_canonical_user_event_idx
  ON messages(user_id,authored_event_id)
  WHERE role='user' AND generation_started_at IS NOT NULL;
