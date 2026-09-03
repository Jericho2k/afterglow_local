import * as deepseek from "./deepseek";
import * as openrouter from "./openrouter";
import { providerModelId, resolveModel } from "./provider";
import type { InferenceFunding } from "./byok";
import type { ReasoningEffort } from "./reasoning";

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };
export type LLMUsage = deepseek.DeepSeekUsage & {
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; [key: string]: unknown };
  completion_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
  cost?: number;
  cost_details?: { upstream_inference_cost?: number; [key: string]: unknown };
  provider_request_id?: string;
  actual_model?: string;
  latency_ms?: number;
  ttft_ms?: number;
  upstream_provider?: string;
};
export type ModelSelection = { providerId: string; modelId: string };

export type CompletionOptions = {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  /**
   * Whether to ask the endpoint for reasoning, in four distinguishable states.
   *
   *   true     ask for it
   *   false    say nothing, and take whatever the endpoint does by default
   *   "off"    ask for NONE, explicitly
   *   effort   ask for it and say how much
   *
   * The difference between the last two is not pedantry, and it was a live bug.
   * GLM 4.7 is a hybrid reasoning model, and several endpoints serving models
   * like it reason unless told not to — so OMITTING the parameter is not the
   * same as declining reasoning, it is declining to have an opinion. The empty-
   * reply retry in the chat route relied on `false` meaning the former: having
   * watched a generation spend its whole envelope on reasoning and return no
   * prose, it retried "asking for none" and in fact asked for exactly the same
   * thing again.
   *
   * `"off"` is only ever sent to an endpoint that accepts the `reasoning`
   * parameter at all — `ModelCapabilities.thinking` — because sending an
   * unknown parameter to one that does not is a 400 with a reader's turn
   * attached to it.
   *
   * A FOURTH STATE, BECAUSE SOME ENDPOINTS ALLOW NO OTHER. An effort level —
   * "minimal", "low", "medium", "high" — asks for reasoning and says how much
   * of it. It is what a model whose endpoint MANDATES reasoning gets instead of
   * `"off"`: Z.AI's GLM 5.3 Flash answers `{ enabled: false }` with a 400, so
   * "the least this endpoint will agree to" is the only expressible version of
   * the intention `"off"` was standing in for. See src/lib/reasoning.ts.
   */
  thinking?: boolean | "off" | ReasoningEffort;
  /**
   * Opaque provider-stickiness hint for one conversation and one task.
   * Built by src/lib/inference-session.ts; adapters that have no such concept
   * ignore it.
   */
  sessionId?: string;
  /**
   * The AFTERGLOW catalogue id, not the upstream slug.
   *
   * The adapter needs it to choose a routing policy — which upstream endpoints
   * to prefer for this model, and which to exclude after one has failed — and
   * that is a decision about a catalogue entry rather than about a provider's
   * naming. Adapters with no notion of routing ignore it.
   */
  modelId?: string;
  /**
   * WHETHER DROPPING `reasoning` IS AN ACCEPTABLE RECOVERY.
   *
   * The adapter negotiates one parameter: told that reasoning cannot be
   * disabled, it drops the key and retries, which takes the endpoint's own
   * default. For a roleplay turn that is right — the reply still arrives, a
   * little later and with more thinking than anybody wanted.
   *
   * For a BACKGROUND STRUCTURED EXTRACTION it is precisely wrong. The envelope
   * is 400 to 3,600 tokens and the whole point of declining reasoning is that
   * hidden tokens are spent from it; silently re-enabling reasoning inside that
   * envelope reproduces the empty-content failure the request was shaped to
   * avoid, at the same cost, one attempt later.
   *
   * So a caller may say the refusal is a FACT ABOUT THE ROUTE rather than
   * something to work around. The request fails with the endpoint's own words
   * in the diagnostic, the operator learns the pinned host is incompatible with
   * the job, and the memory fallback answers with a route that works.
   */
  strictReasoning?: boolean;
  /**
   * Upstream endpoints already known to have failed this request.
   *
   * Same model, different host. Nothing in an adapter may ever use this to
   * reach a DIFFERENT model: substituting one writer for another is a product
   * decision with its own semantics, and making it silently in a retry would
   * change a reader's chosen writer without anybody saying so.
   */
  excludeProviders?: string[];
  /**
   * Admin-only hard pin for writer-provider/cache experiments.
   *
   * This is intentionally request-scoped rather than an environment setting:
   * the authenticated chat route supplies it only for an Afterglow admin.
   * OpenRouter still applies the model's normal price/privacy guards.
   */
  upstreamProviderOverride?: string;
};

/** Adapter-only authentication. Generic/background completion APIs omit it. */
export type ProviderAuthentication =
  | { type: "platform" }
  | { type: "openrouter_byok"; credential: string };

export type ProviderCompletionOptions = CompletionOptions & {
  authentication?: ProviderAuthentication;
};

/** The adapter contract future OpenRouter or self-hosted runtimes implement. */
export interface LLMProvider {
  id: string;
  completionWithUsage(messages: LLMMessage[], modelId: string, options?: ProviderCompletionOptions): Promise<{ content: string; usage: LLMUsage | null }>;
  streamCompletion(messages: LLMMessage[], modelId: string, options?: ProviderCompletionOptions): Promise<ReadableStream<Uint8Array>>;
}

const deepSeekProvider: LLMProvider = {
  id: "deepseek",
  completionWithUsage(messages, modelId, options = {}) {
    return deepseek.completionWithUsage(messages, { ...options, model: modelId });
  },
  streamCompletion(messages, modelId, options = {}) {
    return deepseek.streamCompletion(messages, { ...options, model: modelId });
  },
};

const openRouterProvider: LLMProvider = {
  id: "openrouter",
  completionWithUsage(messages,modelId,options = {}) {
    return openrouter.completionWithUsage(messages,modelId,options);
  },
  streamCompletion(messages,modelId,options = {}) {
    return openrouter.streamCompletion(messages,modelId,options);
  },
};

const adapters = new Map<string, LLMProvider>([[deepSeekProvider.id,deepSeekProvider],[openRouterProvider.id,openRouterProvider]]);

function adapter(selection: ModelSelection) {
  if (!resolveModel(selection.providerId, selection.modelId)) {
    throw new Error("That provider/model combination is not available on this deployment");
  }
  const found = adapters.get(selection.providerId);
  if (!found) throw new Error(`Provider ${selection.providerId} is not configured`);
  const upstreamModelId = providerModelId(selection.providerId,selection.modelId);
  if (!upstreamModelId) throw new Error("That provider/model combination is not available on this deployment");
  return { found, upstreamModelId };
}

export function completionWithUsage(selection: ModelSelection, messages: LLMMessage[], options: CompletionOptions = {}) {
  const { found,upstreamModelId } = adapter(selection);
  return found.completionWithUsage(messages,upstreamModelId,options);
}

function streamCompletionWithProviderOptions(selection: ModelSelection, messages: LLMMessage[], options: ProviderCompletionOptions = {}) {
  const { found,upstreamModelId } = adapter(selection);
  return found.streamCompletion(messages,upstreamModelId,options);
}

/** Generic/platform streaming retained for diagnostics and tests; no BYOK input. */
export function streamCompletion(selection: ModelSelection, messages: LLMMessage[], options: CompletionOptions = {}) {
  return streamCompletionWithProviderOptions(selection, messages, options);
}

/**
 * This is the only exported streaming path that can accept user funding.
 * Background inference uses completionWithUsage and therefore has no API that
 * accepts a user credential.
 */
export function streamWriterCompletion(selection: ModelSelection, messages: LLMMessage[], funding: InferenceFunding, options: CompletionOptions = {}) {
  if (funding.type === "byok" && selection.providerId !== funding.provider) {
    throw new Error("BYOK funding may only authenticate its matching writer provider");
  }
  const authentication: ProviderAuthentication | undefined = funding.type === "byok"
    ? { type: "openrouter_byok", credential: funding.credential }
    : selection.providerId === "openrouter" ? { type: "platform" } : undefined;
  return streamCompletionWithProviderOptions(selection, messages, { ...options, authentication });
}

export function embeddingWithUsage(input: string | string[], options: { model?: string; dimensions?: number; signal?: AbortSignal } = {}) {
  if (!process.env.ENABLE_OPENROUTER || process.env.ENABLE_OPENROUTER !== "true") throw new Error("OpenRouter embeddings are disabled");
  return openrouter.embed(input,options.model,options.dimensions,options.signal);
}

export const parseJson = deepseek.parseJson;
