import type { CompletionOptions, LLMMessage, LLMUsage } from "./llm";

const baseUrl = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured");
  return key;
}

function headers() {
  const result: Record<string,string> = {
    Authorization: `Bearer ${apiKey()}`,
    "Content-Type": "application/json",
    "X-Title": process.env.OPENROUTER_APP_NAME?.trim() || "Afterglow",
  };
  const referer = process.env.OPENROUTER_SITE_URL?.trim();
  if (referer) result["HTTP-Referer"] = referer;
  return result;
}

async function request(body: Record<string,unknown>, signal?: AbortSignal) {
  const startedAt = Date.now();
  let failure = "";
  let status = 502;
  for (let attempt=0;attempt<2;attempt+=1) {
    // The retry favors live throughput and explicitly permits another host.
    // This recovers from stale provider deployments without changing models.
    const payload = attempt === 0 ? body : {
      ...body,
      provider: { allow_fallbacks:true, sort:"throughput" },
    };
    const response = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal,
    });
    if (response.ok) return { response, startedAt };
    status = response.status;
    failure = (await response.text()).slice(0,500);
    const providerRouteFailure = response.status === 404 && /provider returned error|deployment .*doesn.t exist|isn.t accessible/i.test(failure);
    if (attempt === 0 && (providerRouteFailure || response.status === 502 || response.status === 503 || response.status === 504)) continue;
    break;
  }
  throw new Error(`OpenRouter request failed (${status}): ${failure}`);
}

function enrichedUsage(data: Record<string,unknown>, startedAt: number): LLMUsage | null {
  const raw = data.usage;
  if (!raw || typeof raw !== "object") return null;
  return {
    ...(raw as LLMUsage),
    provider_request_id: typeof data.id === "string" ? data.id : undefined,
    actual_model: typeof data.model === "string" ? data.model : undefined,
    latency_ms: Math.max(0,Date.now() - startedAt),
  };
}

export async function completionWithUsage(messages: LLMMessage[], model: string, options: CompletionOptions = {}) {
  const { response, startedAt } = await request({
    model,
    messages,
    max_tokens: options.maxTokens ?? 1000,
    temperature: options.temperature ?? 0.85,
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
    ...(options.thinking ? { reasoning: { enabled: true } } : {}),
  },options.signal);
  const data = await response.json() as Record<string,unknown> & { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter returned an empty response");
  return { content, usage: enrichedUsage(data,startedAt) };
}

export async function streamCompletion(messages: LLMMessage[], model: string, options: CompletionOptions = {}) {
  const { response } = await request({
    model,
    messages,
    stream: true,
    max_tokens: options.maxTokens ?? 1800,
    temperature: options.temperature ?? 0.95,
    ...(options.thinking ? { reasoning: { enabled: true } } : {}),
  },options.signal);
  if (!response.body) throw new Error("OpenRouter returned no stream");
  return response.body;
}

export async function embed(input: string | string[], model = "qwen/qwen3-embedding-8b", dimensions = 1024, signal?: AbortSignal) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl()}/embeddings`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model,input,dimensions,encoding_format:"float" }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0,500);
    throw new Error(`OpenRouter embedding request failed (${response.status}): ${detail}`);
  }
  const data = await response.json() as Record<string,unknown> & { data?: Array<{ embedding?: unknown }> };
  const embeddings = (data.data ?? []).map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item) && item.every((value) => typeof value === "number"));
  if (!embeddings.length) throw new Error("OpenRouter returned no embeddings");
  return { embeddings, usage: enrichedUsage(data,startedAt), model: typeof data.model === "string" ? data.model : model };
}
