import * as deepseek from "./deepseek";
import { resolveModel } from "./provider";

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };
export type LLMUsage = deepseek.DeepSeekUsage;
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

const adapters = new Map<string, LLMProvider>([[deepSeekProvider.id, deepSeekProvider]]);

function adapter(selection: ModelSelection) {
  if (!resolveModel(selection.providerId, selection.modelId)) {
    throw new Error("That provider/model combination is not available on this deployment");
  }
  const found = adapters.get(selection.providerId);
  if (!found) throw new Error(`Provider ${selection.providerId} is not configured`);
  return found;
}

export function completionWithUsage(selection: ModelSelection, messages: LLMMessage[], options: CompletionOptions = {}) {
  return adapter(selection).completionWithUsage(messages, selection.modelId, options);
}

export function streamCompletion(selection: ModelSelection, messages: LLMMessage[], options: CompletionOptions = {}) {
  return adapter(selection).streamCompletion(messages, selection.modelId, options);
}

export const parseJson = deepseek.parseJson;
