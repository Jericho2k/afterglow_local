-- Provider-neutral usage details needed for OpenRouter and future adapters.
-- This migration is intentionally independent from Memory Retrieval V2.

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cache_write_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS reasoning_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_cost_usd numeric(20,10);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS upstream_cost_usd numeric(20,10);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS actual_provider_model text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS catalog_model_id text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS task_route text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS latency_ms integer;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_request_id text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE usage_events
SET actual_provider_model = COALESCE(actual_provider_model,model),
    catalog_model_id = COALESCE(catalog_model_id,model),
    task_route = COALESCE(task_route,usage_type)
WHERE actual_provider_model IS NULL OR catalog_model_id IS NULL OR task_route IS NULL;

CREATE INDEX IF NOT EXISTS usage_events_task_route_idx
  ON usage_events (user_id, task_route, provider_id, created_at DESC);
