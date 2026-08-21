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
};
export type ModelSelection = { providerId: string; modelId: string };

export type CompletionOptions = {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  thinking?: boolean;
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
