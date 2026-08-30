import type { LLMMessage, LLMUsage, ProviderAuthentication, ProviderCompletionOptions } from "./llm";
import { ProviderError, classifyProviderFailure } from "./provider-errors";
import { providerPolicyFor } from "./provider";

const baseUrl = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

function apiKey(authentication?: ProviderAuthentication) {
  // A BYOK branch never consults the environment. An empty/corrupt request
  // credential fails as that user's request; it cannot become platform spend.
  if (authentication?.type === "openrouter_byok") {
    const requestKey = authentication.credential.trim();
    if (!requestKey) throw new ProviderError("auth", { provider: "openrouter", detail: "request credential was empty" });
    return requestKey;
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new ProviderError("auth", { provider: "openrouter", detail: "OPENROUTER_API_KEY is not configured" });
  return key;
}

function headers(authentication?: ProviderAuthentication) {
  const result: Record<string,string> = {
    Authorization: `Bearer ${apiKey(authentication)}`,
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
 * only how OpenRouter is allowed to reach it: attempt one takes the warm path —
 * the model's preferred endpoint first, fallbacks permitted, no re-sorting, so
 * a session that is already sticky stays where its cache is — and later
 * attempts explicitly exclude the endpoint that just failed and sort the rest
 * by live throughput.
 *
 * Excluding the failed host by name is the part that was missing. Retrying with
 * `sort: throughput` and nothing else could route straight back to the provider
 * that had just returned a 503, which spends an attempt to learn what the
 * previous attempt already established.
 *
 * Nothing in this file may substitute one model for another. Skyfall failing is
 * never a reason to answer as Kimi — model fallback is a product decision with
 * its own semantics, and silently making it here would mean a reader's chosen
 * writer changed without anybody saying so.
 */
const attemptDelays = [0, 350, 900] as const;

/** Bounded by construction: three attempts, ~1.25s of added delay at worst. */
export const maxAttempts = attemptDelays.length;

/** The `provider` block for one attempt, or undefined for OpenRouter's default. */
function providerBlock(modelId: string | undefined, attempt: number, failed: string[]) {
  const policy = modelId ? providerPolicyFor(modelId, attempt, failed) : null;
  if (policy) {
    return {
      ...(policy.order ? { order: policy.order } : {}),
      ...(policy.only ? { only: policy.only } : {}),
      ...(policy.ignore ? { ignore: policy.ignore } : {}),
      allow_fallbacks: policy.allowFallbacks,
      ...(policy.sort ? { sort: policy.sort } : {}),
    };
  }
  // No catalogue policy: keep the previous behaviour exactly — untouched on the
  // first attempt, throughput-sorted with fallbacks on the later ones.
  if (attempt === 0 && !failed.length) return undefined;
  return { ...(failed.length ? { ignore: failed } : {}), allow_fallbacks: true, sort: "throughput" as const };
}

function wait(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new ProviderError("timeout", { provider: "openrouter", detail: "aborted while backing off" })); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function request(body: Record<string,unknown>, options: ProviderCompletionOptions = {}, diagnosticModel?: string) {
  const signal = options.signal;
  let lastError: ProviderError | null = null;
  // Hosts this request has already been refused by. Grows as attempts fail, so
  // the next attempt asks OpenRouter for anywhere else that serves this model.
  const failed = [...(options.excludeProviders ?? [])];

  for (let attempt = 0; attempt < attemptDelays.length; attempt += 1) {
    if (attemptDelays[attempt]) await wait(attemptDelays[attempt], signal);
    const startedAt = Date.now();
    const provider = providerBlock(options.modelId, attempt, failed);
    const payload = provider ? { ...body, provider } : body;

    let response: Response;
    try {
      response = await fetch(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers: headers(options.authentication),
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
    const upstreamProvider = response.headers.get("x-openrouter-provider") ?? undefined;
    // Same model, somewhere else. A host that has just refused this request is
    // not asked again on the next attempt.
    if (upstreamProvider && !failed.includes(upstreamProvider)) failed.push(upstreamProvider);
    lastError = new ProviderError(classifyProviderFailure(response.status, detail), {
      provider: "openrouter",
      model: diagnosticModel,
      status: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined,
      upstreamProvider,
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
function commonFields(options: ProviderCompletionOptions) {
  return {
    usage: { include: true },
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    ...(options.thinking ? { reasoning: { enabled: true } } : {}),
  };
}

export async function completionWithUsage(messages: LLMMessage[], model: string, options: ProviderCompletionOptions = {}) {
  const { response, startedAt } = await request({
    model,
    messages,
    max_tokens: options.maxTokens ?? 1000,
    temperature: options.temperature ?? 0.85,
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
    ...commonFields(options),
  },options,model);
  const data = await response.json() as Record<string,unknown> & { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new ProviderError("empty_response", { provider: "openrouter", model, requestId: typeof data.id === "string" ? data.id : undefined });
  }
  return { content, usage: enrichedUsage(data,startedAt) };
}

export async function streamCompletion(messages: LLMMessage[], model: string, options: ProviderCompletionOptions = {}) {
  const { response } = await request({
    model,
    messages,
    stream: true,
    max_tokens: options.maxTokens ?? 1800,
    temperature: options.temperature ?? 0.95,
    ...commonFields(options),
  },options,model);
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
