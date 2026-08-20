# Afterglow

Afterglow is a multi-user character companion and roleplay studio. It combines editable character profiles, streamed DeepSeek responses, chat regeneration, adult/SFW modes, and durable multi-layer memory in a polished web interface, built on Supabase for authentication, PostgreSQL, storage, and per-account data isolation.

It is an original application, not a copy of JuicyChat or Kindroid. The useful concepts are familiar; the code, interface, prompts, and data model are its own.

## What works now

- AI-assisted character creation from a short concept
- Detailed backstory, personality, scenario, greeting, example voice, response directive, and boundaries
- Optional avatar URL and per-character visual accent
- Streaming DeepSeek roleplay with switchable Flash/Pro models and response controls
- Regenerate the latest reply, edit any message, or rewind the story from any point
- Multiple named chats per character and chat breaks that preserve long-term memory
- Three-layer continuity:
  - persistent character profile and response rules
  - rolling story-so-far summary
  - relevance-ranked long-term memories and keyword journals
- Configurable automatic memory consolidation plus manual refresh
- Manual pinned journals with recall keywords; inspect, edit, pin, unpin, or delete memories
- Per-character adult/SFW mode, adult age gate, and explicit consent boundaries
- Supabase Auth accounts with email/password sign-up, sign-in, and persistent sessions
- Per-account ownership of every character, world, persona, chat, message, and memory, enforced by PostgreSQL row level security
- Character visibility model (private / unlisted / public) ready for a creator marketplace, with chats and memories that stay private even when the character is published
- Supabase Storage for profile and character images, scoped to the owning account
- Complete JSON export/import for profiles, chats, memories, and settings
- Request throttling, server-only API key, PostgreSQL persistence, local token-usage ledger, and Railway health check
- Responsive desktop/mobile UI

Image generation, voice/video calling, public character discovery, and group chat are not part of this release. They fit the architecture but each requires an additional provider and product pass; DeepSeek's chat endpoint itself does not provide those media capabilities.

## Run locally

Requirements: Node.js 20+, PostgreSQL 15+, and a Supabase project.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill in `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from **Supabase → Project Settings**, then apply the migrations (below). The application also creates any missing tables and columns at runtime, but row level security is only established by the migration files, so a deployment must apply them.

### Applying migrations

Run the files in `supabase/migrations` in order, either through the Supabase SQL editor or with psql:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0000_baseline.sql
psql "$DATABASE_URL" -f supabase/migrations/0001_multi_tenant_foundation.sql
psql "$DATABASE_URL" -f supabase/migrations/0002_storage.sql
```

Every file is idempotent, so re-running them is safe. `0002_storage.sql` touches the `storage` schema and only applies to Supabase.

The application refuses to serve traffic against a database where it cannot assume the `authenticated` role, because row level security would silently not be enforced.

### Migrating existing single-owner data

The original schema has no concept of a user, so existing rows have to be assigned to one account explicitly.

1. Create the account (sign up in the app, or **Authentication → Users → Add user** in Supabase).
2. Copy its UUID.
3. Preview the migration, then apply it:

```bash
DATABASE_URL=… LEGACY_OWNER_USER_ID=<uuid> node scripts/migrate-legacy-owner.mjs
DATABASE_URL=… LEGACY_OWNER_USER_ID=<uuid> node scripts/migrate-legacy-owner.mjs --commit
```

The first run is a dry run that reports what it would claim and rolls back. Characters, worlds, personas, chats, messages, memories, arcs, usage events, and the settings row are all carried over. Once no unowned rows remain, re-run with `--commit --enforce` to make the ownership columns `NOT NULL`.

## Supabase setup

1. Create a Supabase project.
2. On the project creation screen, under **Security**, turn **Enable Data API** off and **Enable automatic RLS** on. Afterglow talks to PostgreSQL directly and uses Supabase only for Auth and Storage, so PostgREST is unused surface; automatic RLS is a free safety net for any table added later. Both are reversible in Project Settings.
3. Apply `supabase/migrations/0000_baseline.sql` and `0001_multi_tenant_foundation.sql`. The migration grants its own schema and table privileges, so it does not depend on the project's "automatically expose new tables" default.
4. Apply `supabase/migrations/0002_storage.sql`, which creates the `profile-avatars` and `character-avatars` buckets and their policies.
5. In **Authentication → Providers**, keep Email enabled. Decide whether to require email confirmation; the sign-up screen handles both.
6. In **Authentication → URL Configuration**, add your deployed origin to the redirect allow list.
7. Copy `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` into your host's environment.

No part of the application uses the service-role key. Ordinary reads and writes run as the signed-in account so row level security applies, and the legacy migration script connects with `DATABASE_URL` directly.

## Deploy

1. Push this repository to a **private** GitHub repository.
2. Create a project from it on your host (the included `Dockerfile` and `railway.toml` target Railway; `/api/health` is the health check).
3. Set `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `DEEPSEEK_API_KEY`.

   The two `NEXT_PUBLIC_*` values are inlined into the browser bundle while the image is built, not read when the container starts, so they must be present **before** the build runs. The Dockerfile declares them as build arguments and Railway passes service variables to the build automatically; on another host, pass them with `--build-arg`. Adding them to an already-built deployment has no effect until it is rebuilt, and the app now says so on its front page rather than failing silently.
4. Optionally set `ALLOWED_MODELS`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_MODEL`.
5. Deploy, then open the domain, complete the adult age gate, and create an account.

The default model is `deepseek-v4-flash`, matching the current official DeepSeek Chat Completions API. After first launch, model and response controls live in **Settings & data**. `DEEPSEEK_MODEL` sets the initial database default. Check the [official model documentation](https://api-docs.deepseek.com/api/create-chat-completion/) before changing names because provider model IDs evolve.

Railway's official deployment pattern is a Next.js service plus a referenced PostgreSQL `DATABASE_URL`; see [Deploy a Next.js app with Postgres](https://docs.railway.com/guides/nextjs).

## Memory design

Each reply receives:

1. The full character profile and boundaries.
2. A compact rolling relationship/story summary.
3. A configurable number of relevant memories, selected by pinned status, exact journal keywords, text relevance, importance, and recency.
4. A configurable window of recent messages at full fidelity.

At the configured consolidation interval, DeepSeek condenses recent events into the summary and extracts a small set of atomic durable memories. You can also trigger consolidation manually. Passwords, API keys, payment data, addresses, and explicit sexual mechanics are specifically excluded from automatic memory extraction.

This avoids continuously sending the entire chat history, improving continuity while controlling token cost. The `usage_events` table records streamed prompt, output, cache-hit, and cache-miss token counts and the settings panel shows the local totals without hard-coding volatile provider pricing.

## Adult-content boundaries

Adult mode permits consensual explicit fictional roleplay between adults. The system prompt still excludes minors or age ambiguity, coercion presented as consent, sexual violence, incest, bestiality, trafficking, and real-person sexual content. Provider-side restrictions may still apply; no application can promise that a hosted model will comply with every prompt.

## Security notes

- Never expose `DEEPSEEK_API_KEY` through a `NEXT_PUBLIC_` variable.
- Never commit `.env` or `.env.local`; both are ignored.
- Rotate any API key pasted into chat or another third-party interface before production use.
- Use Railway's secret variables and database backups.
- The application uses no service-role key at all. If you introduce one, keep it server-side: it bypasses row level security entirely.
- Ownership is enforced twice: every statement carries an explicit `user_id` predicate, and PostgreSQL policies decide independently. A mistake in one layer is caught by the other.
- Avatar buckets are public-read so published characters render for other accounts; writes are restricted to `users/{account_id}/…` by storage policy. Nothing confidential belongs in an avatar.
- Conversations, messages, memories, and arcs are private without exception, including when the character they use is public.

## Verification

```bash
npm test
npm run lint
npm run build
```

The cross-account isolation suite needs a real PostgreSQL, because the in-memory database used by the other tests implements neither roles nor policies:

```bash
createdb afterglow_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/afterglow_test npm test
```

Without `TEST_DATABASE_URL` those tests skip and everything else still runs. CI provides a PostgreSQL service so they always run there.

## Architecture

- Next.js 16 / React 19 / TypeScript
- Supabase Auth for accounts, Supabase Storage for images
- PostgreSQL through `pg`, with idempotent schema initialization and versioned migrations under `supabase/migrations`
- Row level security as the enforcement layer: each request runs in a transaction that assumes the `authenticated` role and publishes the caller's id as `request.jwt.claims`, so `auth.uid()` resolves for hand-written SQL exactly as it would through PostgREST
- DeepSeek's OpenAI-compatible `/chat/completions` endpoint with NDJSON streaming to the browser
- Zod validation at every write endpoint
- Docker standalone build for Railway

## License and use

This repository is intended for private personal use. You are responsible for the laws, hosting rules, model-provider terms, and content involving your deployment.
