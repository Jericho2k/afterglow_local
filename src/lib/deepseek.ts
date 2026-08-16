type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const baseUrl = () => (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
export const model = () => process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

function apiKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured");
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
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`DeepSeek request failed (${response.status}): ${detail}`);
  }
  return response;
}

export async function completion(
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
  if (typeof content !== "string") throw new Error("DeepSeek returned an empty response");
  return content;
}

export async function streamCompletion(
  messages: ChatMessage[],
  options: { signal?: AbortSignal; model?: string; maxTokens?: number; temperature?: number } = {},
) {
  const response = await request({
    model: options.model || model(), messages,
    thinking: { type: "disabled" },
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: options.maxTokens ?? 1800,
    temperature: options.temperature ?? 0.95,
  }, options.signal);
  if (!response.body) throw new Error("DeepSeek returned no stream");
  return response.body;
}

export function parseJson<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as T;
}
