# Afterglow

Afterglow is a private, self-hosted character companion and roleplay studio. It combines editable character profiles, streamed DeepSeek responses, chat regeneration, adult/SFW modes, and durable multi-layer memory in a polished web interface designed for Railway.

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
- Single-owner password lock with an HTTP-only signed session cookie
- Complete JSON export/import for profiles, chats, memories, and settings
- Request throttling, server-only API key, PostgreSQL persistence, local token-usage ledger, and Railway health check
- Responsive desktop/mobile UI

Image generation, voice/video calling, public character discovery, and group chat are not part of this release. They fit the architecture but each requires an additional provider and product pass; DeepSeek's chat endpoint itself does not provide those media capabilities.

## Run locally

Requirements: Node.js 20+ and PostgreSQL 15+.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Create a PostgreSQL database and update `DATABASE_URL`. The schema is created automatically on first use.

Generate secure app secrets, for example:

```bash
openssl rand -base64 32
```

Use distinct values for `APP_PASSWORD` and `SESSION_SECRET`. `SESSION_SECRET` should be at least 32 random characters.

## Deploy on Railway

1. Push this repository to a **private** GitHub repository.
2. In Railway, create a new project from that repository.
3. Add a PostgreSQL service.
4. On the web service, create a reference variable named `DATABASE_URL` pointing to the PostgreSQL service's `DATABASE_URL`.
5. Add these secret variables to the web service:
   - `DEEPSEEK_API_KEY`
   - `APP_PASSWORD`
   - `SESSION_SECRET`
6. Optionally add `OWNER_NAME`, `OWNER_PROFILE`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_MODEL`.
7. Deploy. Railway reads the included `Dockerfile` and uses `/api/health` as configured in `railway.toml`.
8. Generate a public domain in Railway, then open it and complete the adult age gate.

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
- The current auth model is intentionally single-owner. Add a real identity provider and row-level tenancy before inviting other users.
- Avatar URLs are restricted to HTTP(S). For stronger privacy, replace URL avatars with object storage you control.

## Verification

```bash
npm test
npm run lint
npm run build
```

CI runs the same checks on pushes and pull requests.

## Architecture

- Next.js 16 / React 19 / TypeScript
- PostgreSQL through `pg`, with idempotent schema initialization
- DeepSeek's OpenAI-compatible `/chat/completions` endpoint with NDJSON streaming to the browser
- Zod validation at every write endpoint
- Docker standalone build for Railway

## License and use

This repository is intended for private personal use. You are responsible for the laws, hosting rules, model-provider terms, and content involving your deployment.
