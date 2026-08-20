-- Afterglow multi-tenant foundation.
--
-- Turns the original single-owner schema into a user-scoped one. Every
-- statement is idempotent so the file can be applied to the existing Railway
-- database, to a fresh Supabase project, or to a throwaway PostgreSQL used by
-- the isolation tests.
--
-- Ownership is enforced by row level security. The application connects with a
-- pooled PostgreSQL role but runs every request inside a transaction that
-- assumes `authenticated` and sets `request.jwt.claims`, so `auth.uid()`
-- resolves exactly as it would through PostgREST and these policies are the
-- real enforcement layer rather than documentation.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE,
  display_name text NOT NULL DEFAULT '',
  avatar_path text NOT NULL DEFAULT '',
  bio text NOT NULL DEFAULT '',
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_username_shape
    CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9_-]{2,29}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_plan_allowed
    CHECK (plan IN ('free', 'beta', 'pro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A profile row must exist for every account. Created by trigger so it cannot
-- be skipped by a client that never calls an onboarding endpoint.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'display_name', ''), split_part(NEW.email, '@', 1), 'Traveller')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Per-user settings
--
-- `app_settings` stays as the server-managed default row. Anything a user may
-- tune now lives here, one row per account, so no two accounts share state.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_name text NOT NULL DEFAULT 'You',
  owner_profile text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT 'deepseek-v4-flash',
  roleplay_preset text NOT NULL DEFAULT 'immersive',
  temperature double precision NOT NULL DEFAULT 0.95,
  max_tokens integer NOT NULL DEFAULT 1800,
  context_messages integer NOT NULL DEFAULT 30,
  context_token_budget integer NOT NULL DEFAULT 12000,
  consolidation_interval integer NOT NULL DEFAULT 10,
  memory_limit integer NOT NULL DEFAULT 8,
  memory_token_budget integer NOT NULL DEFAULT 6000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ownership columns
--
-- `user_id` is added nullable first so the file can be applied to a database
-- that still holds single-owner rows. `scripts/migrate-legacy-owner.mjs`
-- assigns those rows and then tightens the columns to NOT NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE characters    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE worlds        ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE personas      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE messages      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE memories      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE memory_arcs   ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Public/private content model
-- ---------------------------------------------------------------------------

ALTER TABLE characters ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS avatar_path text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS published_at timestamptz;
-- Reserved for a later fork/duplicate feature. Nullable and unused today; it
-- exists so publishing history does not need a table rewrite later.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS origin_character_id uuid REFERENCES characters(id) ON DELETE SET NULL;

ALTER TABLE worlds ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_visibility_allowed
    CHECK (visibility IN ('private', 'unlisted', 'public'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE worlds ADD CONSTRAINT worlds_visibility_allowed
    CHECK (visibility IN ('private', 'unlisted', 'public'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A conversation with somebody else's character freezes the definition it
-- started from. The creator stays free to edit their own copy without
-- rewriting the system prompt inside a stranger's live chat.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS character_snapshot jsonb;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_path text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- Composite keys that keep the denormalised user_id honest
--
-- messages/memories/memory_arcs carry their own user_id so every policy is a
-- single-table predicate instead of a join upward on every row. The composite
-- foreign keys below make it impossible for that column to disagree with the
-- parent conversation.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_id_user_key UNIQUE (id, user_id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE characters ADD CONSTRAINT characters_id_user_key UNIQUE (id, user_id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Per-user uniqueness
-- ---------------------------------------------------------------------------

-- The original index allowed exactly one default persona per installation.
DROP INDEX IF EXISTS personas_single_default_idx;
CREATE UNIQUE INDEX IF NOT EXISTS personas_user_default_idx
  ON personas (user_id) WHERE is_default;

-- ---------------------------------------------------------------------------
-- Indexes for user-scoped reads and the usage ledger
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS characters_user_idx        ON characters (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS characters_public_idx      ON characters (visibility, updated_at DESC) WHERE visibility = 'public';
CREATE INDEX IF NOT EXISTS worlds_user_idx            ON worlds (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS personas_user_idx          ON personas (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_user_idx     ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_character_idx ON conversations (character_id);
CREATE INDEX IF NOT EXISTS messages_user_idx          ON messages (user_id);
CREATE INDEX IF NOT EXISTS memories_user_idx          ON memories (user_id, character_id);
CREATE INDEX IF NOT EXISTS memory_arcs_user_idx       ON memory_arcs (user_id);
CREATE INDEX IF NOT EXISTS usage_events_user_idx      ON usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_user_type_idx ON usage_events (user_id, usage_type, created_at DESC);

-- ---------------------------------------------------------------------------
-- Cross-user deletion guard
--
-- characters cascade into conversations, memories and messages. Without this a
-- creator deleting a published character would destroy other people's private
-- histories. Deleting is refused while somebody else is still using it; the
-- creator unpublishes instead.
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER on purpose: the check has to see rows belonging to *other*
-- accounts, and a trigger body otherwise runs under the deleting account's own
-- policies, which would hide exactly the conversations it must protect and let
-- the delete cascade through them.
CREATE OR REPLACE FUNCTION public.guard_character_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  foreign_uses integer;
BEGIN
  SELECT count(*) INTO foreign_uses FROM (
    SELECT 1 FROM conversations c WHERE c.character_id = OLD.id AND c.user_id IS DISTINCT FROM OLD.user_id
    UNION ALL
    SELECT 1 FROM memories m WHERE m.character_id = OLD.id AND m.user_id IS DISTINCT FROM OLD.user_id
  ) uses;

  IF foreign_uses > 0 THEN
    RAISE EXCEPTION 'character_in_use_by_other_accounts'
      USING HINT = 'Set visibility to private instead of deleting a character other accounts are chatting with.';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_character_delete_trigger ON characters;
CREATE TRIGGER guard_character_delete_trigger
  BEFORE DELETE ON characters
  FOR EACH ROW EXECUTE FUNCTION public.guard_character_delete();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- FORCE is set so the table owner (the role the connection pool authenticates
-- as) is subject to the same policies rather than silently bypassing them.
-- ---------------------------------------------------------------------------

ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles         FORCE ROW LEVEL SECURITY;
ALTER TABLE user_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings    FORCE ROW LEVEL SECURITY;
ALTER TABLE characters       ENABLE ROW LEVEL SECURITY;
ALTER TABLE characters       FORCE ROW LEVEL SECURITY;
ALTER TABLE worlds           ENABLE ROW LEVEL SECURITY;
ALTER TABLE worlds           FORCE ROW LEVEL SECURITY;
ALTER TABLE personas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE personas         FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations    FORCE ROW LEVEL SECURITY;
ALTER TABLE messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages         FORCE ROW LEVEL SECURITY;
ALTER TABLE memories         ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories         FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_arcs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_arcs      FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events     FORCE ROW LEVEL SECURITY;
ALTER TABLE character_worlds ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_worlds FORCE ROW LEVEL SECURITY;
ALTER TABLE app_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings     FORCE ROW LEVEL SECURITY;

-- profiles -------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_select_own ON profiles;
CREATE POLICY profiles_select_own ON profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

DROP POLICY IF EXISTS profiles_insert_own ON profiles;
CREATE POLICY profiles_insert_own ON profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profiles_update_own ON profiles;
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- user_settings --------------------------------------------------------------
DROP POLICY IF EXISTS user_settings_select_own ON user_settings;
CREATE POLICY user_settings_select_own ON user_settings
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_settings_insert_own ON user_settings;
CREATE POLICY user_settings_insert_own ON user_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_settings_update_own ON user_settings;
CREATE POLICY user_settings_update_own ON user_settings
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- characters -----------------------------------------------------------------
-- Readable when owned, or when the creator published it. Only the owner may
-- ever write, so a public character is a read-only template to everyone else.
DROP POLICY IF EXISTS characters_select_own_or_published ON characters;
CREATE POLICY characters_select_own_or_published ON characters
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR visibility IN ('public', 'unlisted'));

DROP POLICY IF EXISTS characters_insert_own ON characters;
CREATE POLICY characters_insert_own ON characters
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS characters_update_own ON characters;
CREATE POLICY characters_update_own ON characters
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS characters_delete_own ON characters;
CREATE POLICY characters_delete_own ON characters
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- worlds ---------------------------------------------------------------------
DROP POLICY IF EXISTS worlds_select_own_or_published ON worlds;
CREATE POLICY worlds_select_own_or_published ON worlds
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR visibility IN ('public', 'unlisted'));

DROP POLICY IF EXISTS worlds_insert_own ON worlds;
CREATE POLICY worlds_insert_own ON worlds
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS worlds_update_own ON worlds;
CREATE POLICY worlds_update_own ON worlds
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS worlds_delete_own ON worlds;
CREATE POLICY worlds_delete_own ON worlds
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- personas -------------------------------------------------------------------
-- Personas are who the user is in a story. They stay private with no
-- publishing path at all.
DROP POLICY IF EXISTS personas_all_own ON personas;
CREATE POLICY personas_all_own ON personas
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- conversations / messages / memories / arcs ---------------------------------
-- Private without exception, including when the underlying character is public.
DROP POLICY IF EXISTS conversations_all_own ON conversations;
CREATE POLICY conversations_all_own ON conversations
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS messages_all_own ON messages;
CREATE POLICY messages_all_own ON messages
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS memories_all_own ON memories;
CREATE POLICY memories_all_own ON memories
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS memory_arcs_all_own ON memory_arcs;
CREATE POLICY memory_arcs_all_own ON memory_arcs
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- usage_events ---------------------------------------------------------------
-- Readable and insertable by the owning account only. No update or delete
-- policy exists, so the ledger is append-only from the application's context.
DROP POLICY IF EXISTS usage_events_select_own ON usage_events;
CREATE POLICY usage_events_select_own ON usage_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS usage_events_insert_own ON usage_events;
CREATE POLICY usage_events_insert_own ON usage_events
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- character_worlds -----------------------------------------------------------
-- The link table has no user_id of its own; a row is visible when the user can
-- see the character, and writable only when they own both sides.
DROP POLICY IF EXISTS character_worlds_select ON character_worlds;
CREATE POLICY character_worlds_select ON character_worlds
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM characters c
    WHERE c.id = character_worlds.character_id
      AND (c.user_id = auth.uid() OR c.visibility IN ('public', 'unlisted'))
  ));

DROP POLICY IF EXISTS character_worlds_insert_own ON character_worlds;
CREATE POLICY character_worlds_insert_own ON character_worlds
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM characters c WHERE c.id = character_worlds.character_id AND c.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM worlds w WHERE w.id = character_worlds.world_id AND w.user_id = auth.uid())
  );

DROP POLICY IF EXISTS character_worlds_delete_own ON character_worlds;
CREATE POLICY character_worlds_delete_own ON character_worlds
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM characters c WHERE c.id = character_worlds.character_id AND c.user_id = auth.uid()));

-- app_settings ---------------------------------------------------------------
-- Server-managed defaults. Readable by any signed-in account, writable by none
-- of them; only the service role (which bypasses RLS) may change it.
DROP POLICY IF EXISTS app_settings_select ON app_settings;
CREATE POLICY app_settings_select ON app_settings
  FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Account bootstrap trigger
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Table privileges
--
-- Row level security only narrows what a role may already touch, so the
-- `authenticated` role still needs ordinary table grants. Policies above are
-- what actually decide which rows each account sees.
-- ---------------------------------------------------------------------------

-- Granted explicitly rather than relying on the project's "automatically
-- expose new tables" default, so the migration is self-sufficient on a project
-- created with that setting off.
GRANT USAGE ON SCHEMA public TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  profiles, user_settings, characters, worlds, personas,
  conversations, messages, memories, memory_arcs, character_worlds
TO authenticated;

-- The ledger is append-only for accounts; corrections are a service-role task.
GRANT SELECT, INSERT ON usage_events TO authenticated;
GRANT SELECT ON app_settings TO authenticated;

-- ---------------------------------------------------------------------------
-- Composite foreign keys
--
-- Added last so the UNIQUE keys they point at already exist. MATCH SIMPLE
-- means rows still carrying a NULL user_id (a legacy database that has not run
-- scripts/migrate-legacy-owner.mjs yet) satisfy the constraint, while every
-- row that does carry an owner must agree with its parent conversation.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER TABLE messages ADD CONSTRAINT messages_conversation_owner_fkey
    FOREIGN KEY (conversation_id, user_id) REFERENCES conversations (id, user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_conversation_owner_fkey
    FOREIGN KEY (conversation_id, user_id) REFERENCES conversations (id, user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_arcs ADD CONSTRAINT memory_arcs_conversation_owner_fkey
    FOREIGN KEY (conversation_id, user_id) REFERENCES conversations (id, user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Role membership
--
-- The application pool connects as the migration role and switches to
-- `authenticated` for the duration of each request. That switch requires
-- membership, which Supabase normally already grants; this makes it explicit
-- and is a no-op when it is already in place.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  EXECUTE format('GRANT authenticated TO %I', current_user);
EXCEPTION WHEN OTHERS THEN NULL; END $$;
