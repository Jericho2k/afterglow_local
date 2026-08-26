import * as deepseek from "./deepseek";
import * as openrouter from "./openrouter";
import { providerModelId, resolveModel } from "./provider";

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
  thinking?: boolean;
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
   * Upstream endpoints already known to have failed this request.
   *
   * Same model, different host. Nothing in an adapter may ever use this to
   * reach a DIFFERENT model: substituting one writer for another is a product
   * decision with its own semantics, and making it silently in a retry would
   * change a reader's chosen writer without anybody saying so.
   */
  excludeProviders?: string[];
};

/** The adapter contract future OpenRouter or self-hosted runtimes implement. */
export interface LLMProvider {
  id: string;
  completionWithUsage(messages: LLMMessage[], modelId: string, options?: CompletionOptions): Promise<{ content: string; usage: LLMUsage | null }>;
  streamCompletion(messages: LLMMessage[], modelId: string, options?: CompletionOptions): Promise<ReadableStream<Uint8Array>>;
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

export function streamCompletion(selection: ModelSelection, messages: LLMMessage[], options: CompletionOptions = {}) {
  const { found,upstreamModelId } = adapter(selection);
  return found.streamCompletion(messages,upstreamModelId,options);
}

export function embeddingWithUsage(input: string | string[], options: { model?: string; dimensions?: number; signal?: AbortSignal } = {}) {
  if (!process.env.ENABLE_OPENROUTER || process.env.ENABLE_OPENROUTER !== "true") throw new Error("OpenRouter embeddings are disabled");
  return openrouter.embed(input,options.model,options.dimensions,options.signal);
}

export const parseJson = deepseek.parseJson;
