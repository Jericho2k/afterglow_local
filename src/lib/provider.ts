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
  {
    id: "glm-4.7",
    providerId: "openrouter",
    providerModelId: "z-ai/glm-4.7",
    label: "Z.ai GLM 4.7",
    description: "General comparison writer with stable multi-step reasoning and long context.",
    supportsThinking: true,
    capabilities: { thinking: true, jsonMode: true, promptCaching: true },
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
  // The platform rollout plus its key enables every OpenRouter route. A configured BYOK rollout
  // also exposes OpenRouter writers, while background tasks still receive no
  // request credential and therefore continue to require the platform key.
  const personalWriterAvailable=process.env.ENABLE_BYOK==="true"&&Boolean(process.env.BYOK_ENCRYPTION_KEY?.trim());
  return (process.env.ENABLE_OPENROUTER === "true"&&Boolean(process.env.OPENROUTER_API_KEY?.trim()))||personalWriterAvailable;
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
  /** The benchmark pin: these and nothing else. */
  only?: string[];
  /** Endpoints already known to have failed this request. */
  ignore?: string[];
  allowFallbacks: boolean;
  sort?: "throughput" | "price" | "latency";
};

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
export function providerPolicyFor(modelId: string, attempt: number, failedProviders: string[] = []): ProviderRoutingPolicy | null {
  const pinned = pinnedProviderFor(modelId);
  if (pinned) return { only: [pinned], allowFallbacks: false };
  const preferred = knownModels.find((model) => model.id === modelId)?.capabilities.preferredProviders ?? [];
  const ignore = failedProviders.filter((value) => safeId(value));
  if (attempt === 0) {
    if (!preferred.length && !ignore.length) return null;
    return { ...(preferred.length ? { order: preferred } : {}), ...(ignore.length ? { ignore } : {}), allowFallbacks: true };
  }
  return { ...(ignore.length ? { ignore } : {}), allowFallbacks: true, sort: "throughput" };
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
