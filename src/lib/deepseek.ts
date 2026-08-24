import { ProviderError, classifyProviderFailure } from "./provider-errors";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type DeepSeekUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

const baseUrl = () => (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
export const model = () => process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

function apiKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new ProviderError("auth", { provider: "deepseek", detail: "DEEPSEEK_API_KEY is not configured" });
  return key;
}

async function request(body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    // Classified rather than stringified: the upstream body stays in the
    // diagnostic bag and the reader is told one calm sentence instead.
    const detail = (await response.text()).slice(0, 500);
    throw new ProviderError(classifyProviderFailure(response.status, detail), {
      provider: "deepseek",
      model: String(body.model ?? ""),
      status: response.status,
      detail,
    });
  }
  return response;
}

export async function completion(
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal; model?: string } = {},
) {
  return (await completionWithUsage(messages, options)).content;
}

export async function completionWithUsage(
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal; model?: string } = {},
) {
  const response = await request({
    model: options.model || model(), messages,
    thinking: { type: "disabled" },
    max_tokens: options.maxTokens ?? 1000,
    temperature: options.temperature ?? 0.85,
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
  }, options.signal);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ProviderError("empty_response", { provider: "deepseek", model: options.model || model() });
  return { content, usage: (data?.usage ?? null) as DeepSeekUsage | null };
}

export async function streamCompletion(
  messages: ChatMessage[],
  options: { signal?: AbortSignal; model?: string; maxTokens?: number; temperature?: number; thinking?: boolean } = {},
) {
  const thinking = Boolean(options.thinking);
  const response = await request({
    model: options.model || model(), messages,
    thinking: { type: thinking ? "enabled" : "disabled" },
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: options.maxTokens ?? 1800,
    ...(thinking ? {} : { temperature: options.temperature ?? 0.95 }),
  }, options.signal);
  if (!response.body) throw new ProviderError("empty_response", { provider: "deepseek", model: options.model || model(), detail: "response carried no stream" });
  return response.body;
}

export function parseJson<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as T;
}
