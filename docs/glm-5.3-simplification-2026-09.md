# GLM 5.3 Flash: one model, one host

What changed, why, and what an operator has to do about it. Written for whoever
has to reason about this at three in the morning.

## What the product used to offer

Two catalogue entries — `glm-5.3-flash` ("Fast") and `glm-5.3-flash-economy`
("Economy") — presented in the picker as two writers with a shelf and a tag
each. They were the **same weights behind the same slug**, `z-ai/glm-5.3-flash`.
What differed was `preferredProviders`, and each of them routed across a pool of
four or five upstream hosts.

Two things were wrong with that at once.

**The choice was unanswerable.** The premise separating the profiles — that one
class of endpoint is cheap-and-slow and another dear-and-fast — was never
verified from this deployment; `docs/model-lineup-2026-08.md` says so in its own
words, and shipped both profiles with the *same* price ceiling for exactly that
reason. A reader choosing between them was choosing between two sentences
nobody had measured.

**The writer was not stable.** Up to five hosts serving one slug is up to five
quantisations, samplers and truncation behaviours, chosen per request by
somebody else's router. "Why did this reply come out differently from the last
one" had no answer available to anybody, and neither did "which writer wrote my
story".

## What it offers now

One entry. `glm-5.3-flash`, labelled **GLM 5.3 Flash**, on the Recommended
shelf, served by **Z.AI** — the model's own vendor, and the one endpoint whose
behaviour is the model's rather than a re-host's.

Every request, on every attempt:

```json
{ "model": "z-ai/glm-5.3-flash",
  "session_id": "<per-conversation>",
  "reasoning": { "enabled": false },
  "provider": { "only": ["z-ai"],
                "allow_fallbacks": false,
                "max_price": { "prompt": 0.20, "completion": 0.60 },
                "data_collection": "deny" } }
```

**No `order` and no `sort`, ever.** Both are ways of choosing between
candidates, there is one candidate, and OpenRouter documents that either turns
its own sticky session routing off — which is the routing the prompt cache
depends on. Sending them would cost the cache to say nothing.

**No `ignore` on a retry.** Excluding the host that just failed is right when
others serve the model; here it would empty the candidate set and turn a retry
into a guaranteed "no allowed providers". Retrying the same host is what a
transient 5xx deserves.

## What is kept

| Property | State |
|---|---|
| Stable per-conversation `session_id` | unchanged — and worth more now, since one host is one cache |
| Prompt caching | unchanged (`promptCaching: true`) |
| Anchored transcript / continuity placement | unchanged |
| Reasoning | off by default (`reasoningDefault: "off"`); an engine that asks for thinking still wins |
| Price ceiling | kept as defence in depth: $0.20 / $0.60 per M, from the **list** price, not the launch discount |
| Privacy floor | kept: `data_collection: "deny"`, never traded against availability |
| Context / output limits | unchanged: 1,310,720 / 131,072 |

## When Z.AI is down, the model is down

This is deliberate and it is the point of the change. OpenRouter answers 404
with "No allowed providers are available for the selected model";
`classifyProviderFailure` reads that as `upstream_unavailable`, and the reader
sees:

> The model is temporarily unavailable. Please try again in a moment.

No upstream text, no status code, no provider name. The turn is theirs again and
they can pick another writer from chat tools if they would rather not wait.

**Nothing silently substitutes another upstream.** Answering a Z.AI outage with
a different serving profile under the same name would be cheaper for us and a
change of writer nobody consented to.

## Which switches do and do not reach this

`dedicatedProvider` is a **product** decision, not an economic one, so the cost
machinery cannot lift it:

| Variable | Effect on GLM 5.3 Flash |
|---|---|
| `PROVIDER_ROUTING_MODE=auto` | drops `max_price`; `only: ["z-ai"]` and fallbacks-off **stay** |
| `PROVIDER_ROUTING_MODE=cost_optimized` | no effect: one candidate is one price, so no `sort` is sent |
| `ENFORCE_PROVIDER_POOL=false` | no effect: this is not an advisory pool |
| `GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK=true` | no effect on the host; the final attempt is still Z.AI only |
| `PROVIDER_POOL_OVERRIDE=glm-5.3-flash:novita` | **moves** the host, still exclusively, still with fallbacks off — the deploy-free control if Z.AI is renamed or out for a day |
| `PROVIDER_ROUTING_MODE=benchmark` + `PIN_UPSTREAM_PROVIDER=glm-5.3-flash:<host>` | measurement only; takes both variables together, so a forgotten pin is inert |
| `RP_REASONING=auto` / `off` | unchanged deployment-wide reasoning overrides |

## Measuring another host

Preserved, and unchanged: `scripts/serving-profile-benchmark.mjs` takes upstream
slugs and provider slugs **directly** rather than catalogue ids, so it can
measure any endpoint OpenRouter serves without one existing in the product
first. It prints its worst-case spend before sending a byte, supports
`--estimate-only`, and refuses to start above `--budget`.

```
OPENROUTER_API_KEY=… node scripts/serving-profile-benchmark.mjs \
  --models z-ai/glm-5.3-flash --providers z-ai,novita,deepinfra --turns 10
```

`scripts/provider-constraint-bisect.mjs` still adds production's constraints one
at a time to find which one turns a working request into a failing one; its
mirror of the catalogue now carries `allowFallbacks`, and
`tests/provider-incompatibility.test.ts` fails the build if the mirror drifts
from `src/lib/provider.ts`.

## Deployment

**No environment changes are required.** The defaults are correct as they stand.

Two things to check before rolling out, both about the withdrawn id
`glm-5.3-flash-economy`:

**Anything that names it explicitly must be repointed at `glm-5.3-flash`.**
That means `ALLOWED_MODELS`, `RP_MODEL_ROUTE`, `DEFAULT_LLM_MODEL` and the
background task routes. Leaving it in `ALLOWED_MODELS` is the one that fails
quietly rather than loudly: an id the catalogue has never heard of is admitted
as a deployment-configured **DeepSeek**-compatible model, so it would appear in
the picker under its raw id on the Experimental shelf and be routed nowhere near
OpenRouter.

**Conversations already stored on it are handled, not migrated.** The chat route
resolves a conversation's stored provider and model before anything is written
or spent, does not find this one, and answers 409 with "This chat's model is no
longer available. Choose another model in chat tools — your story, memories and
settings are untouched", which the client turns into the picker. Nothing is
silently substituted, and there is no migration because a conversation's stored
writer is the reader's choice to change.
