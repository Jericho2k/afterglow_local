import type { ModelCatalog, ModelDefinition, ProviderDefinition, RoleplayEngineDefinition, RoleplayEngineId } from "./types";
import { engineDefinitions } from "./engines";
import type { ModelVerbosity } from "./response-length";

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
   * Endpoints known to serve this model at an acceptable price and with
   * prompt-cache support.
   *
   * ADVISORY BY DEFAULT, and deliberately so: it becomes a hard `provider.only`
   * restriction only when an operator sets `ENFORCE_PROVIDER_ALLOWLIST`. A
   * slug that is wrong or has been renamed upstream turns `only` into a total
   * outage for the model, and these slugs could not be checked against
   * OpenRouter's live catalogue from the build environment — see the note on
   * the GLM entry. `costCeiling` above guards the same thing without depending
   * on any string being right.
   */
  affordableProviders?: string[];
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
    capabilities: { thinking: true, jsonMode: true, promptCaching: true },
  },
  {
    id: "minimax-m2-her",
    providerId: "openrouter",
    providerModelId: "minimax/minimax-m2-her",
    label: "MiniMax M2-her",
    description: "Dialogue-first roleplay model for expressive, character-driven conversations.",
    supportsThinking: false,
    capabilities: { thinking: false, jsonMode: true, promptCaching: true },
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
    capabilities: { thinking: true, jsonMode: true, promptCaching: true },
  },
  {
    id: "kimi-k2.6",
    providerId: "openrouter",
    providerModelId: "moonshotai/kimi-k2.6",
    label: "MoonshotAI Kimi K2.6",
    description: "Moonshot's newer long-context writer. Same strengths as K2.5 with a larger context window.",
    supportsThinking: true,
    capabilities: { thinking: true, jsonMode: true, promptCaching: true },
  },
  /*
   * GLM 4.7, and the one model in this catalogue that declares a price ceiling.
   *
   * WHY IT NEEDS ONE. Eight or so upstream hosts serve this slug at prices that
   * differ by a factor of several, and a month of production traffic landed on
   * four of them. The model page's headline price is the CHEAPEST endpoint's
   * price; what a conversation actually pays is whichever host OpenRouter's
   * price-weighted load balancer happened to pick for it, which is a different
   * number and is not bounded by anything.
   *
   * The rates below were reported by the operator from OpenRouter's live
   * catalogue and corroborated for DeepInfra by secondary sources, per million
   * tokens, fresh / cached / output:
   *
   *   DeepInfra   0.40 / 0.08  / 1.75
   *   Novita      0.54 / 0.099 / 1.98
   *   Z.AI        0.60 / 0.11  / 2.20
   *
   * DeepInfra is cheaper than Z.AI on all three lines, so at EQUAL cache hit
   * rates it is the cheaper home for a conversation. That is the whole argument
   * for the ceiling; it is not an argument for pinning DeepInfra, because a pin
   * would override the session stickiness that keeps a conversation's cache
   * warm and would take GLM down whenever one host is unhealthy.
   *
   * WHERE THE NUMBERS COME FROM. 0.65 and 2.25 sit just above Z.AI, the
   * dearest of the three endpoints worth keeping, and below the ~2.65/M output
   * endpoints that prompted this. Three healthy hosts stay eligible, so the
   * ceiling costs no reliability; it removes only the endpoints that are
   * dominated on price by hosts already serving this traffic.
   *
   * OPERATORS: the slugs in `affordableProviders` are the OpenRouter provider
   * slugs `deepinfra`, `novita` and `z-ai`, which are documented slugs but
   * could NOT be confirmed against this model's live endpoint list from the
   * build environment, which has no egress to openrouter.ai. They are advisory
   * until `ENFORCE_PROVIDER_ALLOWLIST` is set; confirm them first, because a
   * wrong slug in `provider.only` means every GLM request fails. The ceiling
   * needs no such confirmation and is what production relies on.
   */
  {
    id: "glm-4.7",
    providerId: "openrouter",
    providerModelId: "z-ai/glm-4.7",
    label: "Z.ai GLM 4.7",
    description: "General comparison writer with stable multi-step reasoning and long context.",
    supportsThinking: true,
    capabilities: {
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      costCeiling: { promptUsdPerMillion: 0.65, completionUsdPerMillion: 2.25 },
      affordableProviders: ["deepinfra", "novita", "z-ai"],
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
    capabilities: {
      contextTokens: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      preferredProviders: ["xiaomi"],
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
    capabilities: {
      contextTokens: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: true,
      jsonMode: true,
      promptCaching: true,
      preferredProviders: ["xiaomi"],
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
    capabilities: { contextTokens: 131_072, maxOutputTokens: 131_072, thinking: false, jsonMode: false, promptCaching: false },
  },
  {
    id: "wild-peach",
    providerId: "openrouter",
    providerModelId: "thedrummer/rocinante-12b",
    label: "Wild Peach — Expressive RP",
    description: "Lighter expressive writer tuned for vivid vocabulary and engaging prose.",
    supportsThinking: false,
    capabilities: { contextTokens: 65_536, maxOutputTokens: 65_536, thinking: false, jsonMode: false, promptCaching: false },
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
  };
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
    };
  });
}

export function availableCatalog(): ModelCatalog {
  const models = availableModels();
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
    if (model === modelId && provider && safeId(provider)) return provider;
  }
  return null;
}

export type ProviderRoutingPolicy = {
  /** Endpoints to try first, in order. Never the only ones allowed. */
  order?: string[];
  /** The benchmark pin, or an enforced allowlist: these and nothing else. */
  only?: string[];
  /** Endpoints already known to have failed this request. */
  ignore?: string[];
  allowFallbacks: boolean;
  sort?: "throughput" | "price" | "latency";
  /** Per-million ceilings an endpoint must be under to be eligible. */
  maxPrice?: { prompt: number; completion: number };
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
 * Whether a declared `affordableProviders` list becomes a hard restriction.
 *
 * Off by default. See the note on `affordableProviders`: an unverified slug in
 * `provider.only` is an outage, and the price ceiling guards the same thing
 * without depending on a string.
 */
function allowlistEnforced() {
  return process.env.ENFORCE_PROVIDER_ALLOWLIST === "true";
}

/** The cost policy in force for one model, or null when there is none. */
export function costPolicyFor(modelId: string) {
  const mode = routingMode();
  if (mode === "auto") return null;
  const capabilities = knownModels.find((model) => model.id === modelId)?.capabilities;
  const ceiling = capabilities?.costCeiling;
  if (!ceiling) return null;
  const allowlist = allowlistEnforced() ? capabilities?.affordableProviders?.filter((value) => safeId(value)) : undefined;
  return {
    maxPrice: { prompt: ceiling.promptUsdPerMillion, completion: ceiling.completionUsdPerMillion },
    ...(allowlist?.length ? { only: allowlist } : {}),
    sortByPrice: mode === "cost_optimized",
  };
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
  const preferred = knownModels.find((model) => model.id === modelId)?.capabilities.preferredProviders ?? [];
  const ignore = failedProviders.filter((value) => safeId(value));
  /*
   * THE CEILING IS DROPPED ON THE LAST ATTEMPT, AND ONLY THERE.
   *
   * Two earlier attempts have already been spent inside the affordable set, so
   * reaching here means every endpoint under the ceiling either failed or went
   * quiet. At that point the choice is a dearer endpoint or no reply at all,
   * and one expensive generation is a far smaller harm to a reader mid-scene
   * than a failed turn. It stays a genuine emergency: it cannot be reached
   * without two prior failures, and it never substitutes a different MODEL.
   */
  const cost = options.finalAttempt ? null : costPolicyFor(modelId);
  const guard = cost ? { maxPrice: cost.maxPrice, ...(cost.only ? { only: cost.only } : {}) } : {};

  if (attempt === 0) {
    if (!preferred.length && !ignore.length && !cost) return null;
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
