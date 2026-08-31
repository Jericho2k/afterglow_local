# GLM 4.7 cost and cache routing

What this deployment does about GLM 4.7's economics, why, and what is still
unproven. Written for whoever has to change it at three in the morning.

## The problem it addresses

A month of production GLM 4.7 traffic was served by four different upstream
hosts, with cache hit rates from 17% to 84%. The obvious reading — "conversations
are bouncing between providers" — **does not follow from that data**, and the
distinction decides what to fix.

An account-wide provider breakdown looks *identical* whether one conversation
hopped across four hosts or four conversations each settled on one. The first is
a routing bug; the second is working as designed. `/api/usage/routing` exists
solely to tell them apart, per conversation, in time order.

What *was* provably wrong is that nothing bounded the price of the host a
conversation landed on. OpenRouter's default routing is price-**weighted**, not
price-ordered: the cheapest endpoint is strongly preferred and never guaranteed.

## Prices

Per million tokens, fresh / cached / output. Reported by the operator from
OpenRouter's catalogue; corroborated for DeepInfra by secondary sources.

| Endpoint  | Fresh in | Cached in | Output |
|-----------|---------:|----------:|-------:|
| DeepInfra |    $0.40 |     $0.08 |  $1.75 |
| Novita    |    $0.54 |    $0.099 |  $1.98 |
| Z.AI      |    $0.60 |     $0.11 |  $2.20 |

**DeepInfra is cheaper than Z.AI on all three lines.** At equal cache hit rates
it is the cheaper home for a conversation. That is an argument for a ceiling,
not for a pin — see below.

## What production sends

For any model declaring a `costCeiling` in `src/lib/provider.ts` (today: GLM 4.7
only):

```json
{ "session_id": "<per-conversation>",
  "provider": { "allow_fallbacks": true,
                "max_price": { "prompt": 0.65, "completion": 2.25 } } }
```

**No `provider.order`. No `provider.sort`.** This is the load-bearing decision.
OpenRouter pins a conversation to the host holding its prompt cache from the
`session_id` Afterglow already sends, and its documentation states that setting
`order` turns that routing off. Cached input is roughly a fifth of fresh input,
so naming DeepInfra first would buy a cheaper *list* price by discarding the
cache that makes the *real* price cheap. The cheapest request is the one that
hits.

The ceiling admits DeepInfra, Novita and Z.AI, and excludes the ~$2.65/M output
endpoints. Three healthy hosts remain eligible, so it costs no availability.

### Recovery

Retries keep the ceiling and still sort by throughput — an attempt that has
reached recovery has already lost its cache, so the fastest **affordable** host
is right. Previously `sort: "throughput"` was sent with no ceiling at all, which
meant an ordinary timeout could move a conversation onto the dearest endpoint
serving the slug, at the moment nobody was watching, and stickiness would then
keep it there.

The **final** attempt lifts the ceiling. Two attempts have already been spent
inside the affordable set, so one dear generation beats a failed turn mid-scene.
No attempt ever substitutes a different *model*.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PROVIDER_ROUTING_MODE` | `cost_guarded` | `auto` reverts to pre-sprint behaviour exactly. `cost_optimized` adds `sort:"price"` (see caveat). `benchmark` enables pinning. |
| `ENFORCE_PROVIDER_ALLOWLIST` | unset | Turns each model's `affordableProviders` into a hard `provider.only`. **Verify the slugs first.** |
| `PIN_UPSTREAM_PROVIDER` | unset | `glm-4.7:deepinfra`. Requires `PROVIDER_ROUTING_MODE=benchmark`, so a forgotten pin is inert. |
| `TRANSCRIPT_ANCHOR_STEP` | `16` | Messages the transcript anchor moves in one go. Clamped to 2–64. |
| `RP_REASONING` | unset | `off` makes non-reasoning engines decline reasoning explicitly. See caveat. |
| `PROMPT_CONTINUITY_PLACEMENT` | auto | Pre-existing. `system` reverts the tail layout. |

An unrecognised `PROVIDER_ROUTING_MODE` falls back to `cost_guarded`, not to
`auto`: a typo must not quietly restore the behaviour the guard was added to
prevent.

## Verified, and not

**Verified from OpenRouter documentation:** `session_id` activates sticky routing
from the first successful request; sticky sessions expire after ~10 minutes of
inactivity; `order` and `sort` disable load balancing; `max_price` takes
`{prompt, completion, request, image}` in $/M and excludes endpoints above it;
`deepinfra`, `novita`, `z-ai` and `atlas-cloud` are OpenRouter provider slugs.

**Verified offline, against the real prompt builder** (`npx vitest run
tests/prompt-cacheability.test.ts tests/anchor-step-economics.test.ts`): a long
conversation's consecutive requests share 76.8% of their bytes; 81.2% on turns
where the anchor holds, 45.6% on the ~1-in-8 turns where it moves.

**NOT verified — needs a paid run of `scripts/glm-routing-benchmark.mjs`:**

- that any provider actually *serves* those identical prefixes from cache
- whether `sort: "price"` overrides session stickiness (why `cost_optimized`
  is not the default)
- that `deepinfra`/`novita`/`z-ai` are the slugs *for this model's endpoints*
  (why the allowlist is advisory)
- whether DeepInfra's quantisation changes GLM's RP quality versus Z.AI
- whether GLM emits billed reasoning tokens when `reasoning` is omitted, and
  whether declining it costs quality (why `RP_REASONING` defaults to unset)
- GLM's output-token verbosity per response-length mode

Until that run happens, the economics here are **modelled, not measured**.

## The ten-minute session window

Sticky sessions expire after about ten minutes of inactivity. A reader who
pauses longer than that between turns loses the pin, and the next turn is routed
fresh. This is a plausible explanation for an observed provider spread that
involves **no bug at all**, and it is not something Afterglow can prevent — but
it is exactly why the ceiling matters: the re-pick must be bounded, because it
will happen.

## Reading the diagnostic

`/api/usage/routing?range=30d` (admin only), also rendered in Settings →
Usage & cost → Routing & cache affinity.

- **`drift.driftedConversations` of `eligibleConversations`** — the headline.
  Zero means stickiness held and the provider spread was several warm caches,
  not one cold one.
- **`byProvider[].cacheRatio`** — provider-reported, authoritative.
- **`byProvider[].effectiveInputUsdPerMillion`** — **derived**: the reported
  charge less the output half at list rates. Null for an endpoint with no known
  price rather than a confident wrong number.
- **`byProvider[].reasoningTokens`** — non-zero here means GLM is billing for
  thinking nobody asked for.
