-- A free tier that is honest about being shared, and a model catalogue the
-- server can change without a deploy.
--
-- THE PRODUCT CLAIM THIS SCHEMA HAS TO SUPPORT. Afterglow's free tier is served
-- from ONE platform OpenRouter account's legitimate free-model quota. That quota
-- is global — OpenRouter's own documentation states that additional accounts or
-- API keys do not raise it, because capacity is governed globally — so the
-- honest sentence is "a limited shared pool of free generations each day,
-- subject to provider capacity", never "fifty free messages each". A schema that
-- counted only per user would let the product promise the second one.
--
-- So there are two ledgers and both are authoritative for different questions:
-- `free_tier_pool_days` is what the PLATFORM has spent today, and
-- `free_tier_user_days` is what ONE READER has spent today. A generation has to
-- fit inside both, and the reservation that proves it fits is taken before the
-- request leaves and settled after it lands.
--
-- WHY RESERVATIONS AND NOT A COUNTER INCREMENT. Two readers arriving in the same
-- millisecond with one slot left must not both get it, and a request that fails
-- before any inference happened must not consume anybody's day. Both are the
-- same requirement: the count has to move atomically, and it has to be able to
-- move back. `reserved - released` is therefore what a cap is compared against,
-- `spent` records what actually ran, and `free_tier_reservations` exists so that
-- settling twice — a retry, a duplicated callback — cannot double-count.
--
-- WHAT CANNOT BE REFUNDED, AND IS NOT PRETENDED OTHERWISE. OpenRouter counts a
-- failed free-model attempt against the platform's daily allowance. Afterglow
-- can give a reader their allowance back; it cannot give the platform its
-- upstream request back. `released` therefore restores Afterglow's ledger and
-- the routing layer treats OpenRouter's 429 as the authority on whether real
-- capacity remains.

-- ---------------------------------------------------------------------------
-- The platform's day.
-- ---------------------------------------------------------------------------
--
-- `funding` separates the two things a free-tier generation can be paid for
-- with, because they exhaust independently and one is not a substitute for the
-- other: `shared_free` is the platform account's free-model quota, and
-- `platform_funded` is Afterglow paying real money for an ultra-cheap paid
-- writer when the free quota is gone. Rolling them into one number would hide
-- exactly the transition an operator needs to see.
--
-- The day is a DATE in UTC, matching how OpenRouter's own daily allowance
-- resets. A local-midnight reset would give readers in one timezone a second
-- allowance on the platform's already-spent day.
CREATE TABLE IF NOT EXISTS free_tier_pool_days (
  utc_day date NOT NULL,
  funding text NOT NULL,
  reserved integer NOT NULL DEFAULT 0,
  spent integer NOT NULL DEFAULT 0,
  released integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (utc_day, funding)
);

DO $$ BEGIN
  ALTER TABLE free_tier_pool_days ADD CONSTRAINT free_tier_pool_days_funding_allowed
    CHECK (funding IN ('shared_free', 'platform_funded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE free_tier_pool_days ADD CONSTRAINT free_tier_pool_days_counts_sane
    CHECK (reserved >= 0 AND spent >= 0 AND released >= 0 AND spent + released <= reserved);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- One reader's day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS free_tier_user_days (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  utc_day date NOT NULL,
  funding text NOT NULL,
  reserved integer NOT NULL DEFAULT 0,
  spent integer NOT NULL DEFAULT 0,
  released integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, utc_day, funding)
);

DO $$ BEGIN
  ALTER TABLE free_tier_user_days ADD CONSTRAINT free_tier_user_days_funding_allowed
    CHECK (funding IN ('shared_free', 'platform_funded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE free_tier_user_days ADD CONSTRAINT free_tier_user_days_counts_sane
    CHECK (reserved >= 0 AND spent >= 0 AND released >= 0 AND spent + released <= reserved);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- The reservation itself: what makes settling idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS free_tier_reservations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  utc_day date NOT NULL,
  funding text NOT NULL,
  model_id text NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

DO $$ BEGIN
  ALTER TABLE free_tier_reservations ADD CONSTRAINT free_tier_reservations_state_allowed
    CHECK (state IN ('reserved', 'spent', 'released'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE free_tier_reservations ADD CONSTRAINT free_tier_reservations_funding_allowed
    CHECK (funding IN ('shared_free', 'platform_funded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A reservation left 'reserved' is a request that died between taking a slot
-- and reporting what happened to it. Sweeping those back is a maintenance job,
-- and this is the index it reads.
CREATE INDEX IF NOT EXISTS free_tier_reservations_open_idx
  ON free_tier_reservations (state, created_at) WHERE state = 'reserved';
CREATE INDEX IF NOT EXISTS free_tier_reservations_user_day_idx
  ON free_tier_reservations (user_id, utc_day);

-- ---------------------------------------------------------------------------
-- The server-owned curated route table.
-- ---------------------------------------------------------------------------
--
-- WHY THIS EXISTS. OpenRouter's free lineup changes weekly: routes appear,
-- disappear, and are renamed, and a route that 404s for every reader on the free
-- tier must be removable in a minute rather than in a release. So availability,
-- category and health thresholds are DATA, owned by the server, and the code
-- carries only known-safe defaults for when this table is empty.
--
-- WHAT IT DELIBERATELY IS NOT. Not a CMS. It cannot invent a model, cannot
-- change a slug, and cannot alter what a model is capable of — every row here
-- refers to a catalogue entry that already exists in src/lib/provider.ts, and a
-- row naming an unknown model is ignored. Adding a genuinely new writer is still
-- a code change with a review, because the request body it needs, the context it
-- fits and the privacy floor it is sent with are all engineering decisions.
CREATE TABLE IF NOT EXISTS curated_model_routes (
  model_id text PRIMARY KEY,
  -- The kill switch. False hides the route from the picker and refuses new
  -- generations on it; existing conversations get the ordinary "choose another
  -- model" answer rather than a mystery failure.
  enabled boolean NOT NULL DEFAULT true,
  -- Overrides the shelf declared in code, so a route can be demoted from
  -- Recommended to Experimental the moment it starts misbehaving.
  category text,
  -- A reader-facing sentence: a shared-capacity caveat, a privacy disclosure.
  notice text,
  -- Health gates. A route whose measured P50 time-to-first-token exceeds this
  -- is not offered for interactive chat; 30s is the product's stated floor and
  -- lives in config rather than in code so it can be tightened per route.
  max_ttft_ms integer,
  -- Streaming that is slow enough to be unpleasant even when it starts fast.
  -- Below this the route is kept but deprioritised rather than hidden.
  min_throughput_tps numeric,
  -- Null means "use the deployment-wide per-user cap".
  per_user_daily_cap integer,
  -- What the provider says it does with a prompt, recorded at review time. Free
  -- text on purpose: this is the audit note a human wrote, not a machine field.
  data_policy_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE curated_model_routes ADD CONSTRAINT curated_model_routes_category_allowed
    CHECK (category IS NULL OR category IN ('recommended', 'economy', 'free', 'experimental'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE curated_model_routes ADD CONSTRAINT curated_model_routes_thresholds_sane
    CHECK ((max_ttft_ms IS NULL OR max_ttft_ms > 0)
       AND (min_throughput_tps IS NULL OR min_throughput_tps >= 0)
       AND (per_user_daily_cap IS NULL OR per_user_daily_cap >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Rolling health for volatile routes.
-- ---------------------------------------------------------------------------
--
-- ONE BAD HOUR IS NOT A RETIREMENT. A free endpoint that returns 429 for twenty
-- minutes is busy, not gone, and deleting it from the catalogue would lose the
-- curation work and the reader's chosen model with it. So health is a rolling
-- window written beside the route, never a deletion: a route can be reported as
-- Busy or Temporarily unavailable and recover on its own.
--
-- The window is reset rather than decayed because the arithmetic has to be
-- readable at three in the morning. `window_started_at` says when the current
-- counts began; the reader rolls it over once it is older than the configured
-- window.
CREATE TABLE IF NOT EXISTS model_route_health (
  model_id text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  successes integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  -- 429s and explicit capacity refusals, counted apart from other failures:
  -- "the pool is exhausted" and "the route is broken" need different answers.
  capacity_errors integer NOT NULL DEFAULT 0,
  ttft_ms_total bigint NOT NULL DEFAULT 0,
  ttft_samples integer NOT NULL DEFAULT 0,
  output_tokens_total bigint NOT NULL DEFAULT 0,
  generation_ms_total bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE model_route_health ADD CONSTRAINT model_route_health_counts_sane
    CHECK (successes >= 0 AND failures >= 0 AND capacity_errors >= 0
       AND ttft_samples >= 0 AND ttft_ms_total >= 0
       AND output_tokens_total >= 0 AND generation_ms_total >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Access.
-- ---------------------------------------------------------------------------
--
-- The two accounting tables carry a user_id and are read and written only by
-- narrow, user-scoped server SQL, exactly like user_provider_credentials: the
-- server role owns them and browser roles have no privileges at all. A reader
-- must not be able to read the platform ledger, and must not be able to write
-- their own.
--
-- The catalogue and health tables carry no user data and are server-owned for
-- the same reason: a browser that could write them could enable a route the
-- privacy review rejected.
ALTER TABLE free_tier_pool_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_tier_pool_days NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON free_tier_pool_days FROM PUBLIC, anon, authenticated;

ALTER TABLE free_tier_user_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_tier_user_days NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON free_tier_user_days FROM PUBLIC, anon, authenticated;

ALTER TABLE free_tier_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_tier_reservations NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON free_tier_reservations FROM PUBLIC, anon, authenticated;

ALTER TABLE curated_model_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE curated_model_routes NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON curated_model_routes FROM PUBLIC, anon, authenticated;

ALTER TABLE model_route_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_route_health NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON model_route_health FROM PUBLIC, anon, authenticated;

-- Usage attribution gains a third funding source.
--
-- `byok` already meant "the reader's own OpenRouter account paid for this".
-- `shared_free` means the platform account's free quota did, and
-- `platform_funded` means Afterglow paid real money for a cheap paid writer
-- because free capacity was gone. Those are three different lines in a spend
-- report and collapsing any two of them would make the free tier's actual cost
-- unreadable.
DO $$ BEGIN
  ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_funding_source_allowed;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE usage_events ADD CONSTRAINT usage_events_funding_source_allowed
    CHECK (funding_source IN ('afterglow', 'byok', 'self_hosted', 'shared_free', 'platform_funded'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
