# The 2026-08 model lineup, free tier and memory economics

What was built, what was measured, and — at length, because it is the most
important part of this document — what could **not** be measured from the
environment this sprint ran in.

---

## 0. Read this first: the verification ceiling

**This environment has no access to OpenRouter and no provider credentials.**

```
$ curl https://openrouter.ai/api/v1/models
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [{ "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "openrouter.ai:443" }]
```

The organisation's egress policy denies `openrouter.ai` outright, and denies
direct page fetches generally. No API key for OpenRouter, DeepSeek or anything
else is present in the environment. That has three consequences, and they are
load-bearing for every number below:

1. **No price, provider, context or policy figure in this document was read
   from OpenRouter's API.** Everything came from a web *search index* —
   snippets attributed to OpenRouter's own pages and to third-party trackers.
   That is one source of truth removed from the thing it describes.
2. **No paid benchmark was run.** Not one generation, not one latency sample,
   not one cache-hit ratio. Every quality, speed and cost claim about a *new*
   model in this document is a projection or a citation, never a measurement.
3. **The harnesses were built instead**, and they all skip loudly with a
   non-zero exit code rather than emitting a plausible-looking number.

Where this document says *modelled*, it means arithmetic over a rate card.
Where it says *cited*, it means somebody else measured it. Where it says
*measured*, it means this repository measured it, offline, against its own
prompt builder. There is no fourth category.

---

## 1. Carry-forward corrections from the GLM 4.7 sprint

### 1.1 The approved production pool is now cache-capable, not merely affordable

The previous sprint leaned on `provider.max_price` as the production guard and
left the provider list advisory. **That is not sufficient, and the reason is the
whole point of the cost work.** An endpoint can sit under a fresh-input and
output ceiling while publishing no discounted cache-read rate at all — and an
Afterglow roleplay turn resends the character, world, persona and rules
unchanged, so cached reads are most of what a long story pays for. Such an
endpoint passes the guard and defeats the objective, silently, with nothing
failing.

The approved pool is therefore the set that is **both** inside the price
envelope **and** explicitly cache-capable, declared as
`cacheCapableProviders` in `src/lib/provider.ts`, and in `cost_guarded` mode it
is sent as `provider.only`.

| | |
|---|---|
| **Approved GLM 4.7 production pool** | `deepinfra`, `novita`, `z-ai` |
| **Enforced as `provider.only`?** | Yes, by default (`ENFORCE_PROVIDER_POOL=true`) |
| **Price ceiling** | $0.65/M prompt, $2.25/M completion — retained as defence in depth |
| **Privacy floor** | `data_collection: "deny"` on every attempt |
| **Session id** | Unchanged. The stable per-conversation `session_id` is preserved. |
| **Explicit provider order?** | **No.** Deliberately unordered so the already-warm pool member stays warm. |

**Does every allowed provider currently advertise cache-read pricing?** The
operator-reported rates the previous sprint recorded say yes — DeepInfra
$0.08/M, Novita $0.099/M, Z.AI $0.11/M against fresh rates of $0.40/$0.54/$0.60
— and a 2026-08-31 search-index check corroborates that OpenRouter's `z-ai/glm-4.7`
page lists DeepInfra, NovitaAI and Z.ai among the seven hosts serving the model
(alongside AtlasCloud, Venice, Google Vertex and Mancer, which the pool
excludes). **This was not confirmed against the API.** `scripts/provider-pool-audit.mjs`
is the thing that confirms it, exits 1 if any member is missing, dearer than the
ceiling, or publishes no cache-read price, and is safe to put on a schedule
because it makes no inference calls.

**`only` is deliberately not `order`.** OpenRouter documents that setting
`provider.order` turns its own sticky routing off. Restricting the *candidate
set* bounds which endpoints may be chosen without expressing a preference among
them, so a conversation stays on whichever pool member holds its cache. **This
distinction is assumed and not documented** — OpenRouter is silent about `only`
and stickiness. If the assumption is wrong the pool is costing cache hits;
`ENFORCE_PROVIDER_POOL=false` is the one-variable revert and the routing
diagnostic's `drift` figure is what would reveal it.

Two escape hatches exist because a wrong or renamed slug inside `provider.only`
is an outage rather than a degraded route:
`ENFORCE_PROVIDER_POOL=false` returns the pool to advisory with the ceiling
intact, and `PROVIDER_POOL_OVERRIDE=glm-4.7:deepinfra|novita` replaces one
model's pool. Neither needs a deploy.

### 1.2 The price guard is no longer dropped on the final attempt

Previously the last of three attempts lifted the ceiling entirely, on the
argument that one dear generation beats a failed turn mid-scene.

**The argument is real. The default was wrong.** It converted a provider outage
— which happens at the hour nobody is watching — into unbounded spend, with no
operator decision anywhere in the loop.

Now, in `cost_guarded`, **all** attempts are: the same model, inside the
approved pool, under the ceiling. When every approved endpoint has failed the
reader is told *"The model is temporarily unavailable. Please try again in a
moment"* — which is true, and is a `502` rather than a surprise on the invoice.

| | |
|---|---|
| **Behaviour when all affordable providers fail** | Clean `upstream_unavailable`; no expensive fallback |
| **Emergency expensive fallback** | `GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK`, **default `false`** |
| **Benchmark mode** | Bypasses the restriction deliberately — measuring an endpoint means being able to reach it |
| **Privacy floor during an emergency** | **Never lifted.** Permission to spend more is not permission to have a transcript trained on. |

The routing diagnostic reports whether the hatch is armed, because "the ceiling
held all month" and "the ceiling held because nothing failed three times" are
different facts and only one is reassuring.

### 1.3 The ten-minute sticky-session claim: verified, and confined to prose

The sentence *"Sticky sessions expire after 10 minutes of inactivity. Each
successful request resets the timer"* is attributed to OpenRouter's own
prompt-caching documentation
(`openrouter.ai/docs/guides/best-practices/prompt-caching`) by two independent
search-index retrievals. **The page itself could not be fetched.**

Verdict: **documented-and-indexed, not read first-hand.** That is enough to keep
the figure in prose with its provenance attached, and nowhere near enough to
build on — so **the duration is encoded in no application behaviour anywhere.**
No timer, no threshold, no expiry arithmetic; a grep for it hits only
`docs/glm-cost-routing.md`. The operative statement remains the safe one:

> Provider affinity and prompt caches may become cold after inactivity, so a
> later request may need to establish a new warm provider session.

### 1.4 Retest after the corrections

All green — see §12.

---

## 2. Live model, provider and pricing table

**Every row read from a web search index on 2026-08-31, not from the API.**
Sources conflicted on GLM 5.3 Flash pricing (see §3), and those conflicts are
reported rather than averaged away.

| Model | Slug | Context | Max out | Fresh in | Cached in | Out | Notes |
|---|---|---:|---:|---:|---:|---:|---|
| GLM 4.7 | `z-ai/glm-4.7` | 204,800 | 131,072 | $0.40–0.60 | $0.08–0.11 | $1.75–2.20 | 7 hosts; pool takes 3 |
| GLM 5.3 Flash | `z-ai/glm-5.3-flash` | 1,310,720 | 131,072 | $0.15 list | ~$0.03 | $0.50 list | ~20 hosts |
| Ling 3.0 Flash | `inclusionai/ling-3.0-flash` | 262,144 | 32,768 | $0.021 | *unconfirmed* | $0.063 | 124B MoE, ~5.1B active |
| Ling 3.0 Flash (free) | `inclusionai/ling-3.0-flash:free` | 262,144 | 32,768 | $0 | $0 | $0 | rate limited |
| Qwen3.8 Flash | `qwen/qwen3.8-flash` | 1,000,000 | 131,072 | $0.15 | $0.016 | $0.47 | multimodal reasoning |
| MiniMax M2.5 (free) | `minimax/minimax-m2.5:free` | 196,608 | — | $0 | $0 | $0 | rate limited |
| DeepSeek V4 Flash 0731 | `deepseek/deepseek-v4-flash-0731` | 1,310,720 | 393,216 | $0.03 | *unconfirmed* | $0.16 | ~30 hosts |
| DeepSeek V4 Flash (direct) | DeepSeek API | — | — | $0.44 peak | $0.014 peak | $1.32 peak | memory incumbent; off-peak is half |

### Normal price versus temporary discount

**GLM 5.3 Flash is the only model in this lineup with a live promotion, and it
matters.** Reported list is **$0.15/M in, $0.50/M out**; a launch discount of
roughly half — **$0.075 in, $0.015 cached, $0.25 out** — was reported as running
until **24:00 on 2026-09-09 (UTC+8)**, i.e. **nine days from this sprint**.

Everything shipped is built on the **list** price:

* the catalogue's ceiling is $0.20/$0.60 — above list, so it does not
  self-destruct on 2026-09-10;
* the usage fallback rate table records list, so spend reports do not become
  quietly wrong overnight;
* the cost model in §8 prints list and discount as separate tables, and labels
  the discount `← TEMPORARY, do not build on this`.

One further conflict worth recording: a third-party tracker reported
$0.05/M in, $0.1667/M out with cache read $0.01/M for the same model — lower
than both list and the promotion. That is either a different endpoint's price or
a stale figure, and it was **not** used anywhere.

---

## 3. GLM 5.3 Flash: Relace versus Makora

### The result is: NOT MEASURED. The premise is unverified.

The brief states that Relace is extremely cheap with slower streaming and Makora
dearer but substantially faster. **Neither half of that could be confirmed from
this environment**, and no source reachable through the search index gave
per-endpoint latency, throughput or pricing for this model. Model-level figures
were available and they disagreed with each other:

| Cited figure | Source class | Meaning |
|---|---|---|
| TTFT ~1.47s, output ~50.2 tok/s | independent benchmark aggregate | model-level, endpoint unknown |
| **Median TTFT ~42 s** on a reasoning-heavy suite | independent benchmark aggregate | *with reasoning on* — the model thinks before it speaks |
| Throughput 40–130 tok/s "depending on provider and load" | secondary | confirms endpoints differ; quantifies nothing |
| Context ceiling varies 262K–1.31M across providers | secondary | endpoints are **not** interchangeable |

**The 42-second figure is the single most consequential number found in this
sprint**, and it is not about Relace or Makora at all — it is about *reasoning*.
See §4.

### What shipped in place of a measurement

Two catalogue entries, `glm-5.3-flash` and `glm-5.3-flash-economy`, presented to
readers as **Fast** and **Economy** — an experience, never a vendor. They carry
the **same** price ceiling and the **same** capabilities, and differ only in
`preferredProviders` (Economy prefers `relace`). Giving Economy a lower ceiling
would encode the unverified premise in production behaviour.

`scripts/serving-profile-benchmark.mjs` is what settles it. It pins each
endpoint in turn and reports TTFT p50, throughput p50, time to 500/1K/2K tokens,
cache-hit ratio, effective input price, cost per generation and per 100, plus
failure, timeout and 429 rates. It states two verdicts in words:

* `✗ P50 TTFT over 30s — dead for interactive chat, whatever the prose is like`
* `! very low streaming throughput — usable, but Economy at best`

It prints its worst-case spend before sending a byte, supports `--estimate-only`,
and refuses to start above `--budget`. A default 2-arm, 10-turn run estimates
**~$0.19 worst case**.

---

## 4. Reasoning on versus off

**This is the one behavioural finding with external evidence behind it, and it
changed what shipped.**

Independent benchmarking put GLM 5.3 Flash's median time-to-first-token on a
reasoning-heavy suite in the **tens of seconds**, explicitly because mandatory
reasoning at the default setting means the model thinks before it speaks. A
reader mid-scene will have switched tabs. And the reasoning in question is
coding- and agent-oriented; there is no evidence it helps roleplay at all.

So `ModelCapabilities` gained `reasoningDefault`, and **GLM 5.3 Flash and
Qwen3.8 Flash default to `"off"`**. Three states are preserved, and the middle
one is not a denial — omitting `reasoning` accepts the endpoint's default, which
on a hybrid model *is* reasoning. That distinction has already cost this
codebase one live bug.

Precedence: an engine that explicitly wants thinking wins; then a
deployment-wide `RP_REASONING=off`; then the model's declared default; then
silence.

The A/B that would confirm or overturn this is in
`tests/eval/writer-models.test.ts` — three arms (`true`, `"off"`, unstated) over
GLM 5.3 Flash and Qwen3.8 Flash, reporting latency, reasoning-token share,
output cost and reply length, with the decision rule printed alongside.

---

## 5. Ling 3.0 Flash, Qwen3.8 Flash, and the free endpoints

### Ling 3.0 Flash — NOT MEASURED

Added as **Economy** on price alone: $0.021/M in, $0.063/M out, 262K context,
32,768 max output, 124B MoE with ~5.1B active per token. That is roughly a
twentieth of GLM 4.7's fresh-input rate, which is what makes it the natural
funded-fallback candidate.

**The community research pass found no roleplay signal for it whatsoever** — not
poor reports, *no* reports. Its RP quality is an open question and it is
promoted on nothing.

Its `:free` endpoint is a **separate route** with separate latency, throughput
and privacy properties and is benchmarked separately. The cost model
deliberately assumes its cached-input rate **equals** its fresh rate, because no
cache-read rate could be confirmed and assuming a discount nobody verified would
make the cheapest candidate look cheaper still.

### Qwen3.8 Flash — NOT MEASURED

Added as **Experimental**. $0.15/M in, $0.016/M cached, $0.47/M out, 1M context.
Alibaba positions it for coding, agentic workflows and document analysis.
Strong benchmarks in those categories say nothing about holding a character for
ninety turns, and this catalogue does not promote a model on results from a
different job. Reasoning defaults off, per §4.

### The free endpoints actually shipped

| Route | Status | Why |
|---|---|---|
| `inclusionai/ling-3.0-flash:free` | **shipped** | slug confirmed via search index; 262K context |
| `minimax/minimax-m2.5:free` | **shipped** | slug confirmed via search index; 196K context |
| MiniMax M2.7 `:free` | **absent** | could not be confirmed to exist as a `:free` route |
| MiniMax M3 `:free` | **absent** | model confirmed; `:free` variant not |
| Nemotron 3 Ultra `:free` | **absent** | reported "available at $0"; `:free` slug not confirmed |

Absent rather than guessed at, deliberately: a wrong slug is a route that 404s
for every reader on the free tier. `scripts/free-route-screen.mjs --discover`
enumerates the live free catalogue; `--probe` screens candidates and prints the
SQL to enable what passes. **The SQL is printed, not executed** — "the benchmark
said yes" is not the same as "we are willing to put readers' stories through
it".

One corroborated and load-bearing fact: **free slugs change weekly.** That is
the entire justification for §7's server-owned config layer.

### Free endpoint latency, throughput and uptime — NOT MEASURED

No probe was possible. The floors the product enforces are:

| Gate | Default | Effect |
|---|---|---|
| P50 TTFT | 30,000 ms | **Hidden** from the picker and refused at generation time |
| Throughput | 15 tok/s | **Deprioritised** — sinks within its shelf, never hidden |
| Uptime (screen only) | 90% | Fails the curation screen |

The hard gate removes a route from the *picker*, never from the database: it
returns the moment its measured latency does.

---

## 6. Free-model privacy audit

**Partially answered, and the part that was answered changes the design.**

From OpenRouter's own documentation, via the search index:

* OpenRouter does **not** log prompts or completions by default; it stores
  request metadata for billing.
* Whether a prompt is trained on, and how long it is retained, is **governed by
  the downstream provider's policy, not OpenRouter's**.
* Account settings distinguish five things, and **three of them are about free
  endpoints specifically**: *enable paid endpoints that may train on inputs*,
  *enable free endpoints that may train on inputs*, and — the one that matters
  most — **_enable free endpoints that may publish prompts_**.
* `provider.data_collection: "allow" | "deny"` excludes providers that store
  data non-transiently to train on it. `provider.zdr: true` restricts to
  zero-data-retention endpoints. **These are different guarantees**: a provider
  can retain logs for 30 days (failing ZDR) and never train (satisfying `deny`).

**"It costs nothing" and "it is safe to put a private roleplay through it" are
therefore entirely separate questions**, and a free endpoint that *publishes*
prompts has no business being an ordinary chat model at any price including
zero.

What shipped:

* `ModelCapabilities.dataPolicy`, declared per model, sent as OpenRouter provider
  preferences so the filter lives where the endpoint catalogue lives and keeps
  working when a provider changes policy.
* **Every** curated free route and every OpenRouter writer carries
  `dataCollection: "deny"`.
* The privacy floor is applied on **every** attempt including recovery, is **not**
  removed by `PROVIDER_ROUTING_MODE=auto`, and is **not** lifted by the emergency
  expensive fallback.
* `scripts/free-route-screen.mjs` reports per-endpoint `trains` / `publishes` /
  `retains` / `uptime` **without averaging them**, and fails a route outright if
  any endpoint may publish prompts, or if every endpoint trains (in which case
  the privacy floor would leave nothing to route to).

**Per-route provider privacy findings could not be produced here** — that needs
the endpoints API. The screen is what produces them.

---

## 7. The free tier

### One account, one pool, and the sentence that follows from it

OpenRouter's documentation states: *"Making additional accounts or API keys will
not affect your rate limits, as we govern capacity globally."* Afterglow uses
**one** platform account. No workaround was built, considered or left as a
TODO.

Published free-model limits, via the search index: **~50 requests/day** per
account, rising to **~1,000/day** once the account has ever purchased $10 of
credit, against a **fixed 20 requests/minute** ceiling that credit does not
raise. **Failed attempts count against the daily quota.**

That last point shapes the refund semantics: releasing a reservation gives the
**reader** their allowance back; it cannot give the **platform** its upstream
request back. The code says so where it matters, and OpenRouter's 429 remains
authoritative on whether real capacity is left.

So the only honest product sentence is:

> A limited shared pool of free generations each day. Availability depends on
> provider capacity.

Never "50 free messages per user".

### Architecture

Two ledgers, both binding, in `supabase/migrations/0031_free_tier_and_curated_routes.sql`:

* `free_tier_pool_days` — the **platform's** day, keyed `(utc_day, funding)`
* `free_tier_user_days` — one **reader's** day, keyed `(user_id, utc_day, funding)`
* `free_tier_reservations` — what makes settling idempotent

`funding` separates `shared_free` from `platform_funded`, because they exhaust
independently and rolling them together would hide exactly the transition an
operator needs to see.

**Atomicity** lives in the UPDATE, not in a read-then-write:

```sql
INSERT INTO free_tier_pool_days (utc_day,funding) VALUES ($1,$2) ON CONFLICT DO NOTHING;
UPDATE free_tier_pool_days SET reserved=reserved+1
 WHERE utc_day=$1 AND funding=$2 AND reserved - released < $3 RETURNING reserved;
```

PostgreSQL locks the row, and a transaction blocking on a concurrent update
re-evaluates its predicate against the committed version. Zero rows back means
the cap was reached — by this request or by whoever won the race, and the answer
is the same either way. `reserved - released` is what a cap compares against, so
a release genuinely returns capacity.

* **Refund before inference**: released. **Failure after prose streamed**: spent
  — the tokens were produced and the allowance was consumed.
* **Double settlement**: impossible. `WHERE state='reserved'` claims once.
* **Abandoned reservations**: `sweepStaleReservations` releases anything left
  open past a generous threshold, so a died-mid-request process cannot hold
  capacity forever.
* **Day boundary**: UTC, matching the quota being divided. A local-midnight
  reset would hand one timezone a second allowance out of an already-spent day.
* **Anti-farming**: `FREE_MIN_ACCOUNT_AGE_MINUTES` (default 30). Minutes, not
  days: the goal is to make scripted signups unrewarding, not to make a real
  reader wait.

### What the reader is told

`freeTierStatus()` returns their **own** remaining count and a **boolean** for
whether shared capacity exists. The platform's exact remaining figure is
deliberately absent — it is a fact about Afterglow's OpenRouter account, and it
invites refreshing until a number goes up. Both sentences the product needs are
answerable from a boolean:

> *N of M free generations available today. Capacity is shared, so it is not guaranteed.*
> *Today's shared free capacity has been used. It comes back at midnight UTC.*

### BYOK

A reader who has connected their own OpenRouter key and selected a `:free` route
spends **their** quota. No reservation is taken, no pool is debited, and the
generation is recorded as `funding_source='byok'`. Charging the shared pool for
somebody who brought their own key would exhaust a scarce resource for everybody
else and report a cost nobody paid. Background memory, canon and Scene State
remain Afterglow-funded regardless, unchanged and enforced structurally: only
`rp_generation` can reach a user credential at all.

### The funded fallback, and why it asks

The ladder is: shared `:free` → *(if exhausted)* an ultra-cheap Afterglow-funded
writer → *(if that is exhausted or unconfigured)* the remedies.

**The default is a question, not a substitution.** When free capacity is gone
the chat route answers `429` with `reason: "free_capacity_exhausted"`, the
remedies in the order a reader mid-scene wants them, and — when one is
configured and within budget — the funded model **named**:

```json
{ "error": "Today's shared free capacity has been used. It resets at midnight UTC.",
  "reason": "free_capacity_exhausted",
  "remedies": ["use_funded_model", "wait_for_reset", "connect_byok", "choose_paid_model"],
  "fundedModelId": "ling-3.0-flash",
  "resetsAt": "2026-09-01T00:00:00.000Z" }
```

The client answers with `acceptFundedFallback: true`, the guards run **again**
(the budget may have gone in the seconds between), and only then is a slot
taken. Merely *asking* consumes nothing, so a crawler cannot drain the funded
budget by asking questions it never answers.

`FREE_FUNDED_FALLBACK_MODE=auto` lets Afterglow choose. Even then the
substitution is reported in the response and written to the ledger as
`platform_funded`. **There is no configuration in which a reader's writer
changes and nothing says so.**

A reader who has spent their **own** cap does not get the funded budget: that
would turn the per-user cap into a suggestion and hand the heaviest user the
funded money as well.

---

## 8. Cost of a funded free tier

From `scripts/free-tier-cost-model.mjs`. Input shape: **10,000 prompt tokens,
450 output tokens**, drawn from this repository's own measured prompt
distribution — `tests/prompt-cacheability.test.ts` establishes offline against
the real prompt builder that a writer request exceeds 8,000 tokens with a World
attached and that consecutive turns share ~76.8% of their bytes (81.2% when the
transcript anchor holds, 45.6% on the ~1-in-8 turns it moves). Monthly figures
assume 100 generations per reader per month.

**List prices. The GLM 5.3 promotion is excluded.**

| Model | 0% cache | 75% | 85% | 90% |
|---|---:|---:|---:|---:|
| GLM 4.7 (Z.AI) | $0.00699 | $0.00331 | $0.00282 | $0.00258 |
| GLM 4.7 (DeepInfra) | $0.00479 | $0.00239 | $0.00207 | $0.00191 |
| GLM 5.3 Flash (list) | $0.00172 | $0.00082 | $0.00071 | $0.00064 |
| Qwen3.8 Flash | $0.00171 | $0.00071 | $0.00057 | $0.00051 |
| **Ling 3.0 Flash** | **$0.00024** | $0.00024 | $0.00024 | $0.00024 |

*(Ling is flat because no cache-read discount could be confirmed and the model
conservatively assumes none.)*

**Cost per 100 / per 300 generations, at 75% cache hit:**

| Model | /100 | /300 |
|---|---:|---:|
| GLM 4.7 (DeepInfra) | $0.239 | $0.716 |
| GLM 5.3 Flash (list) | $0.083 | $0.248 |
| Qwen3.8 Flash | $0.071 | $0.212 |
| **Ling 3.0 Flash** | **$0.024** | **$0.072** |

**Projected monthly funded spend** (100 generations/reader/month):

| Model | 100 MAU | 1K MAU | 10K MAU |
|---|---:|---:|---:|
| GLM 4.7 (DeepInfra), 75% | $23.88 | $239 | $2,388 |
| GLM 5.3 Flash list, 75% | $8.25 | $82.50 | $825 |
| GLM 5.3 Flash list, 0% | $17.25 | $173 | $1,725 |
| **Ling 3.0 Flash, any** | **$2.38** | **$23.83** | **$238** |

**GLM 5.3 Flash under the launch discount** — reported separately because it
expires around 2026-09-09 and **nothing is built on it**: $4.13/100 gens at 75%
cache, $41.25/month at 1K MAU. Roughly half the list figure, and roughly half
of it disappears in September.

**Recommendation: Ling 3.0 Flash is the funded-fallback candidate on economics**
— an order of magnitude below GLM 5.3 Flash and two below GLM 4.7, and flat
against cache assumptions so the projection has no hidden dependency on a
discount arriving. **It is not a recommendation to ship it**, because its RP
quality is entirely unmeasured (§5). Both are needed.

The 0% row is the number to budget against: it is what a funded tier costs if
the cache never hits, and nothing in this sprint measured whether it does.

---

## 9. Hard spend guards

Four independent guards, deliberately not one clever number, because they fail
in different directions.

| Guard | Variable | Default | Stops |
|---|---|---|---|
| Route allowlist | `PLATFORM_FUNDED_MODELS` | **empty** | "the cheap route is unavailable, so we used the premium one" |
| Unbounded price | *(structural)* | — | funding any model with no `costCeiling` |
| Daily platform budget | `PLATFORM_WRITER_DAILY_BUDGET_USD` | 0 | the unbounded night |
| Per-account budget | `PLATFORM_WRITER_USER_DAILY_BUDGET_USD` | 0 | one client draining the budget before anybody wakes |
| Free-pool caps | `FREE_SHARED_DAILY_POOL` / `FREE_USER_DAILY_CAP` | 40 / 10 | the free tier outrunning the upstream quota |
| Per-million ceilings | `costCeiling` → `provider.max_price` | per model | an endpoint above the envelope being selected |

Two design choices worth stating:

* **A curated free route never passes through the dollar guard.** It costs
  nothing, so a dollar budget has nothing to say about it, and routing it
  through would mean an unset budget disabled the free tier — precisely
  backwards. What bounds a free route is the shared pool.
* **An unreadable ledger means no funded spend.** `fundedSpendToday` returns
  infinity on a database failure, refusing the funded fallback. The safe
  direction here is the opposite of the usual one: an unreadable budget must not
  be treated as an unspent budget.

When a guard trips, the request is refused honestly or another explicitly
approved free route is used. **It is never satisfied by reaching for a dearer
model.**

---

## 10. Community RP research

**This is the weakest section in the document and it is weak for an
environmental reason.** Reddit is not meaningfully indexed by the available
search tool, direct page fetches are blocked, and the SillyTavern community's
primary venues could not be read. What follows is what multiple search
retrievals agreed on; single-source claims are marked.

### Repeated signals

* **The GLM family is the community's roleplay backbone in 2026.** GLM 5.2
  described as "the consensus pick" after landing on OpenRouter, with GLM 5.1
  as "the cautionary tale"; GLM 5.1 reported ranked #2 overall for RP with
  "zero censorship". **GLM 4.7 sitting at the top of Afterglow's Recommended
  shelf is consistent with community consensus.**
* **MiniMax M2 "Her" tops dedicated roleplay leaderboards for persona
  adherence**, specifically for holding a character across ~100 turns where
  general-purpose models "start bleeding persona after twenty or thirty".
  **Afterglow already has `minimax/minimax-m2-her` in the catalogue.** This
  sprint promoted it from an unlabelled entry to **Recommended** — the only
  promotion made on community evidence rather than on a benchmark, and made
  because persona adherence over long conversations is the single axis
  Afterglow cares most about.
* **DeepSeek V4 "turned out to be actually good"** and is named alongside GLM as
  a community-favourite backend for companion and roleplay setups. Consistent
  with keeping it as the memory incumbent.
* **Kimi is repeatedly named as the best *free-tier* prose**, with "more
  textured prose than most free models" and dodging the "flat, hedge-everything
  tone that free tiers usually slump into".

### Explicit non-findings

* **MiniMax M2.7 is not an RP model.** Described as the general-purpose /
  agentic flagship optimising for "breadth in reasoning, coding, maths and
  multilingual", while M2-Her optimises for "depth in sustained, coherent,
  emotionally intelligent conversation". **This is why M2.7 was not added as an
  RP writer**, and it is a direct answer to the brief's suggestion to consider
  its free endpoint as a flagship candidate.
* **GLM 5.3 Flash is positioned for "efficient coding and long-horizon agent
  tasks"** — not for prose. No community RP signal for it was found at all.
  Combined with §4's TTFT finding, this is the substance behind the brief's
  instruction not to judge it on coding benchmarks.
* **Ling 3.0: nothing.** No RP discussion found in any retrieval.
* **Qwen3.8 Flash: nothing** for RP.

### Mainstream versus explicit fine-tunes

TheDrummer's models — already in Afterglow's catalogue — are community fine-tunes
built for immersive roleplay: Cydonia 24B V4.1 (Passion Fruit) "uncensored and
creative writing… good recall, prompt adherence", 131K context; Skyfall 36B V2
(Midnight Cherry) "fine-tuned for improved creativity, nuanced writing,
role-playing"; Rocinante 12B (Wild Peach) the lightweight fast option. The
recurring community framing — Rocinante fast, Cydonia richer over long sessions
— matches how the catalogue already describes them.

**"Will output NSFW" and "good RP" are not the same claim, and no source
conflated them for us.** The mainstream Chinese models (GLM, DeepSeek, MiniMax)
are reported as low-refusal *and* high-quality; the fine-tunes are reported as
uncensored *and* smaller. Those are different trades.

### Ranked shortlist

**A — Flagship RP candidates.** GLM 4.7 *(shipped, Recommended)*; MiniMax
M2-Her *(shipped, promoted to Recommended)*; MiMo V2.5 Pro *(shipped,
Recommended)*. Multiple independent signals for the first two; MiMo Pro on this
deployment's own prior work.

**B — Best adult-capable mainstream.** GLM family, DeepSeek V4, MiniMax — all
reported low-refusal with real prose quality. **Afterglow's engines carry the
de-escalation and consent contracts regardless of model**, which is where that
work belongs.

**C — Best economy.** Ling 3.0 Flash on economics alone *(unmeasured quality)*;
GLM 5.3 Flash Economy *(unmeasured)*; MiMo V2.5 *(shipped)*; DeepSeek V4 Flash
*(shipped)*.

**D — Best genuinely free.** Kimi is the one repeated community recommendation
and **is not currently offered as a `:free` route** — worth screening. The two
shipped free routes (Ling, MiniMax M2.5) are shipped on *availability*, not on
quality evidence.

**E — Interesting uncensored fine-tunes.** Cydonia 24B V4.1, Skyfall 36B V2,
Rocinante 12B — all already in the catalogue. Valkyrie 49B V1 (Llama 3.3
Nemotron Super) is the one new name found and is not integrated.

**F — Not worth integrating now.** MiniMax M2.7 as an *RP writer* (agentic
flagship, wrong job). Qwen3.8 Flash beyond Experimental until measured.

**Disagreement to note explicitly:** GLM 5.3 Flash's TTFT is reported as both
~1.5s and ~42s by the same benchmark family, and the difference is almost
certainly reasoning on versus off. Until §4's A/B runs, treat *both* as
unresolved.

---

## 11. Memory model economics

### Nothing moved, and that is the finding

`MEMORY_CONSOLIDATION_MODEL_ROUTE` and `MEMORY_CURATION_MODEL_ROUTE` still name
DeepSeek's own endpoint. **No benchmark was run, so no migration was made.**

### The Relace / DeepSeek 0731 check — and a real trap found

The brief asks whether "Relace DeepSeek V4 Flash 0731" is meaningfully
equivalent to the model Afterglow uses. From the search index:

| Fact | Consequence |
|---|---|
| The **undated** OpenRouter slug `deepseek/deepseek-v4-flash` resolves to the **0423** revision | The obvious slug is *not* the same checkpoint |
| `deepseek/deepseek-v4-flash-0731` is a separately listed, **re-post-trained** GA revision | A different model's behaviour under the same family name |
| Afterglow's incumbent runs on **DeepSeek's own API**, not OpenRouter | A third checkpoint, potentially |
| Served by **~30** upstream endpoints at widely varying prices | "Dramatically cheaper" describes the *cheapest endpoint*, not the model |
| $0.03/M in, $0.16/M out, 1.31M context, 393K max output | ~14x cheaper input, ~8x cheaper output than direct DeepSeek at peak |

**"Same family name" therefore does not mean "same model behaviour" here, and
the evidence says so explicitly rather than by analogy.** For a *writer* a
re-post-trained revision shows up as taste. For the **consolidator** it shows up
as which facts get extracted and which open commitments get marked resolved —
and a wrongly resolved promise deletes a thread the reader was waiting on,
silently and permanently, after which the archive actively argues against
restoring it.

So `deepseek-v4-flash-0731` was added to the catalogue as an **Experimental**
entry wired to **nothing**, purely so the head-to-head can be run. A test
asserts it stays that way.

### The harness

`tests/eval/memory-models.test.ts`, challengers now defaulting to
`deepseek-v4-flash-0731, mimo-v2.5, mimo-v2.5-pro, glm-5.3-flash,
ling-3.0-flash`. It runs a deterministic window with a deliberate trap: **one**
commitment is genuinely kept (the boat, returned ahead of the tide), one is
discussed and explicitly **not** kept (the lighthouse), one is mentioned in
passing and acted on by nobody (the attic).

False resolutions are now scored on **their own line**, not folded into a
quality average:

```
FALSE RESOLUTIONS — the severe failure, counted on its own:
  <model>: DISQUALIFYING — resolved lighthouse (explicitly NOT kept)
```

A challenger within noise on nine axes and wrong on this one is a **rejection,
not a trade**. The eleven axes are named in `memoryQualityAxes` so a partial run
is visibly partial.

### Recommendation

**Keep direct DeepSeek.** The cost case for 0731 is strong enough to be worth
the benchmark and is not itself an argument: a cost ratio says nothing about a
model that decides which of a reader's promises get marked kept. Run
`MEMORY_EVAL=1 OPENROUTER_API_KEY=… npx vitest run tests/eval/memory-models.test.ts`
over several windows, and migrate only on equivalence in promise-resolution
precision and hallucinated memories specifically.

---

## 12. Exact changes, and validation

### Catalogue

**Added:** `glm-5.3-flash` (Recommended, Fast profile) · `glm-5.3-flash-economy`
(Economy profile, prefers `relace`) · `ling-3.0-flash` (Economy) ·
`qwen3.8-flash` (Experimental) · `deepseek-v4-flash-0731` (Experimental,
background candidate, wired to nothing) · `ling-3.0-flash-free` (Free) ·
`minimax-m2.5-free` (Free).

**Changed:** every model gained a product `category` and a `free` flag; GLM 4.7
relabelled "GLM 4.7 Premium" with verified context/output limits, a
cache-capable pool and a privacy floor; `minimax-m2-her` promoted to
Recommended on community evidence; `affordableProviders` → `cacheCapableProviders`
with enforcement on by default; new capabilities `dataPolicy` and
`reasoningDefault`.

**Removed:** nothing. No conversation's stored writer changed.

### New modules

`src/lib/free-tier.ts` · `src/lib/route-health.ts` ·
`src/lib/curated-routes.ts` · `src/lib/spend-guards.ts` ·
`src/lib/writer-funding.ts` · migration `0031_free_tier_and_curated_routes.sql`.

### New scripts

`provider-pool-audit.mjs` (free, schedulable, exits 1 on a bad pool) ·
`serving-profile-benchmark.mjs` (Relace/Makora, budget-guarded) ·
`free-route-screen.mjs` (discovery, screening, privacy) ·
`free-tier-cost-model.mjs` (no credentials needed).

### Validation

| | |
|---|---|
| **Tests** | `npx vitest run` — **109 files passed, 4 skipped; 1,527 passed, 113 skipped**. 45 new tests across `free-tier`, `free-model-catalog`, `writer-funding`. |
| **Lint** | `npx eslint .` — clean |
| **Typecheck** | `npx tsc --noEmit` — clean |
| **Build** | `npm run build` — succeeds |

Two real bugs were found by writing the tests: the route-health read used
`= ANY($1)`, which the parser behind the schema suite answers with **no rows
rather than an error** (every route would have looked permanently healthy); and
the funded-spend query cast a date in SQL, so the budget read failed, returned
infinity, and refused the fallback for a reason unrelated to money.

### Paid tests NOT run

**All of them.** No credentials, no egress.

| Harness | Command | Answers |
|---|---|---|
| `scripts/provider-pool-audit.mjs` | `OPENROUTER_API_KEY=… node …` | Is the GLM 4.7 pool still correct and cache-capable? **Run this first.** |
| `scripts/serving-profile-benchmark.mjs` | `… --providers relace,makora` | Relace vs Makora: TTFT, throughput, cache, cost |
| `scripts/free-route-screen.mjs` | `… --discover` then `… --probe` | Which free routes exist, perform and are private enough |
| `tests/eval/writer-models.test.ts` | `WRITER_EVAL=1 …` | GLM 5.3 Flash vs GLM 4.7 RP quality; reasoning A/B |
| `tests/eval/memory-models.test.ts` | `MEMORY_EVAL=1 …` | DeepSeek 0731 vs direct DeepSeek |
| `scripts/glm-routing-benchmark.mjs` | *(pre-existing)* | Does the cache actually hit? |

Suggested funnel: **pool audit** (free) → **free-route screen** without
`--probe` (free) → **serving-profile benchmark** (cents) → **short RP screen** →
**full RP evaluation on finalists only**.

### Deployment and configuration

Apply migration `0031`. Everything else is **off by default** and additive:
`ENABLE_FREE_TIER=false`, funded fallback unset and zero, spend budgets zero,
`GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK=false`. The one default that **changed**
is `ENFORCE_PROVIDER_POOL=true` — GLM 4.7 now routes only to `deepinfra`,
`novita`, `z-ai`. **Run the pool audit before deploying that**, and keep
`ENFORCE_PROVIDER_POOL=false` in your pocket. All variables are documented in
`.env.example`.
