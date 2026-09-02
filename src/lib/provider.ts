import type { ModelCatalog, ModelCategory, ModelDefinition, ProviderDefinition, RoleplayEngineDefinition, RoleplayEngineId } from "./types";
import { engineDefinitions } from "./engines";
import type { ModelVerbosity } from "./response-length";
import { isReasoningEffort, type ReasoningBudget, type ReasoningDirective, type ReasoningEffort } from "./reasoning";

export type InferenceTask = "rp_generation" | "memory_consolidation" | "memory_curation" | "scene_state" | "character_import";
export type InferenceSelection = { providerId: string; modelId: string };
/**
 * What one model can actually be asked for.
 *
 * The adapter used to send every model the same request body and the same
 * budgets, which is fine right up until a model is smaller than the others.
 * Midnight Cherry is: 32,768 tokens against 131,072 for its two siblings and a
 * million for MiMo. A long story with a World attached exceeds that, OpenRouter
 * answers 400, the category is `bad_request`, and the reader gets "Something
 * went wrong while generating the response" for a request that was never
 * sendable. That is the whole of the Midnight Cherry report.
 *
 * So capability is DATA, declared beside the model, rather than a growing nest
 * of name comparisons in the request builder.
 *
 * `contextTokens` is deliberately optional. It is set only where the limit has
 * been verified against the provider's own catalogue; an unverified number
 * would be a guess with the authority of a constant, and the budgeting code
 * treats "unknown" as "do not constrain" — which is exactly today's behaviour.
 */
/**
 * The most an endpoint may charge, per million tokens, to be eligible.
 *
 * Both figures are FRESH prices. OpenRouter filters on an endpoint's list
 * price, and a cached-input rate is a discount off that rather than a separate
 * ceiling to set, so naming only the two rates OpenRouter actually compares
 * keeps this honest about what it can enforce.
 */
export type ProviderCostCeiling = {
  /** USD per million fresh prompt tokens. */
  promptUsdPerMillion: number;
  /** USD per million completion tokens. */
  completionUsdPerMillion: number;
};

/**
 * The privacy floor a model's requests are sent with.
 *
 * Both fields map onto OpenRouter provider preferences, so the filtering
 * happens where the endpoint catalogue lives rather than being re-derived from
 * a table here that would go stale. They are NOT the same guarantee and are
 * therefore separate: `dataCollection: "deny"` means the endpoint does not use
 * the prompt to train a future model, while `zdr` means it does not retain the
 * prompt at rest at all. An endpoint can satisfy either without the other.
 */
export type ModelDataPolicy = {
  /** `deny` excludes endpoints that store prompts non-transiently to train on. */
  dataCollection: "allow" | "deny";
  /** True routes only to endpoints with a zero-data-retention policy. */
  zdr?: boolean;
};

export type ModelCapabilities = {
  /** Prompt plus completion, in tokens. Undefined means unverified. */
  contextTokens?: number;
  /** The largest completion the endpoint will produce. */
  maxOutputTokens?: number;
  /** Whether the endpoint accepts OpenRouter's `reasoning` parameter. */
  thinking: boolean;
  /** Whether `response_format: { type: "json_object" }` is honoured. */
  jsonMode: boolean;
  /** Whether sequential turns benefit from a stable `session_id`. */
  promptCaching: boolean;
  /**
   * Upstream endpoints to prefer, in order, when several serve this model.
   * Never a hard pin: fallbacks stay allowed so one provider's outage cannot
   * take the model down. A hard pin is available for benchmarking only, via
   * `pinnedProviderFor` below.
   */
  preferredProviders?: string[];
  /**
   * The most this model's traffic may cost per million tokens, per endpoint.
   *
   * Several upstream hosts serve one model at prices that differ by a factor
   * of several, and OpenRouter's default routing is price-WEIGHTED rather than
   * price-ordered: the cheapest endpoint is strongly preferred, not
   * guaranteed. A ceiling is the difference between "usually cheap" and "never
   * expensive", and it is expressed as a price rather than as a list of hosts
   * because price is the actual criterion — a slug list goes stale the moment
   * a provider re-prices or is renamed, and silently stops guarding anything.
   *
   * Sent to OpenRouter as `provider.max_price`, so the filtering happens where
   * the catalogue lives instead of being re-derived from a table here that
   * would need updating every time somebody changes a rate.
   */
  costCeiling?: ProviderCostCeiling;
  /**
   * THE APPROVED PRODUCTION POOL: endpoints that are BOTH inside the price
   * envelope AND explicitly cache-capable for prompt reads.
   *
   * `costCeiling` alone is not enough, and the reason is the whole point of
   * Afterglow's routing. An endpoint can satisfy a fresh-input and output price
   * ceiling while offering no discounted cache reads at all — and a roleplay
   * turn resends the character, world, persona and rules unchanged, so the
   * cached-read rate is most of what a conversation actually pays. A host that
   * is cheap on paper and charges fresh prices for every repeated byte is
   * dearer in practice than a host that lists higher and reads from cache.
   *
   * So membership requires both properties, and this list — not the ceiling —
   * is what `provider.only` carries in `cost_guarded` mode. The ceiling stays
   * on as defence in depth, because a pool member that re-prices upward must
   * still fall out.
   *
   * The residual risk is the one the previous sprint named: a slug that is
   * wrong or renamed upstream turns `only` into an outage for the model rather
   * than a degraded route. Two escape hatches answer it without a deploy —
   * `PROVIDER_POOL_OVERRIDE` replaces one model's pool, and
   * `ENFORCE_PROVIDER_POOL=false` puts the pool back to advisory with the
   * ceiling still guarding spend.
   */
  cacheCapableProviders?: string[];
  /**
   * THE ONE UPSTREAM HOST THIS MODEL IS SERVED FROM, AND NO OTHER.
   *
   * A pool is the right shape when several endpoints serve one slug acceptably
   * and the product is indifferent between them. It is the wrong shape when the
   * product is NOT indifferent — when the model's own vendor is the route the
   * deployment has chosen and every other host serving the slug is a different
   * serving profile with its own quantisation, sampler, truncation and cache
   * behaviour.
   *
   * GLM 5.3 Flash is the second case. Afterglow offers ONE GLM 5.3 Flash, and
   * "one model" has to mean one writer rather than one name over whichever of
   * twenty endpoints OpenRouter happened to draw — so the request names Z.AI
   * with `provider.only` and turns fallbacks OFF. When Z.AI cannot serve it
   * nothing else may, and the reader is told the model is temporarily
   * unavailable, which is true and is a better answer than a different writer
   * nobody chose.
   *
   * A dedicated model therefore sends NO `order` and NO `sort` on any attempt:
   * both are ways of choosing between candidates, there is only one candidate,
   * and OpenRouter documents that either turns its own sticky session routing
   * off — which is the routing the prompt cache depends on.
   *
   * It is not a cost policy and is not lifted by one. `PROVIDER_ROUTING_MODE=auto`
   * reverts the price ceiling; it does not re-open the other hosts, because
   * which writer a story is written by is a product decision rather than an
   * economic one. `PROVIDER_POOL_OVERRIDE` still moves the model deliberately,
   * and `PIN_UPSTREAM_PROVIDER` in benchmark mode still measures another host.
   */
  dedicatedProvider?: string;
  /**
   * What this model's traffic may let an upstream host do with a prompt.
   *
   * Roleplay transcripts are private conversations, and OpenRouter's own
   * documentation is explicit that whether a prompt is trained on, and how long
   * it is retained, is governed by the DOWNSTREAM provider's policy rather than
   * by OpenRouter's. It is also explicit that free endpoints have their own
   * account-level settings — including endpoints that may PUBLISH prompts —
   * which is precisely the class of route that must never quietly become a
   * normal chat model here.
   *
   * Expressed per model rather than globally because the answer genuinely
   * differs: a paid flagship can afford `deny` with no loss of availability,
   * while an experimental free route may have no compliant endpoint at all and
   * has to be labelled instead of silently served.
   */
  dataPolicy?: ModelDataPolicy;
  /**
   * What to send for `reasoning` when the ENGINE has not asked for it.
   *
   * Three states again, and the middle one is not a denial: `undefined` keeps
   * today's behaviour (say nothing, take the endpoint's default), `"off"`
   * declines reasoning explicitly, `"on"` asks for it. It exists because
   * "the endpoint accepts the parameter" and "reasoning is a good idea for
   * roleplay on this model" are different facts, and only the first one was
   * previously expressible.
   *
   * `"off"` is declared per model rather than set globally because the answer
   * genuinely differs. On a model that reasons before it speaks it is the
   * difference between a reply that starts in a second and one that starts in
   * tens of seconds; on a model with no such habit it buys nothing. Two
   * deployment-wide overrides beat it — `RP_REASONING=off` forces it on every
   * model, `RP_REASONING=auto` ignores these declarations and sends no
   * `reasoning` key at all — and an engine that explicitly wants thinking still
   * wins over all of them. See `defaultReasoningFor`.
   *
   * AN EFFORT IS THE THIRD ANSWER, AND SOME ENDPOINTS LEAVE NO OTHER. GLM 5.3
   * Flash on Z.AI answers `reasoning: { enabled: false }` with a 400 —
   * "Reasoning is mandatory for this endpoint and cannot be disabled" — so
   * `"off"` there was never a setting, it was a rejection followed by a
   * fallback to the endpoint's own default, which is MORE reasoning than
   * anybody asked for. Naming an effort asks for the least the endpoint will
   * agree to, which is the actual intention `"off"` was standing in for.
   */
  reasoningDefault?: ReasoningDirective;
  /**
   * WHETHER THIS ENDPOINT WILL LET US DECLINE REASONING AT ALL.
   *
   * Declared rather than discovered, because discovering it costs a reader's
   * turn: the discovery mechanism is a 400 mid-scene, and the request that
   * caused it is by definition the one a reader is waiting on. An endpoint that
   * has told us in production that reasoning is mandatory should never be asked
   * again — the first request has to be valid.
   *
   * It also outranks `RP_REASONING=off`. That switch is an operator saying
   * "spend nothing on thinking anywhere"; it is not an operator asking to send
   * a request we already know will be refused, and honouring it literally here
   * would rebuild the failure this flag records. `RP_REASONING=auto` still
   * removes the key entirely, which stays valid on a mandatory endpoint because
   * silence takes its default rather than contradicting it.
   */
  reasoningMandatory?: boolean;
  /**
   * HOW MUCH HIDDEN THINKING THIS MODEL'S ENVELOPE HAS TO HOLD.
   *
   * Reasoning tokens are billed and counted as completion tokens, so on a model
   * that must reason they come out of the same `max_tokens` as the prose. With
   * no allowance for them, a Natural reply's 1,800 tokens were spent entirely
   * on thinking and the generation ended at `finish_reason=length` with nothing
   * visible in it at all.
   *
   * Declared per model and absent by default: see src/lib/reasoning.ts. A model
   * that declares none sends exactly the envelope Response Length asked for,
   * which is what it has always sent.
   */
  reasoningBudget?: ReasoningBudget;
  /**
   * How much this model writes when nothing stops it.
   *
   * "expansive" is the reason Concise did not feel concise on MiMo, and it is
   * declared here rather than compared by name wherever a prompt is built: a
   * model's habits are a property of the model, exactly like its context
   * window. `src/lib/response-length.ts` is the only reader, and all it does
   * with the answer is state the paragraph ceiling as a hard limit instead of
   * implying it from a word target. Undefined means "normal", which is what
   * every model that has never been measured gets.
   */
  verbosity?: ModelVerbosity;
};

type InternalModelDefinition = ModelDefinition & { providerModelId: string; capabilities: ModelCapabilities };

/**
 * Deployment-owned inference catalog.
 *
 * Provider, base model, and roleplay engine are deliberately separate. A
 * conversation stores all three, while Afterglow continues to own the
 * transcript and continuity state. Adding another provider therefore means
 * registering an adapter and model definitions, not rewriting the chat route.
 */
const providers: ProviderDefinition[] = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "openrouter", label: "OpenRouter" },
];

const knownModels: InternalModelDefinition[] = [
  {
    id: "deepseek-v4-flash",
    providerId: "deepseek",
    providerModelId: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "Fast, economical roleplay for everyday conversations.",
    supportsThinking: true,
    category: "economy",
    free: false,
    // DeepSeek's own endpoint, whose published limits are not part of the
    // OpenRouter catalogue this file was checked against. Left unverified
    // rather than guessed; budgeting simply does not constrain it.
    capabilities: { thinking: true, jsonMode: true, promptCaching: true },
  },
  {
    id: "deepseek-v4-pro",
    providerId: "deepseek",
    providerModelId: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "Higher-detail writing and stronger handling of complex scenes.",
    supportsThinking: true,
    category: "recommended",
    free: false,
    capabilities: { thinking: true, jsonMode: true, promptCaching: true },
  },
  {
    id: "minimax-m2-her",
    providerId: "openrouter",
    providerModelId: "minimax/minimax-m2-her",
    label: "MiniMax M2-her",
    description: "Dialogue-first roleplay model for expressive, character-driven conversations.",
    supportsThinking: false,
    /*
     * Promoted to Recommended on community evidence rather than on a benchmark
     * this deployment ran. See docs/model-lineup-2026-08.md: the one repeated,
     * independent signal in the whole research pass is that the M2 "Her"
     * configuration holds a persona across very long conversations where
     * general-purpose models start bleeding character. That is the single axis
     * Afterglow cares most about, and it is already in the catalogue.
     */
    category: "recommended",
    free: false,
    capabilities: { thinking: false, jsonMode: true, promptCaching: true, dataPolicy: { dataCollection: "deny" } },
  },
  /*
   * Moonshot's long-context writers.
   *
   * K2.5 is kept exactly as it is. Conversations persist the model they were
   * started with, so quietly repointing this slug at a successor would change
   * the writer inside somebody's ongoing story without anybody saying so —
   * which is precisely the thing this catalogue exists to prevent. If Moonshot
   * retires it upstream, the chat route answers with a sentence that says so
   * and offers the picker; see the retirement handling in the chat route.
   *
   * K2.6 is offered ALONGSIDE it as its own selectable model, so a creator can
   * move deliberately. NOTE FOR OPERATORS: the K2.6 slug below was taken from
   * secondary sources and could not be checked against the live OpenRouter
   * catalogue from the build environment, which has no egress to
   * openrouter.ai. Confirm it before relying on it; an incorrect slug now
   * surfaces as a friendly "model is not available" rather than as raw
   * provider JSON, and `ALLOWED_MODELS` can exclude it in the meantime.
   */
  {
    id: "kimi-k2.5",
    providerId: "openrouter",
    providerModelId: "moonshotai/kimi-k2.5",
    label: "MoonshotAI Kimi K2.5",
    description: "Long-context comparison writer with strong scene comprehension and planning.",
    supportsThinking: true,
    category: "experimental",
    free: false,
    capabilities: { thinking: true, jsonMode: true, promptCaching: true, dataPolicy: { dataCollection: "deny" } },
  },
  {
    id: "kimi-k2.6",
    providerId: "openrouter",
    providerModelId: "moonshotai/kimi-k2.6",
    label: "MoonshotAI Kimi K2.6",
    description: "Moonshot's newer long-context writer. Same strengths as K2.5 with a larger context window.",
    supportsThinking: true,
    category: "experimental",
    free: false,
    capabilities: { thinking: true, jsonMode: true, promptCaching: true, dataPolicy: { dataCollection: "deny" } },
  },
  /*
   * GLM 4.7 — the premium writer, and the model whose routing this deployment
   * has spent two sprints getting honest.
   *
   * WHY IT NEEDS A POOL AND NOT ONLY A CEILING. Several upstream hosts serve
   * this slug at prices that differ by a factor of several, and a month of
   * production traffic landed on four of them. `max_price` bounds what an
   * endpoint may LIST; it says nothing about whether that endpoint discounts a
   * prompt-cache read. A roleplay turn resends the character, world, persona
   * and rules unchanged, so cached reads are most of the bill — an endpoint
   * that is under the ceiling and charges fresh prices for every repeated byte
   * defeats the entire objective while passing the guard.
   *
   * So the approved production pool is the set that is BOTH affordable AND
   * cache-capable, and in `cost_guarded` mode it is sent as `provider.only`.
   * The ceiling stays on underneath it: a pool member that re-prices upward
   * still falls out without anybody editing this file.
   *
   * THE POOL, and how far it is verified. `deepinfra`, `novita` and `z-ai` are
   * the three endpoints this deployment has priced, and OpenRouter's own model
   * page for `z-ai/glm-4.7` lists DeepInfra, NovitaAI and Z.ai among the hosts
   * serving it (alongside AtlasCloud, Venice, Google Vertex and Mancer, which
   * this pool deliberately excludes). That check was made through a web search
   * index on 2026-08-31, NOT against the live API: this environment's egress
   * policy denies openrouter.ai outright, so no request to the catalogue or to
   * `/api/v1/models` was possible. Per-endpoint cache-read pricing therefore
   * remains OPERATOR-REPORTED rather than machine-verified — see
   * docs/glm-cost-routing.md, which records exactly what was and was not
   * checked, and scripts/provider-pool-audit.mjs, which verifies the whole pool
   * from a deployment that does have a key.
   *
   * Per million tokens, fresh / cached / output, as reported by the operator:
   *
   *   DeepInfra   0.40 / 0.08  / 1.75
   *   Novita      0.54 / 0.099 / 1.98
   *   Z.AI        0.60 / 0.11  / 2.20
   *
   * NO `preferredProviders`. The pool is deliberately unordered so that
   * whichever member a conversation is already warm on stays warm: OpenRouter
   * documents that `provider.order` turns its own sticky routing off, and
   * cached input is roughly a fifth of fresh input, so ordering the pool would
   * buy a cheaper list price by discarding the cache that makes the real price
   * cheap.
   */
  {
    id: "glm-4.7",
    providerId: "openrouter",
    providerModelId: "z-ai/glm-4.7",
    label: "GLM 4.7 Premium",
    description: "Afterglow's flagship writer: stable multi-step reasoning, long context, and the strongest continuity in the lineup.",
    supportsThinking: true,
    category: "recommended",
    free: false,
    capabilities: {
      contextTokens: 204_800,
      maxOutputTokens: 131_072,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      costCeiling: { promptUsdPerMillion: 0.65, completionUsdPerMillion: 2.25 },
      cacheCapableProviders: ["deepinfra", "novita", "z-ai"],
      dataPolicy: { dataCollection: "deny" },
    },
  },
  /*
   * GLM 5.3 FLASH — ONE MODEL, ONE HOST, AND THAT IS THE WHOLE ENTRY.
   *
   * It used to be two catalogue entries, "Fast" and "Economy", which were the
   * same weights and the same slug served by different endpoints. The premise
   * underneath them — that one class of host is cheap-and-slow and another
   * dear-and-fast — was never verified from this environment, so the product
   * was asking readers to choose between two profiles nobody had measured, and
   * both of them routed across a pool of up to five hosts whose quantisation,
   * sampler and truncation behaviour differ. "Which writer wrote this" had no
   * stable answer, and neither did "why did this reply come out differently
   * from the last one".
   *
   * So there is one GLM 5.3 Flash now, and it is served by Z.AI: the model's
   * own vendor, and the one endpoint whose behaviour is the model's rather
   * than a re-host's. `dedicatedProvider` is what carries that into the request
   * — `provider.only: ["z-ai"]` with fallbacks OFF, and no `order` or `sort` on
   * any attempt, because there is nothing to order and OpenRouter's own sticky
   * routing is what keeps the prompt cache warm.
   *
   * WHEN Z.AI IS DOWN, THE MODEL IS DOWN. That is deliberate and it is the
   * point: OpenRouter answers 404 "no allowed providers are available", which
   * classifies as `upstream_unavailable`, and the reader is told the model is
   * temporarily unavailable. Quietly answering as a different serving profile
   * would be cheaper for us and a change of writer nobody consented to.
   *
   * WHAT SURVIVES FROM THE PREVIOUS ENTRY. The price ceiling stays as defence
   * in depth — set from the LIST price, not from the launch discount that
   * expires, so no route silently falls out of its own guard — and so does the
   * privacy floor, which is never traded against availability. Prompt caching
   * and the conversation-scoped `session_id` are unchanged, and are worth more
   * now than they were: a single host is a single cache.
   *
   * REASONING IS NOT OPTIONAL HERE, AND ASKING FOR NONE WAS MAKING IT WORSE.
   *
   * The entry used to say `reasoningDefault: "off"`, on evidence that stands:
   * independent measurement of GLM 5.3 Flash on a reasoning-heavy suite
   * reported a median time-to-first-token in the tens of seconds, because the
   * model reasons before it speaks. What did not stand was the assumption that
   * the endpoint would accept the refusal. Production logs settled it:
   *
   *   1. Afterglow sent `reasoning: { enabled: false }`.
   *   2. Z.AI answered 400 — "Reasoning is mandatory for this endpoint and
   *      cannot be disabled."
   *   3. The adapter dropped the parameter and asked again, which takes the
   *      ENDPOINT'S default: the most reasoning, not the least.
   *   4. The generation ended `finish_reason=length`, `native_finish_reason=
   *      length`, reasoning tokens only, `replyCharacters=0`.
   *
   * Every reader turn therefore cost two requests to arrive at the opposite of
   * the catalogue's intention, and then spent the whole 1,800-token envelope
   * thinking. So the entry now says what is actually true of this endpoint and
   * asks for the least reasoning it will agree to:
   *
   *   `reasoningMandatory`  the refusal is a known contract, not a discovery to
   *                         be made again on somebody's turn.
   *   `reasoningDefault`    the lowest effort on OpenRouter's scale that is not
   *                         a refusal. `"minimal"` exists and is not chosen: a
   *                         model that must reason and is given almost no room
   *                         to do it is the same failure with a smaller bill.
   *   `reasoningBudget`     hidden tokens ON TOP of the visible reply target,
   *                         because they are spent from the same envelope. See
   *                         src/lib/reasoning.ts.
   *
   * `thinking: true` still says only that the endpoint ACCEPTS the parameter.
   * An engine that explicitly wants thinking continues to win over all of this.
   */
  {
    id: "glm-5.3-flash",
    providerId: "openrouter",
    providerModelId: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    description: "The newer, much cheaper GLM. Long context and quick replies for everyday stories.",
    supportsThinking: true,
    category: "recommended",
    free: false,
    capabilities: {
      contextTokens: 1_310_720,
      maxOutputTokens: 131_072,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      costCeiling: { promptUsdPerMillion: 0.20, completionUsdPerMillion: 0.60 },
      dedicatedProvider: "z-ai",
      dataPolicy: { dataCollection: "deny" },
      reasoningDefault: "low",
      reasoningMandatory: true,
      /*
       * 2,000 hidden tokens above whatever Response Length asked to show, and
       * 8,000 as the hard stop including the one escalation a retry may take.
       *
       * Read off the failure rather than guessed: a full 1,800-token envelope
       * was consumed by an UNBOUNDED reasoning pass, so the headroom has to be
       * of that order for a bounded one to finish inside it and still leave the
       * visible reply whole. Natural therefore asks for 3,800 and Concise for
       * 2,594 — the modes keep their relative sizes, and none of them competes
       * with thinking for its own words any more.
       *
       * Deliberately conservative in both directions. It is a CEILING, not a
       * spend: only tokens actually produced are billed, so the cost of being
       * generous here is nothing when the model behaves and one bounded
       * over-run when it does not.
       */
      reasoningBudget: { headroomTokens: 2_000, ceilingTokens: 8_000 },
    },
  },
  /*
   * LING 3.0 FLASH — the ultra-cheap writer, and the funded free-tier fallback
   * candidate.
   *
   * A 124B mixture-of-experts model with roughly 5B parameters active per
   * token, listed near $0.021/M in and $0.063/M out with a 262,144-token
   * context and a 32,768-token output ceiling. That is around a twentieth of
   * GLM 4.7's fresh input rate, which is what makes it interesting as the
   * thing Afterglow funds when free capacity runs out.
   *
   * IT IS NOT A FLAGSHIP AND MUST NOT BE PROMOTED LIKE ONE. The community
   * research pass found no RP signal for it whatsoever — not bad reports, no
   * reports — so its category is Economy on price alone and its RP quality is
   * an open question that tests/eval/writer-models.test.ts is set up to answer.
   *
   * The `:free` endpoint is a SEPARATE route with separate latency, throughput
   * and privacy properties, and lives in the curated free catalogue rather than
   * here; see src/lib/free-models.ts.
   */
  {
    id: "ling-3.0-flash",
    providerId: "openrouter",
    providerModelId: "inclusionai/ling-3.0-flash",
    label: "Ling 3.0 Flash",
    description: "Very inexpensive writer with a large context window. Good for long, everyday stories.",
    supportsThinking: true,
    category: "economy",
    free: false,
    capabilities: {
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      /*
       * A HYBRID REASONING MODEL, AND THINKING IS ON BY DEFAULT.
       *
       * This said `false`, which was read by everything as "the endpoint does
       * not take a `reasoning` parameter" — so Afterglow never sent one, and
       * never sending one is not declining: it takes the endpoint's own
       * default, which for Ling is to think.
       *
       * Production settled it. Every Scene Ledger extraction on this route came
       * back:
       *
       *   upstream Novita · max_tokens 400 · finish_reason "length"
       *   content null · completion_tokens ~400 · reasoning_tokens ~400+
       *   hasReasoning true · requestedReasoningOff FALSE
       *
       * The model was spending the entire 400-token ledger envelope on hidden
       * thinking and never reaching the JSON. InclusionAI documents Ling 3.0
       * Flash as hybrid, thinking enabled by default, disableable per request.
       *
       * Declaring it true is what lets `backgroundReasoningFor` answer `"off"`
       * and the adapter emit `reasoning: { enabled: false }`. It also lets the
       * chat route's empty-reply retry ask for no reasoning rather than only
       * raising the envelope — see `canDeclineReasoning`.
       *
       * THE ENVELOPE IS DELIBERATELY NOT RAISED. A ledger update is a handful
       * of JSON fields; paying hundreds of reasoning tokens to produce them is
       * the cost this whole layer exists to avoid, and a bigger budget would
       * hide the failure by buying it.
       */
      thinking: true,
      /*
       * NO STRUCTURED OUTPUT. OpenRouter documents this model as not supporting
       * `response_format`, and this entry claimed otherwise.
       *
       * The consequence was not a 400 anybody could read. `jsonMode: true` made
       * every Scene Ledger extraction send `response_format: {type:"json_object"}`
       * to an endpoint that does not implement it, and the observed result in
       * production was a run of `empty_response` failures — a background job
       * that never reaches a reader, so nobody saw it until a conversation
       * turned out to have no memories.
       *
       * `jsonMode` is now load-bearing rather than decorative: the adapter reads
       * it before emitting the parameter. Declaring it wrongly in either
       * direction has a cost, so it belongs to whatever the provider documents
       * and not to an assumption that a modern model must support it.
       */
      jsonMode: false,
      promptCaching: true,
      costCeiling: { promptUsdPerMillion: 0.10, completionUsdPerMillion: 0.30 },
      dataPolicy: { dataCollection: "deny" },
    },
  },
  /*
   * QWEN3.8 FLASH — an experimental comparison writer, and nothing more yet.
   *
   * Listed near $0.15/M in and $0.47/M out with a cache-read rate around
   * $0.016/M and a one-million-token context. Alibaba positions it for coding,
   * agentic workflows and document analysis; strong benchmarks in those
   * categories say nothing about whether it can hold a character for ninety
   * turns, and this catalogue does not promote a model on results from a
   * different job. Experimental until the RP evaluation has run.
   */
  {
    id: "qwen3.8-flash",
    providerId: "openrouter",
    providerModelId: "qwen/qwen3.8-flash",
    label: "Qwen3.8 Flash",
    description: "Experimental comparison writer with a very large context window.",
    supportsThinking: true,
    category: "experimental",
    free: false,
    capabilities: {
      contextTokens: 1_000_000,
      maxOutputTokens: 131_072,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      costCeiling: { promptUsdPerMillion: 0.20, completionUsdPerMillion: 0.60 },
      dataPolicy: { dataCollection: "deny" },
      reasoningDefault: "off",
    },
  },
  /*
   * Xiaomi's MiMo V2.5 family.
   *
   * Slugs, limits and pricing confirmed against OpenRouter's live catalogue on
   * 2026-08-25: `xiaomi/mimo-v2.5` and `xiaomi/mimo-v2.5-pro`, both with a
   * roughly one-million-token context, both supporting reasoning and prompt
   * caching, and both served by several upstream endpoints including Xiaomi's
   * own. A dated variant (`xiaomi/mimo-v2.5-20260422`) also exists; the
   * undated slug is used deliberately, so a conversation follows the model
   * rather than one snapshot of it.
   *
   * The two are separate selectable models and neither substitutes for the
   * other. Pro is roughly 2.5x the price of the standard model and is a
   * different writer, not a better setting of the same one.
   *
   * `preferredProviders` names Xiaomi's own endpoint FIRST but not ONLY: see
   * `providerPolicyFor`. Preferring it is worth doing — it is the model's home
   * and the natural place for its cache to live — and pinning it would mean one
   * provider's outage took MiMo down for everybody.
   */
  {
    id: "mimo-v2.5",
    providerId: "openrouter",
    providerModelId: "xiaomi/mimo-v2.5",
    label: "MiMo V2.5 — Long Memory",
    description: "Xiaomi's omnimodal writer. Very large context and strong cache economics for long, continuous stories.",
    supportsThinking: true,
    category: "economy",
    free: false,
    capabilities: {
      contextTokens: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      preferredProviders: ["xiaomi"],
      dataPolicy: { dataCollection: "deny" },
      // Measured against the response-length modes: MiMo answers Concise with
      // a full scene unless the ceiling is stated as a limit. See
      // scripts/response-length-benchmark.mjs.
      verbosity: "expansive",
    },
  },
  {
    id: "mimo-v2.5-pro",
    providerId: "openrouter",
    providerModelId: "xiaomi/mimo-v2.5-pro",
    label: "MiMo V2.5 Pro — Long Memory",
    description: "Xiaomi's flagship writer. The same very large context with stronger reasoning for complex, long-running plots.",
    supportsThinking: true,
    category: "recommended",
    free: false,
    capabilities: {
      contextTokens: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      preferredProviders: ["xiaomi"],
      dataPolicy: { dataCollection: "deny" },
      verbosity: "expansive",
    },
  },
  {
    id: "midnight-cherry",
    providerId: "openrouter",
    providerModelId: "thedrummer/skyfall-36b-v2",
    label: "Midnight Cherry — Cinematic RP",
    description: "Creative, nuanced prose with coherent scene flow and storytelling emphasis.",
    supportsThinking: false,
    category: "experimental",
    free: false,
    /*
     * The small one, and the reason this whole block exists.
     *
     * 32,768 tokens against 131,072 for Passion Fruit and 65,536 for Wild
     * Peach. Verified against OpenRouter's catalogue on 2026-08-25. A long
     * story with a World attached does not fit, and before budgeting knew that,
     * the request was sent anyway and came back 400.
     */
    capabilities: { contextTokens: 32_768, maxOutputTokens: 32_768, thinking: false, jsonMode: false, promptCaching: false },
  },
  {
    id: "passion-fruit",
    providerId: "openrouter",
    providerModelId: "thedrummer/cydonia-24b-v4.1",
    label: "Passion Fruit — Unbound NSFW",
    description: "Uncensored creative roleplay with strong recall and prompt adherence.",
    supportsThinking: false,
    category: "experimental",
    free: false,
    capabilities: { contextTokens: 131_072, maxOutputTokens: 131_072, thinking: false, jsonMode: false, promptCaching: false },
  },
  {
    id: "wild-peach",
    providerId: "openrouter",
    providerModelId: "thedrummer/rocinante-12b",
    label: "Wild Peach — Expressive RP",
    description: "Lighter expressive writer tuned for vivid vocabulary and engaging prose.",
    supportsThinking: false,
    category: "experimental",
    free: false,
    capabilities: { contextTokens: 65_536, maxOutputTokens: 65_536, thinking: false, jsonMode: false, promptCaching: false },
  },
  /*
   * DEEPSEEK V4 FLASH 0731, VIA OPENROUTER — A MEMORY-MODEL CANDIDATE, AND A
   * TRAP IF ANYBODY ASSUMES THE NAME MEANS WHAT IT LOOKS LIKE.
   *
   * Afterglow's memory consolidation runs on `deepseek/deepseek-v4-flash`
   * through DEEPSEEK'S OWN API, and its extracted memories are the quality bar
   * everything else is measured against. This entry is a DIFFERENT ROUTE to a
   * DIFFERENT CHECKPOINT and is here only so a head-to-head can be run.
   *
   * THREE FACTS THAT MAKE THEM NOT INTERCHANGEABLE:
   *
   *   The undated OpenRouter slug `deepseek/deepseek-v4-flash` resolves to the
   *   0423 revision, not to whatever DeepSeek's own endpoint currently serves.
   *   `-0731` is a separately listed, re-post-trained GA revision.
   *
   *   A re-post-trained revision is a different model's behaviour under the
   *   same family name. For a WRITER that shows up as taste; for the
   *   CONSOLIDATOR it shows up as which facts get extracted and which open
   *   commitments get marked resolved, and a wrongly resolved promise deletes a
   *   thread the reader was waiting on, silently and permanently.
   *
   *   The route is served by around thirty upstream endpoints at prices that
   *   differ by a lot. "Dramatically cheaper" is a statement about the cheapest
   *   endpoint, not about the model.
   *
   * So it is NOT wired to any background task. `MEMORY_CONSOLIDATION_MODEL_ROUTE`
   * still names DeepSeek's own endpoint, and moving it is a decision that
   * requires the head-to-head in tests/eval/memory-models.test.ts to have been
   * run and to have shown equivalence on promise resolution and hallucinated
   * memories specifically — not on an average.
   */
  {
    id: "deepseek-v4-flash-0731",
    providerId: "openrouter",
    providerModelId: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731 (background candidate)",
    description: "A cheaper route to a DeepSeek V4 Flash revision. Under evaluation for background memory work; not a chat writer.",
    supportsThinking: true,
    category: "experimental",
    free: false,
    capabilities: {
      contextTokens: 1_310_720,
      maxOutputTokens: 393_216,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      costCeiling: { promptUsdPerMillion: 0.10, completionUsdPerMillion: 0.40 },
      dataPolicy: { dataCollection: "deny" },
    },
  },
  /*
   * THE SAME 0731 REVISION, PINNED TO ONE UPSTREAM HOST EACH.
   *
   * `deepseek-v4-flash-0731` above names a slug and lets OpenRouter choose
   * among the ~thirty hosts serving it. That is the right shape for a route
   * nobody is comparing, and the wrong shape for an A/B: two consolidation
   * runs on "the same model" that landed on different hosts differ in
   * quantisation, sampler, truncation behaviour and cache economics, and the
   * report cannot tell you which of those produced the difference it measured.
   *
   * So a host under evaluation gets its own catalogue id. `dedicatedProvider`
   * carries it — `provider.only` with fallbacks off, exactly as GLM 5.3 Flash
   * is served — and because the id is distinct, every usage row, every cost
   * figure and every quality note separates by host without anybody having to
   * join on `upstream_provider` afterwards.
   *
   * THE SLUGS ARE NOW VERIFIED, AND THEY WERE NOT WHAT ANYBODY WOULD HAVE
   * GUESSED.
   *
   * The first version of these entries carried "openinference" and "relace",
   * the obvious lowercase forms of the two host names in the brief. Checked
   * against OpenRouter's endpoint list for `deepseek/deepseek-v4-flash-0731`,
   * the real routing tags are `open-inference/fp8` and `relace/fp4` — a
   * hyphen nobody would have added, and a serving-profile suffix nobody would
   * have known to look for. That is the whole argument for having refused to
   * enable them on a plausible-looking guess: `provider.only` with a wrong tag
   * is not a degraded route, it is a background task that fails on every run,
   * silently, because background jobs never reach a reader to complain.
   *
   * THE SUFFIX IS PART OF THE ROUTE, NOT DECORATION. `fp8` and `fp4` name the
   * quantisation the host serves this model at, which is precisely the
   * difference the per-host A/B exists to measure: two runs of "the same model"
   * at different numeric precision are two different models for the purpose of
   * deciding which of a reader's promises get marked kept.
   *
   * Both remain gated behind `BACKGROUND_ROUTE_VERIFIED_UPSTREAMS` even now
   * they are correct, because the gate is an operator saying "I am willing to
   * send readers' transcripts to this host", which is a different sentence from
   * "this host exists". `scripts/background-route-verify.mjs` re-prints the live
   * list, so a tag that is renamed upstream is caught by running it again rather
   * than by a fortnight of failed consolidations.
   *
   * Verified prices, per million tokens, at the time of checking — both inside
   * the ceiling below, which is left exactly where it was:
   *
   *   open-inference/fp8   $0.05 fresh   $0.013 cached   $0.16 output
   *   relace/fp4           $0.065 fresh  $0.016 cached   $0.18 output
   *
   * `backgroundOnly` keeps them out of the writer picker. They are one model
   * appearing three times, which is a meaningful distinction for a memory A/B
   * and pure noise for somebody choosing who writes their story.
   */
  {
    id: "deepseek-v4-flash-0731-openinference",
    providerId: "openrouter",
    providerModelId: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731 — OpenInference",
    description: "The 0731 revision served only by OpenInference, at fp8. Background memory evaluation route.",
    supportsThinking: true,
    category: "experimental",
    free: false,
    backgroundOnly: true,
    capabilities: {
      contextTokens: 1_310_720,
      maxOutputTokens: 393_216,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      dedicatedProvider: "open-inference/fp8",
      costCeiling: { promptUsdPerMillion: 0.10, completionUsdPerMillion: 0.40 },
      dataPolicy: { dataCollection: "deny" },
    },
  },
  {
    id: "deepseek-v4-flash-0731-relace",
    providerId: "openrouter",
    providerModelId: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731 — Relace",
    description: "The 0731 revision served only by Relace, at fp4. Background memory evaluation route.",
    supportsThinking: true,
    category: "experimental",
    free: false,
    backgroundOnly: true,
    capabilities: {
      contextTokens: 1_310_720,
      maxOutputTokens: 393_216,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      dedicatedProvider: "relace/fp4",
      costCeiling: { promptUsdPerMillion: 0.10, completionUsdPerMillion: 0.40 },
      dataPolicy: { dataCollection: "deny" },
    },
  },
  /*
   * THE CURATED FREE ROUTES.
   *
   * They are ordinary catalogue entries because everything else about them —
   * budgeting, context fitting, retirement handling, the picker — has to work
   * exactly as it does for a paid model. What is different about them is
   * declared, not implied: `free: true` routes the request through the shared
   * free-tier ledger in src/lib/free-tier.ts, and their availability is owned
   * by src/lib/free-models.ts rather than by this file, because free endpoints
   * come and go weekly and removing a dead one must never require a deploy.
   *
   * THE PRIVACY FLOOR IS NOT NEGOTIABLE HERE. OpenRouter's account settings
   * distinguish free endpoints that may train on inputs from free endpoints
   * that may PUBLISH prompts, which means "it costs nothing" and "it is safe to
   * put a private roleplay through it" are entirely separate questions. Every
   * route below therefore carries `dataCollection: "deny"`, so a free endpoint
   * that trains on prompts is excluded by OpenRouter's own filter rather than
   * by a table here that would go stale. A route with no compliant endpoint
   * fails honestly instead of quietly training on somebody's story.
   *
   * SLUGS ARE INDICATIVE. `inclusionai/ling-3.0-flash:free` was confirmed
   * through a search index on 2026-08-31; `minimax/minimax-m2.5:free` likewise.
   * The MiniMax M2.7/M3 and Nemotron 3 Ultra free endpoints named in the brief
   * could NOT be confirmed to exist as `:free` routes and are therefore absent
   * rather than guessed at — a wrong slug here is a route that 404s for every
   * reader on the free tier. `scripts/free-route-screen.mjs` discovers and
   * screens the live list from a deployment that has a key; the server-owned
   * config layer then enables what passes, with no deploy.
   */
  {
    id: "ling-3.0-flash-free",
    providerId: "openrouter",
    providerModelId: "inclusionai/ling-3.0-flash:free",
    label: "Ling 3.0 Flash (Free)",
    description: "A free writer with a large context window. Shared capacity, so it is not always available.",
    supportsThinking: true,
    category: "free",
    free: true,
    notice: "Free shared capacity. Availability depends on the provider.",
    capabilities: {
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      // The same underlying model as the paid route above, so the same answers:
      // hybrid reasoning that has to be declined explicitly, and no
      // `response_format`. A capability is a property of the model, and
      // splitting the two entries' answers would be a bug waiting for whichever
      // one got used for structured work first.
      thinking: true,
      jsonMode: false,
      promptCaching: false,
      dataPolicy: { dataCollection: "deny" },
    },
  },
  {
    id: "minimax-m2.5-free",
    providerId: "openrouter",
    providerModelId: "minimax/minimax-m2.5:free",
    label: "MiniMax M2.5 (Free)",
    description: "A free general writer from the MiniMax family. Shared capacity, so it is not always available.",
    supportsThinking: false,
    category: "free",
    free: true,
    notice: "Free shared capacity. Availability depends on the provider.",
    capabilities: {
      contextTokens: 196_608,
      maxOutputTokens: 32_768,
      thinking: false,
      jsonMode: true,
      promptCaching: false,
      dataPolicy: { dataCollection: "deny" },
    },
  },
];

/*
 * The engines themselves live in src/lib/engines.ts.
 *
 * They stopped being one descriptive sentence each and became behaviour
 * contracts — named dials, requirements and restraints — which is a lot of text
 * with its own reasons, and it does not belong in the middle of the model
 * catalogue. This file still owns which engines a deployment offers; that file
 * owns what each one asks a writer to do.
 */
const engines: RoleplayEngineDefinition[] = engineDefinitions();

function safeId(value: string) {
  return /^[a-zA-Z0-9._-]{1,100}$/.test(value);
}

/**
 * AN UPSTREAM PROVIDER ENDPOINT TAG, WHICH IS NOT AN IDENTIFIER.
 *
 * `safeId` guards catalogue model ids, environment keys and anything that has
 * to survive being pasted into a variable or a query string, and it rejects
 * `/` for good reasons that all still hold. But OpenRouter's routing tags are
 * not identifiers of ours — they are values that arrive from a third party's
 * catalogue, and several of them carry a serving-profile suffix after a slash:
 *
 *   open-inference/fp8
 *   relace/fp4
 *
 * Verified against OpenRouter's endpoint list for
 * `deepseek/deepseek-v4-flash-0731`. Running those through `safeId` returned
 * false, which meant `dedicatedProviderFor` answered null and
 * `approvedProviderPool` answered an empty list — so a model that had
 * DELIBERATELY been pinned to one host would silently have been routed by
 * OpenRouter's own default policy instead. A guard that rejects a valid value
 * by turning a hard pin into no pin at all is worse than no guard: it fails
 * open, quietly, in exactly the direction the pin exists to prevent.
 *
 * So this is a SEPARATE, NARROWER predicate, used only where an upstream
 * routing tag is validated, and never for a model id or an environment key.
 * Widening `safeId` itself would have let a slash into places where it means
 * something — a path segment, a cache key, a catalogue id — to fix a problem in
 * one of them.
 *
 * WHAT IT STILL REFUSES, and why the shape is this tight. These values are
 * placed verbatim into `provider.only`, `provider.order` and `provider.ignore`
 * in a JSON request body, so the exposure is malformed routing rather than
 * injection — but a tag that cannot be typed by mistake is a tag that cannot be
 * wrong by mistake. Empty segments, a leading or trailing slash, `.` or `..` as
 * a segment, whitespace, quotes and every other punctuation mark are rejected,
 * and the depth is bounded at three segments because no published tag has more
 * than two and an unbounded one is a wildcard wearing a regex.
 */
const providerTagSegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,58}[a-zA-Z0-9])?$/;

export function safeProviderTag(value: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 120) return false;
  const segments = value.split("/");
  if (segments.length > 3) return false;
  return segments.every((segment) => providerTagSegment.test(segment));
}

export function openRouterEnabled() {
  // BYOK may expose curated OpenRouter writers even when a deployment does not
  // fund OpenRouter itself. Background routes still receive no user credential
  // and therefore continue to require the platform key at call time.
  const platform = process.env.ENABLE_OPENROUTER === "true" && Boolean(process.env.OPENROUTER_API_KEY?.trim());
  return platform || process.env.ENABLE_BYOK === "true";
}

function modelProviderEnabled(model: InternalModelDefinition) {
  return model.providerId !== "openrouter" || openRouterEnabled();
}

function publicModel(model: InternalModelDefinition): ModelDefinition {
  return {
    id:model.id,
    providerId:model.providerId,
    label:model.label,
    description:model.description,
    supportsThinking:model.supportsThinking,
    category:model.category,
    free:model.free,
    ...(model.notice ? { notice: model.notice } : {}),
    ...(model.backgroundOnly ? { backgroundOnly: true } : {}),
  };
}

/**
 * The catalogue a reader is offered, which is not the catalogue that resolves.
 *
 * A background-only route stays fully resolvable — `resolveModel`,
 * `providerModelId`, `modelCapabilities` and the routing policy all have to work
 * for it or the memory job it serves cannot run — and is simply not shown to
 * somebody choosing a writer.
 */
export function pickerModels(): ModelDefinition[] {
  return availableModels().filter((model) => !model.backgroundOnly);
}

/** Every catalogue entry, including ones this deployment has not enabled. */
export function catalogModelIds() {
  return knownModels.map((model) => model.id);
}

/** Whether this catalogue id is a curated free route. */
export function isFreeModel(modelId: string) {
  return knownModels.find((model) => model.id === modelId)?.free ?? false;
}

/** The product shelf this model sits on. Unknown models are experimental. */
export function modelCategory(modelId: string): ModelCategory {
  return knownModels.find((model) => model.id === modelId)?.category ?? "experimental";
}

export function allowedModels() {
  const configured = (process.env.ALLOWED_MODELS || "").split(",").map((item) => item.trim()).filter(safeId);
  const deploymentModels = knownModels.filter(modelProviderEnabled).map((item) => item.id);
  return configured.length ? configured.filter((id) => {
    const known = knownModels.find((item) => item.id === id);
    return !known || modelProviderEnabled(known);
  }) : deploymentModels;
}

export function availableModels(): ModelDefinition[] {
  return allowedModels().map((id) => {
    const known = knownModels.find((item) => item.id === id);
    return known ? publicModel(known) : {
    id,
    providerId: "deepseek",
    label: id,
    description: "Deployment-configured DeepSeek-compatible model.",
    supportsThinking: true,
    // A model nobody in this file has ever seen is not "recommended", and it
    // is certainly not free. Experimental is the honest shelf for it.
    category: "experimental" as const,
    free: false,
    };
  });
}

export function availableCatalog(): ModelCatalog {
  const models = pickerModels();
  return {
    providers: providers.filter((provider) => models.some((model) => model.providerId === provider.id)),
    models,
    engines,
  };
}

export function defaultProvider() {
  const configured = process.env.DEFAULT_LLM_PROVIDER?.trim();
  if (configured && availableModels().some((model) => model.providerId === configured)) return configured;
  return availableModels()[0]?.providerId ?? "deepseek";
}

export function defaultModel() {
  const providerId = defaultProvider();
  const configured = process.env.DEFAULT_LLM_MODEL?.trim() || (providerId === "deepseek" ? process.env.DEEPSEEK_MODEL?.trim() : "");
  if (configured && resolveModel(providerId, configured)) return configured;
  return availableModels().find((model) => model.providerId === providerId)?.id ?? allowedModels()[0];
}

export function defaultEngine(): RoleplayEngineId {
  const configured = process.env.DEFAULT_RP_ENGINE?.trim();
  return engines.some((engine) => engine.id === configured) ? configured as RoleplayEngineId : "immersive";
}

export function resolveModel(providerId: string, modelId: string) {
  return availableModels().find((model) => model.id === modelId && model.providerId === providerId) ?? null;
}

/** Resolve the private upstream slug without exposing it in the browser catalog. */
export function providerModelId(providerId: string, modelId: string) {
  const available = resolveModel(providerId, modelId);
  if (!available) return null;
  return knownModels.find((model) => model.providerId === providerId && model.id === modelId)?.providerModelId ?? modelId;
}

/** Everything sensible to assume about a model that is not in the catalogue. */
const unknownCapabilities: ModelCapabilities = { thinking: false, jsonMode: true, promptCaching: false };

/**
 * What this model can be asked for.
 *
 * A deployment-configured model that is not in `knownModels` gets the cautious
 * answer: no declared context limit (so budgeting does not constrain it, which
 * is today's behaviour), and no reasoning (so an unknown endpoint is never sent
 * a parameter it may reject).
 */
export function modelCapabilities(providerId: string, modelId: string): ModelCapabilities {
  return knownModels.find((model) => model.providerId === providerId && model.id === modelId)?.capabilities ?? unknownCapabilities;
}

/** How much this model writes when nothing stops it. Defaults to "normal". */
export function modelVerbosity(providerId: string, modelId: string): ModelVerbosity {
  return modelCapabilities(providerId, modelId).verbosity ?? "normal";
}

/**
 * A provider pinned for measurement, never for production.
 *
 * Comparing Xiaomi's own endpoint against the alternatives means sending
 * requests only to it, which is precisely what production must not do. So the
 * pin lives behind an environment variable an operator sets deliberately for a
 * benchmark run and unsets afterwards, and it is scoped to one catalogue model
 * so pinning MiMo cannot accidentally pin everything else too.
 *
 * Format: `PIN_UPSTREAM_PROVIDER=mimo-v2.5:xiaomi` (or several, comma
 * separated).
 */
export function pinnedProviderFor(modelId: string) {
  /*
   * A PIN REQUIRES BENCHMARK MODE, not just a pin variable.
   *
   * The variable is set for a measurement run and unset afterwards, and
   * "afterwards" is where this goes wrong: a pin left behind in a deployment
   * sends every conversation to one host with fallbacks OFF, which is both an
   * availability risk and precisely the kind of unexamined routing that made
   * this sprint necessary. Two deliberate variables rather than one means a
   * forgotten pin is inert.
   */
  if (routingMode() !== "benchmark") return null;
  const configured = process.env.PIN_UPSTREAM_PROVIDER?.trim();
  if (!configured) return null;
  for (const entry of configured.split(",")) {
    const [model, provider] = entry.split(":").map((value) => value.trim());
    if (model === modelId && provider && safeProviderTag(provider)) return provider;
  }
  return null;
}

export type ProviderRoutingPolicy = {
  /** Endpoints to try first, in order. Never the only ones allowed. */
  order?: string[];
  /** The benchmark pin, or the approved pool: these and nothing else. */
  only?: string[];
  /** Endpoints already known to have failed this request. */
  ignore?: string[];
  allowFallbacks: boolean;
  sort?: "throughput" | "price" | "latency";
  /** Per-million ceilings an endpoint must be under to be eligible. */
  maxPrice?: { prompt: number; completion: number };
  /** `deny` excludes endpoints that may train on the prompt. */
  dataCollection?: "allow" | "deny";
  /** True restricts routing to zero-data-retention endpoints. */
  zdr?: boolean;
};

/**
 * How much routing policy production is allowed to apply.
 *
 * This exists to be turned off. The ceiling below changes which upstream hosts
 * every GLM conversation may reach, and an operator who does not like what that
 * does to availability or to quality must be able to put it back to exactly
 * today's behaviour without waiting for a deploy.
 *
 *   auto            No cost policy at all. Byte-for-byte the behaviour before
 *                   this sprint: preferred endpoints where a model declares
 *                   them, OpenRouter's own routing everywhere else.
 *   cost_guarded    THE DEFAULT. A model's `costCeiling` is sent as
 *                   `provider.max_price`, so no endpoint above it is eligible —
 *                   on the first attempt and on recovery alike. Nothing else
 *                   changes: no `order`, no `sort`, so OpenRouter's sticky
 *                   session routing is left to do its job.
 *   cost_optimized  Adds `sort: "price"` to the first attempt, which asks for
 *                   the cheapest eligible endpoint deterministically instead of
 *                   the price-weighted draw. NOT the default, because `sort`
 *                   documentedly turns load balancing off and its interaction
 *                   with an already-warm sticky session is NOT documented —
 *                   a session that recovered onto a second-cheapest host might
 *                   be pulled back to the cheapest one, cold, every turn.
 *                   Verify against live traffic before preferring it.
 *   benchmark       Honours `PIN_UPSTREAM_PROVIDER`. Pins are measurement-only
 *                   and this is the mode that says so out loud.
 *
 * An unrecognised value falls back to the default rather than to no guard: a
 * typo in a deployment variable should not quietly restore the expensive
 * behaviour this was added to prevent.
 */
export type RoutingMode = "auto" | "cost_guarded" | "cost_optimized" | "benchmark";

export function routingMode(): RoutingMode {
  const configured = process.env.PROVIDER_ROUTING_MODE?.trim();
  return configured === "auto" || configured === "cost_optimized" || configured === "benchmark" ? configured : "cost_guarded";
}

/**
 * Whether a model's approved pool is a hard `provider.only` restriction.
 *
 * ON BY DEFAULT NOW, and that is the correction. The previous sprint made the
 * pool advisory and leaned on `max_price` as the production guard, which is not
 * sufficient by itself: an endpoint can satisfy a fresh-input and output
 * ceiling while discounting nothing on a prompt-cache read, and cached reads
 * are most of what a long roleplay actually pays for. The guard would pass and
 * the objective would be missed.
 *
 * The risk that argued for advisory has not gone away — a wrong or renamed slug
 * in `provider.only` is an outage rather than a degraded route — so it is
 * answered with escape hatches instead of with a weaker default:
 * `ENFORCE_PROVIDER_POOL=false` returns the pool to advisory with the ceiling
 * still in force, and `PROVIDER_POOL_OVERRIDE` replaces one model's pool
 * outright. Both take effect without a deploy.
 */
function poolEnforced() {
  return process.env.ENFORCE_PROVIDER_POOL !== "false";
}

/**
 * An operator's replacement pool for one model, from the environment.
 *
 * Format: `PROVIDER_POOL_OVERRIDE=glm-4.7:deepinfra|novita` (comma separated
 * for several models). This is the three-in-the-morning control: a provider is
 * renamed or starts failing, and the pool can be corrected from a dashboard
 * rather than from a release.
 */
function poolOverrideFor(modelId: string) {
  const configured = process.env.PROVIDER_POOL_OVERRIDE?.trim();
  if (!configured) return null;
  for (const entry of configured.split(",")) {
    const separator = entry.indexOf(":");
    if (separator < 1) continue;
    if (entry.slice(0, separator).trim() !== modelId) continue;
    const slugs = entry.slice(separator + 1).split("|").map((value) => value.trim()).filter((value) => safeProviderTag(value));
    return slugs.length ? slugs : null;
  }
  return null;
}

/**
 * The approved production pool for one model: affordable AND cache-capable.
 *
 * Exported because it is the thing an operator has to be able to read back —
 * the routing diagnostic and `scripts/provider-pool-audit.mjs` both report it,
 * and a pool nobody can inspect is a pool nobody can trust.
 */
export function approvedProviderPool(modelId: string) {
  const override = poolOverrideFor(modelId);
  if (override) return override;
  const capabilities = knownModels.find((model) => model.id === modelId)?.capabilities;
  /*
   * A DEDICATED MODEL'S POOL IS ITS ONE HOST.
   *
   * Answered here rather than by making the catalogue repeat the slug in two
   * fields, so everything that reads a pool — the routing diagnostic, the
   * request builder, `scripts/provider-pool-audit.mjs` — sees the same answer
   * and none of them can disagree with the other.
   */
  const dedicated = capabilities?.dedicatedProvider;
  if (dedicated && safeProviderTag(dedicated)) return [dedicated];
  return capabilities?.cacheCapableProviders?.filter((value) => safeProviderTag(value)) ?? [];
}

/**
 * Whether this model is served by exactly one upstream host, on purpose.
 *
 * Exported because it is the difference between "these hosts are all
 * acceptable" and "this host or nothing", and both the request builder and the
 * operator-facing diagnostics have to be able to tell them apart. See
 * `ModelCapabilities.dedicatedProvider` for why GLM 5.3 Flash is the second.
 */
export function dedicatedProviderFor(modelId: string) {
  const declared = knownModels.find((model) => model.id === modelId)?.capabilities.dedicatedProvider;
  return declared && safeProviderTag(declared) ? declared : null;
}

/**
 * Whether an expensive route may be reached when every approved one has failed.
 *
 * DEFAULT FALSE, and this is the second correction. The previous sprint let the
 * final attempt lift the price ceiling on the argument that one dear generation
 * beats a failed turn mid-scene. That argument is real but it is an OPERATOR'S
 * to make, not a default: silently converting a provider outage into
 * unexpectedly expensive spend is exactly the failure mode the cost work exists
 * to prevent, and it happens at the moment nobody is watching.
 *
 * So in `cost_guarded` every attempt stays the same model, inside the approved
 * pool, under the ceiling; when they are all exhausted the reader is told the
 * model is temporarily unavailable, which is true. Benchmark mode bypasses the
 * restriction deliberately, because measuring an endpoint means being able to
 * reach it.
 */
export function emergencyExpensiveFallbackEnabled() {
  return process.env.GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK === "true";
}

/** The cost policy in force for one model, or null when there is none. */
export function costPolicyFor(modelId: string) {
  const mode = routingMode();
  if (mode === "auto") return null;
  const capabilities = knownModels.find((model) => model.id === modelId)?.capabilities;
  const ceiling = capabilities?.costCeiling;
  if (!ceiling) return null;
  const pool = poolEnforced() ? approvedProviderPool(modelId) : [];
  return {
    maxPrice: { prompt: ceiling.promptUsdPerMillion, completion: ceiling.completionUsdPerMillion },
    ...(pool.length ? { only: pool } : {}),
    sortByPrice: mode === "cost_optimized",
  };
}

/**
 * The privacy floor for one model's requests, or null when it declares none.
 *
 * Sent to OpenRouter as provider preferences rather than enforced by comparing
 * provider names here, for the same reason the price ceiling is: OpenRouter
 * owns the endpoint catalogue, and a table in this file would be wrong the
 * first time a provider changed its policy.
 */
export function dataPolicyFor(modelId: string) {
  return knownModels.find((model) => model.id === modelId)?.capabilities.dataPolicy ?? null;
}

/**
 * What to send for `reasoning` on one model when the engine has not asked.
 *
 * THREE VALUES, AND THE THIRD IS THE ONE THIS FILE'S OWN CONVENTION REQUIRED
 * AND DID NOT HAVE.
 *
 *   off     deployment-wide: decline reasoning on every model that accepts the
 *           parameter, whatever its catalogue entry says — except where the
 *           endpoint has told us it will not accept the refusal, which is a
 *           contract rather than a preference. See `reasoningIsMandatoryFor`.
 *   auto    deployment-wide: ignore catalogue defaults entirely and send NO
 *           `reasoning` key, which is byte-for-byte the request shape this
 *           deployment sent before `reasoningDefault` was wired up.
 *   unset   the default. A model that declares a default gets it; a model that
 *           declares none says nothing.
 *
 * `auto` exists because wiring `reasoningDefault` in changed what leaves this
 * process for GLM 5.3 Flash and Qwen3.8 Flash: a `reasoning` key now appears in
 * requests that previously carried none. That is the intended behaviour and it
 * is also a new parameter reaching upstream endpoints, and an endpoint that
 * rejects a parameter it does not implement answers 400 — which reaches a
 * reader as "Something went wrong while generating the response".
 *
 * Every other switch in this file can be reverted from a dashboard without a
 * deploy — `PROVIDER_ROUTING_MODE=auto`, `ENFORCE_PROVIDER_POOL=false`,
 * `PROVIDER_POOL_OVERRIDE`, `PROMPT_CONTINUITY_PLACEMENT` — precisely so that a
 * change of this shape can be undone at three in the morning by whoever is
 * awake. This one shipped without that, which was the omission. It has it now.
 *
 * An engine that explicitly asks for thinking still wins over all three.
 */
export function defaultReasoningFor(modelId: string): ReasoningDirective | null {
  const declared = knownModels.find((model) => model.id === modelId)?.capabilities.reasoningDefault ?? null;
  const configured = process.env.RP_REASONING?.trim();
  /*
   * `off` IS AN INTENTION, NOT AN INSTRUCTION TO SEND A REQUEST THAT FAILS.
   *
   * On an endpoint that has told us reasoning cannot be disabled, honouring
   * this switch literally would send `reasoning: { enabled: false }`, collect
   * the 400, drop the parameter and take the endpoint's own default — the MOST
   * reasoning, for two requests and a reader's wait. The model's own declared
   * floor is the nearest thing to the operator's intention that the endpoint
   * will actually serve, so that is what it gets.
   */
  if (configured === "off") return reasoningIsMandatoryFor(modelId) ? declared : "off";
  // The escape hatch: no opinion at all, which is the endpoint's own default.
  // Valid everywhere, including on a mandatory endpoint — silence takes its
  // default rather than contradicting it.
  if (configured === "auto") return null;
  return declared;
}

/**
 * Whether this endpoint refuses to be told not to reason.
 *
 * Read before a retry decides what to change: a generation that spent its
 * envelope thinking is normally answered by asking for no thinking, and on a
 * mandatory endpoint that answer is a 400. There, the thing to change is the
 * envelope. See the chat route's empty-reply path.
 */
export function reasoningIsMandatoryFor(modelId: string) {
  return knownModels.find((model) => model.id === modelId)?.capabilities.reasoningMandatory === true;
}

/**
 * WHAT A BACKGROUND EXTRACTION ASKS FOR WHEN IT ASKS ABOUT THINKING.
 *
 * The answer is "none", and the reason is not economy — it is that hidden
 * reasoning tokens come out of the SAME completion envelope as the JSON, and a
 * background extraction's envelope is deliberately tiny. A consolidation is
 * given 3,600 tokens and a Scene Ledger 400; a model that reasons before it
 * answers can spend all of either and return `content: null`, which is exactly
 * the production failure this exists to stop.
 *
 * IT ALSO MAKES THE TWO PROVIDERS AGREE. `src/lib/deepseek.ts` has always sent
 * `thinking: { type: "disabled" }` on its non-streaming path, so Direct DeepSeek
 * never had this problem. The OpenRouter path sent no `reasoning` key at all,
 * which is not "off" — it is declining to have an opinion, and the endpoint's
 * own default on a reasoning-capable model is to reason. Two background routes
 * to the same job behaving oppositely is not a routing policy, it is an
 * oversight.
 *
 * Three answers, and the middle one is why this is a function rather than a
 * constant:
 *
 *   `undefined`  The endpoint does not accept the `reasoning` parameter at all
 *                (`capabilities.thinking === false`). Sending an unknown
 *                parameter is a 400 with a background job attached to it, so
 *                silence is correct — and such a model has no hidden reasoning
 *                to disable in the first place.
 *   `"off"`      Reasoning is supported and optional. Decline it explicitly.
 *   an effort    Reasoning is MANDATORY on this endpoint. `{ enabled: false }`
 *                would be refused, so the least it will agree to is the nearest
 *                expressible version of the intention. A model that declares
 *                mandatory reasoning without declaring a floor gets the
 *                endpoint default and a note in the report rather than a
 *                request that is known to fail.
 *
 * DELIBERATELY NOT `defaultReasoningFor`. That function serves the RP writer and
 * is steered by `RP_REASONING`, which is an operator's opinion about roleplay.
 * Background extraction is not roleplay and must not move when that switch
 * does.
 */
export function backgroundReasoningFor(modelId: string): "off" | ReasoningEffort | undefined {
  const capabilities = knownModels.find((model) => model.id === modelId)?.capabilities;
  if (!capabilities?.thinking) return undefined;
  if (capabilities.reasoningMandatory) {
    return isReasoningEffort(capabilities.reasoningDefault) ? capabilities.reasoningDefault : undefined;
  }
  return "off";
}

/**
 * Whether this model's endpoint will honour `response_format`.
 *
 * Read by the OpenRouter adapter before it emits the parameter. It used to emit
 * it unconditionally on `json: true`, which is fine until a model that does not
 * implement it is asked to — see the Ling entry above for what that looked like
 * in production.
 *
 * An UNKNOWN model answers true, which is exactly the behaviour every caller
 * had before this existed: a deployment-configured model this file has never
 * seen keeps getting the parameter, and only a model whose catalogue entry
 * says otherwise loses it.
 */
export function supportsStructuredOutput(providerId: string, modelId: string | undefined) {
  if (!modelId) return true;
  return modelCapabilities(providerId, modelId).jsonMode;
}

/**
 * The hidden-token allowance this model's completion envelope has to carry, or
 * null when it declares none — which is every model that never had the problem,
 * and which sends exactly the envelope Response Length asked for.
 */
export function reasoningBudgetFor(modelId: string): ReasoningBudget | null {
  return knownModels.find((model) => model.id === modelId)?.capabilities.reasoningBudget ?? null;
}

/**
 * How OpenRouter should reach one model, for one attempt.
 *
 * Attempt 0 is the warm path: the model's preferred endpoint first, fallbacks
 * still permitted, and no `sort` — so a session that is already sticky stays
 * where its cache is. Later attempts are recovery: the endpoint that just
 * failed is excluded by name and the rest are sorted by live throughput.
 *
 * The one invariant this function may never break is that `model` is not its
 * business. Every policy it returns is a different way to reach the SAME model;
 * substituting another one is a product decision with its own semantics and
 * doing it silently here would mean a reader's chosen writer changed without
 * anybody saying so.
 */
export function providerPolicyFor(
  modelId: string,
  attempt: number,
  failedProviders: string[] = [],
  options: { finalAttempt?: boolean } = {},
): ProviderRoutingPolicy | null {
  const pinned = pinnedProviderFor(modelId);
  if (pinned) return { only: [pinned], allowFallbacks: false };
  /*
   * A DEDICATED MODEL IS ONE HOST ON EVERY ATTEMPT, INCLUDING THE LAST.
   *
   * Answered before any of the cost machinery below, because it is not a cost
   * decision and none of that machinery may lift it: `PROVIDER_ROUTING_MODE=auto`
   * reverts the ceiling, `ENFORCE_PROVIDER_POOL=false` makes an ordinary pool
   * advisory, and the emergency fallback lifts the ceiling on a final attempt —
   * and every one of those, applied here, would answer a Z.AI outage with a
   * different serving profile under the same name. That is the substitution
   * this file exists to prevent, made silently and at the hour nobody is
   * watching.
   *
   * So: `only` and nothing else. No `order` and no `sort`, because both are
   * ways of choosing between candidates and there is one candidate — and both
   * turn OpenRouter's sticky session routing off, which is what keeps the
   * prompt cache warm. No `ignore` either: excluding the host that just failed
   * would leave the candidate set empty, turning a retry into a guaranteed
   * failure. Retrying the same host is what a transient 5xx deserves, and when
   * the attempts are spent the reader is told the model is temporarily
   * unavailable.
   *
   * The price ceiling and the privacy floor still travel with it. Neither can
   * widen the route; both can still refuse it, which is the direction a guard
   * is allowed to fail in.
   */
  const dedicated = dedicatedProviderFor(modelId);
  if (dedicated) {
    const dedicatedCost = costPolicyFor(modelId);
    const dedicatedPrivacy = dataPolicyFor(modelId);
    return {
      only: approvedProviderPool(modelId),
      allowFallbacks: false,
      ...(dedicatedCost ? { maxPrice: dedicatedCost.maxPrice } : {}),
      ...(dedicatedPrivacy ? { dataCollection: dedicatedPrivacy.dataCollection, ...(dedicatedPrivacy.zdr ? { zdr: true } : {}) } : {}),
    };
  }
  const preferred = knownModels.find((model) => model.id === modelId)?.capabilities.preferredProviders ?? [];
  /*
   * The hosts that already failed this request, so recovery routes around them.
   *
   * Validated as PROVIDER TAGS rather than as ids, because that is what they
   * are: they come from OpenRouter's `x-openrouter-provider` header or from the
   * `order` the previous attempt asked for, so a slashed tag must be able to be
   * excluded. Filtering it out here would send the next attempt straight back
   * to the host that just went quiet.
   */
  const ignore = failedProviders.filter((value) => safeProviderTag(value));
  /*
   * THE CEILING AND THE POOL SURVIVE EVERY ATTEMPT.
   *
   * They used to be dropped on the last one, on the argument that two attempts
   * had already been spent inside the affordable set and one dear generation
   * beats a failed turn mid-scene. The argument is sound and the DEFAULT was
   * wrong: it converted a provider outage — the moment nobody is watching —
   * into unbounded spend, silently, with no operator decision anywhere in it.
   *
   * So the emergency route still exists and now has to be asked for:
   * `GLM_ALLOW_EMERGENCY_EXPENSIVE_FALLBACK=true`. Benchmark mode also
   * bypasses, because measuring an endpoint means being able to reach it. With
   * neither, every attempt is the same model, inside the approved pool, under
   * the ceiling — and when they are all exhausted the honest answer is that the
   * model is temporarily unavailable, which is what the reader is told.
   */
  const emergency = options.finalAttempt && (emergencyExpensiveFallbackEnabled() || routingMode() === "benchmark");
  const cost = emergency ? null : costPolicyFor(modelId);
  const privacy = dataPolicyFor(modelId);
  const guard = {
    ...(cost ? { maxPrice: cost.maxPrice, ...(cost.only ? { only: cost.only } : {}) } : {}),
    /*
     * The privacy floor is NOT an economic guard and is never lifted.
     *
     * An emergency that is allowed to spend more money is not thereby allowed
     * to send a private roleplay to an endpoint that trains on it. These two
     * policies travel together in the request and separately in the reasoning.
     */
    ...(privacy ? { dataCollection: privacy.dataCollection, ...(privacy.zdr ? { zdr: true } : {}) } : {}),
  };
  const hasGuard = Object.keys(guard).length > 0;

  if (attempt === 0) {
    if (!preferred.length && !ignore.length && !hasGuard) return null;
    return {
      ...(preferred.length ? { order: preferred } : {}),
      ...(ignore.length ? { ignore } : {}),
      ...guard,
      allowFallbacks: true,
      /*
       * NO `sort` ON THE WARM PATH unless cost_optimized asks for one.
       *
       * OpenRouter pins a conversation to the host holding its prompt cache
       * from the `session_id` the chat route sends, and its documentation is
       * explicit that setting `order` — and, less explicitly, `sort` — turns
       * its own routing off. The cheapest request is the one that HITS, so the
       * default policy states a ceiling and then gets out of the way.
       */
      ...(cost?.sortByPrice ? { sort: "price" as const } : {}),
    };
  }
  /*
   * Recovery, bounded by the same ceiling.
   *
   * `sort: "throughput"` is kept: an attempt reaching here has already lost the
   * cache it was warm on, so the fastest healthy host is the right choice.
   * What changed is that "healthy" is now drawn from the affordable set rather
   * than from every host serving the slug — a timeout was previously able to
   * move a conversation onto the dearest endpoint in the catalogue, at the
   * moment nobody was watching, and stickiness would then keep it there.
   */
  return { ...(ignore.length ? { ignore } : {}), ...guard, allowFallbacks: true, sort: "throughput" };
}

const taskRouteEnvironment: Record<Exclude<InferenceTask,"rp_generation">, string> = {
  memory_consolidation: "MEMORY_CONSOLIDATION_MODEL_ROUTE",
  memory_curation: "MEMORY_CURATION_MODEL_ROUTE",
  scene_state: "SCENE_STATE_MODEL_ROUTE",
  character_import: "CHARACTER_IMPORT_MODEL_ROUTE",
};

function parseRoute(value: string): InferenceSelection | null {
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  const providerId = value.slice(0, separator).trim();
  const modelId = value.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : null;
}

/**
 * Background work has its own writer selection. This prevents a conversation's
 * experimental RP writer from silently becoming the JSON/consolidation model.
 */
export function taskModelSelection(task: InferenceTask, conversation?: InferenceSelection): InferenceSelection {
  if (task === "rp_generation") {
    const configured = process.env.RP_MODEL_ROUTE?.trim() || "conversation";
    const selection = configured === "conversation" ? conversation : parseRoute(configured);
    if (!selection || !resolveModel(selection.providerId,selection.modelId)) throw new Error("RP_MODEL_ROUTE does not name an enabled provider/model or conversation");
    return selection;
  }
  const configured = process.env[taskRouteEnvironment[task]]?.trim();
  const selection = configured ? parseRoute(configured) : { providerId: "deepseek", modelId: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash" };
  if (!selection || !resolveModel(selection.providerId, selection.modelId)) {
    throw new Error(`${taskRouteEnvironment[task]} does not name an enabled provider/model`);
  }
  return selection;
}

export function resolveEngine(engineId: string) {
  return engines.find((engine) => engine.id === engineId) ?? null;
}

export { enginePrompt } from "./engines";
