import type { CompletionOptions, LLMMessage, LLMUsage } from "./llm";
import { ProviderError, classifyProviderFailure } from "./provider-errors";

const baseUrl = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new ProviderError("auth", { provider: "openrouter", detail: "OPENROUTER_API_KEY is not configured" });
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

/**
 * Same-model failover.
 *
 * A temporary upstream failure is a fact about one HOST, not about the model
 * the reader chose. So every attempt sends the identical `model` and changes
 * only how OpenRouter is allowed to reach it: attempt one takes the route it
 * would take anyway (warm, and sticky if a session id was supplied), and later
 * attempts explicitly permit another provider serving that same model, sorted
 * by live throughput.
 *
 * Nothing in this file may substitute one model for another. Skyfall failing
 * is never a reason to answer as Kimi — model fallback is a product decision
 * with its own semantics, and silently making it here would mean a reader's
 * chosen writer changed without anybody saying so.
 */
const attemptPolicies = [
  { provider: undefined, delayMs: 0 },
  { provider: { allow_fallbacks: true, sort: "throughput" }, delayMs: 350 },
  { provider: { allow_fallbacks: true, sort: "throughput" }, delayMs: 900 },
] as const;

/** Bounded by construction: three attempts, ~1.25s of added delay at worst. */
export const maxAttempts = attemptPolicies.length;

function wait(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new ProviderError("timeout", { provider: "openrouter", detail: "aborted while backing off" })); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function request(body: Record<string,unknown>, signal?: AbortSignal, diagnosticModel?: string) {
  let lastError: ProviderError | null = null;

  for (let attempt = 0; attempt < attemptPolicies.length; attempt += 1) {
    const policy = attemptPolicies[attempt];
    if (policy.delayMs) await wait(policy.delayMs, signal);
    const startedAt = Date.now();
    const payload = policy.provider ? { ...body, provider: policy.provider } : body;

    let response: Response;
    try {
      response = await fetch(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      // A transport failure is indistinguishable from a dead host, and is
      // treated as one: same model, another provider, bounded attempts.
      if (signal?.aborted) throw new ProviderError("timeout", { provider: "openrouter", model: diagnosticModel, attempt: attempt + 1 });
      lastError = new ProviderError("upstream_unavailable", {
        provider: "openrouter", model: diagnosticModel, attempt: attempt + 1,
        latencyMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      continue;
    }

    if (response.ok) return { response, startedAt };

    const detail = (await response.text()).slice(0, 500);
    lastError = new ProviderError(classifyProviderFailure(response.status, detail), {
      provider: "openrouter",
      model: diagnosticModel,
      status: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined,
      upstreamProvider: response.headers.get("x-openrouter-provider") ?? undefined,
      attempt: attempt + 1,
      latencyMs: Date.now() - startedAt,
      detail,
    });
    // A configuration, credential or billing failure is not transient. Trying
    // it twice more only delays telling the reader something honest.
    if (!lastError.retryable) break;
  }

  throw lastError ?? new ProviderError("unknown", { provider: "openrouter", model: diagnosticModel });
}

function enrichedUsage(data: Record<string,unknown>, startedAt: number): LLMUsage | null {
  const raw = data.usage;
  if (!raw || typeof raw !== "object") return null;
  return {
    ...(raw as LLMUsage),
    provider_request_id: typeof data.id === "string" ? data.id : undefined,
    actual_model: typeof data.model === "string" ? data.model : undefined,
    upstream_provider: typeof data.provider === "string" ? data.provider : undefined,
    latency_ms: Math.max(0,Date.now() - startedAt),
  };
}

/**
 * The fields every OpenRouter call shares.
 *
 * `usage.include` is what makes the cost, the cached-token counts and the
 * serving provider come back at all — without it a streamed generation reports
 * nothing, which is why OpenRouter replies were previously absent from the
 * usage ledger. `session_id` is the provider-stickiness hint; it is omitted
 * rather than randomised when a task has no stable session.
 */
function commonFields(options: CompletionOptions) {
  return {
    usage: { include: true },
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    ...(options.thinking ? { reasoning: { enabled: true } } : {}),
  };
}

export async function completionWithUsage(messages: LLMMessage[], model: string, options: CompletionOptions = {}) {
  const { response, startedAt } = await request({
    model,
    messages,
    max_tokens: options.maxTokens ?? 1000,
    temperature: options.temperature ?? 0.85,
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
    ...commonFields(options),
  },options.signal,model);
  const data = await response.json() as Record<string,unknown> & { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new ProviderError("empty_response", { provider: "openrouter", model, requestId: typeof data.id === "string" ? data.id : undefined });
  }
  return { content, usage: enrichedUsage(data,startedAt) };
}

export async function streamCompletion(messages: LLMMessage[], model: string, options: CompletionOptions = {}) {
  const { response } = await request({
    model,
    messages,
    stream: true,
    max_tokens: options.maxTokens ?? 1800,
    temperature: options.temperature ?? 0.95,
    ...commonFields(options),
  },options.signal,model);
  if (!response.body) throw new ProviderError("empty_response", { provider: "openrouter", model, detail: "response carried no stream" });
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
    throw new ProviderError(classifyProviderFailure(response.status, detail), { provider: "openrouter", model, status: response.status, detail });
  }
  const data = await response.json() as Record<string,unknown> & { data?: Array<{ embedding?: unknown }> };
  const embeddings = (data.data ?? []).map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item) && item.every((value) => typeof value === "number"));
  if (!embeddings.length) throw new ProviderError("empty_response", { provider: "openrouter", model, detail: "no embeddings returned" });
  return { embeddings, usage: enrichedUsage(data,startedAt), model: typeof data.model === "string" ? data.model : model };
}
