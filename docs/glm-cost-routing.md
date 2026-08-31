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

For any model declaring a `costCeiling` in `src/lib/provider.ts` (today: GLM 4.7,
both GLM 5.3 Flash profiles, Ling 3.0 Flash, Qwen3.8 Flash and the DeepSeek 0731
background candidate):

```json
{ "session_id": "<per-conversation>",
  "provider": { "only": ["deepinfra", "novita", "z-ai"],
                "allow_fallbacks": true,
                "max_price": { "prompt": 0.65, "completion": 2.25 },
                "data_collection": "deny" } }
```

Three guards, each answering something the others cannot.

**`only` is the approved pool** — endpoints that are *both* inside the price
envelope *and* cache-capable for prompt reads. This is the 2026-08 correction.
`max_price` bounds what an endpoint may **list**; it says nothing about whether
that endpoint discounts a cache read, and a roleplay turn resends the character,
world, persona and rules unchanged, so cached reads are most of the bill. An
endpoint that is under the ceiling and charges fresh prices for every repeated
byte passes the guard and defeats the objective.

**`max_price` stays on underneath it**, so a pool member that re-prices upward
falls out without anybody editing the catalogue.

**`data_collection: "deny"`** excludes endpoints that store prompts
non-transiently to train on them. It is not an economic guard and is never
traded against one.

**No `provider.order`. No `provider.sort`.** This is still the load-bearing
decision, and `only` is deliberately not `order`. OpenRouter pins a conversation
to the host holding its prompt cache from the `session_id` Afterglow sends, and
its documentation states that setting `order` turns that routing off. Restricting
the *candidate set* bounds which endpoints may be chosen without stating a
preference between them, so whichever pool member a conversation is already warm
on stays warm. Cached input is roughly a fifth of fresh input; naming DeepInfra
first would buy a cheaper *list* price by discarding the cache that makes the
*real* price cheap.

### Recovery

Retries keep the pool and the ceiling and still sort by throughput — an attempt
that has reached recovery has already lost its cache, so the fastest **eligible**
host is right. Previously `sort: "throughput"` was sent with no ceiling at all,
which meant an ordinary timeout could move a conversation onto the dearest
endpoint serving the slug, at the moment nobody was watching, and stickiness
would then keep it there.

### The final attempt no longer lifts the ceiling

It used to, on the argument that two attempts had already been spent inside the
affordable set and one dear generation beats a failed turn mid-scene. **The
argument is real and the default was wrong.** It converted a provider outage —
which happens at the hour nobody is watching — into unbounded spend, with no
operator decision anywhere in it.

Now every attempt is the same model, inside the approved pool, under the ceiling.
When they are all exhausted the reader is told the model is temporarily
unavailable, which is true. The emergency route survives behind
`GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK=true` (default false); benchmark mode
also bypasses, because measuring an endpoint means being able to reach it. Even
then the **privacy floor is not lifted**: an emergency permitted to spend more
money is not thereby permitted to send a private roleplay to an endpoint that
trains on it.

No attempt ever substitutes a different *model*.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PROVIDER_ROUTING_MODE` | `cost_guarded` | `auto` reverts the **cost** policy to pre-sprint behaviour and keeps the privacy floor. `cost_optimized` adds `sort:"price"` (see caveat). `benchmark` enables pinning. |
| `ENFORCE_PROVIDER_POOL` | `true` | Set `false` to make each model's `cacheCapableProviders` advisory again, with the ceiling still guarding spend. |
| `PROVIDER_POOL_OVERRIDE` | unset | Replace one model's pool without a deploy: `glm-4.7:deepinfra|novita`. |
| `GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK` | `false` | Lets the **final** retry exceed the ceiling when every approved endpoint has failed. Off by default: a provider outage must not become a surprise on the invoice. |
| `PIN_UPSTREAM_PROVIDER` | unset | `glm-4.7:deepinfra`. Requires `PROVIDER_ROUTING_MODE=benchmark`, so a forgotten pin is inert. |
| `TRANSCRIPT_ANCHOR_STEP` | `16` | Messages the transcript anchor moves in one go. Clamped to 2–64. |
| `RP_REASONING` | unset | `off` makes non-reasoning engines decline reasoning explicitly. See caveat. |
| `PROMPT_CONTINUITY_PLACEMENT` | auto | Pre-existing. `system` reverts the tail layout. |

An unrecognised `PROVIDER_ROUTING_MODE` falls back to `cost_guarded`, not to
`auto`: a typo must not quietly restore the behaviour the guard was added to
prevent.

## Verified, and not

**Verified from OpenRouter documentation:** `session_id` activates sticky routing
from the first successful request; `order` disables load balancing; `max_price`
takes `{prompt, completion, request, image}` in $/M and excludes endpoints above
it; `provider.data_collection` accepts `allow`/`deny` and `provider.zdr` is a
boolean; `deepinfra`, `novita`, `z-ai` and `atlas-cloud` are OpenRouter provider
slugs.

**Verified only through a search index, not fetched:** the ten-minute sticky
session window (see below), and the claim that DeepInfra, NovitaAI and Z.ai are
among the hosts serving `z-ai/glm-4.7`. This environment's egress policy denies
`openrouter.ai` outright, so no request to the catalogue or to `/api/v1/models`
was possible during the 2026-08 sprint. Run `scripts/provider-pool-audit.mjs`
from a deployment that has a key; it fails with exit code 1 when a pool member
is missing, dearer than its ceiling, or publishes no cache-read price.

**Explicitly NOT verified:** whether `provider.only` interacts with session
stickiness the way `provider.order` does. OpenRouter documents that `order`
turns its routing off and is silent about `only`. The design assumes restricting
the candidate set leaves stickiness intact; if that assumption is wrong, the pool
is costing cache hits and `ENFORCE_PROVIDER_POOL=false` is the one-variable
revert. The routing diagnostic's `drift` figure is what would show it.

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

## The session window, and how far the ten-minute figure is verified

The previous report stated flatly that sticky sessions expire after roughly ten
minutes of inactivity. Re-checked in 2026-08: the sentence *"Sticky sessions
expire after 10 minutes of inactivity. Each successful request resets the
timer"* is attributed to OpenRouter's own prompt-caching documentation
(`openrouter.ai/docs/guides/best-practices/prompt-caching`) by two independent
search-index retrievals. **The page itself could not be fetched** — egress to
`openrouter.ai` is denied here — so this is documented-and-indexed rather than
read first-hand.

That is enough to keep the figure in prose and nowhere near enough to build on,
so **the duration is not encoded in application behaviour anywhere**: no timer,
no threshold, no expiry arithmetic. Grep for it and the only hits are this
document.

The safe statement, which is the one to rely on:

> Provider affinity and prompt caches may become cold after inactivity, so a
> later request may need to establish a new warm provider session.

That is the whole operational consequence, and it is exactly why the pool and
the ceiling matter: the re-pick is going to happen, and it has to be bounded.

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
