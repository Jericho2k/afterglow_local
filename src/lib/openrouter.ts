import type { LLMMessage, LLMUsage, ProviderAuthentication, ProviderCompletionOptions } from "./llm";
import { ProviderError, classifyProviderFailure, providerSpecificRejection } from "./provider-errors";
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

/**
 * HOW LONG ONE UPSTREAM MAY TAKE TO SAY ANYTHING AT ALL.
 *
 * There was no bound here. `fetch` was given only the caller's own abort signal
 * — the browser hanging up — so an upstream that accepted the connection and
 * then went quiet held the request until the platform's 120-second ceiling
 * killed the whole function. That is the reported "close to a minute": not the
 * model thinking slowly, one dead host holding a chat hostage while several
 * other hosts served the same model.
 *
 * The bound is deliberately on the HEADERS phase only. Once the upstream has
 * responded, the stream is left alone however long the model takes to write —
 * cutting off a reply in progress would be a far worse failure than waiting for
 * it, and a long reply is not a fault. What is bounded is silence before the
 * first byte.
 *
 * Twenty seconds is chosen to be clearly outside normal behaviour rather than
 * tight: a healthy provider returns headers in well under a second, and a slow
 * one under a few. Anything past twenty is not slow, it is not coming — and the
 * retry that follows asks OpenRouter for a DIFFERENT host serving the SAME
 * model, so reliability is not being traded away. It is being recovered sooner.
 */
export function providerHeadersTimeoutMs() {
  const configured = Number(process.env.PROVIDER_HEADERS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 20_000;
}

/** Bounded by construction: three attempts, ~1.25s of added delay at worst. */
export const maxAttempts = attemptDelays.length;

/** The `provider` block for one attempt, or undefined for OpenRouter's default. */
function providerBlock(modelId: string | undefined, attempt: number, failed: string[]) {
  const policy = modelId
    ? providerPolicyFor(modelId, attempt, failed, { finalAttempt: attempt >= attemptDelays.length - 1 })
    : null;
  if (policy) {
    return {
      ...(policy.order ? { order: policy.order } : {}),
      ...(policy.only ? { only: policy.only } : {}),
      ...(policy.ignore ? { ignore: policy.ignore } : {}),
      allow_fallbacks: policy.allowFallbacks,
      ...(policy.sort ? { sort: policy.sort } : {}),
      /*
       * `max_price` is per MILLION tokens and is OpenRouter's own filter, so a
       * host above the ceiling is never selected in the first place. Doing it
       * here rather than by listing hosts means the guard keeps working when a
       * provider re-prices, and cannot be defeated by a renamed slug.
       */
      ...(policy.maxPrice ? { max_price: { prompt: policy.maxPrice.prompt, completion: policy.maxPrice.completion } } : {}),
      /*
       * The privacy floor, enforced where the endpoint catalogue lives.
       *
       * `data_collection: "deny"` excludes endpoints that store prompts
       * non-transiently to train on them; `zdr` narrows further to endpoints
       * that do not retain the prompt at rest at all. They are separate
       * guarantees and a provider can offer one without the other, so both are
       * sent when a model asks for both. Doing this here rather than by
       * comparing provider names in Afterglow means the filter keeps working
       * when a provider changes its policy.
       */
      ...(policy.dataCollection ? { data_collection: policy.dataCollection } : {}),
      ...(policy.zdr ? { zdr: true } : {}),
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

    /*
     * One controller per attempt, so a deadline on the HEADERS does not later
     * cut off a stream that is flowing.
     *
     * The caller's signal is chained into it, which is what keeps a browser
     * hang-up working for the body as well; the timer is cleared the moment
     * headers arrive, so only the connect-and-respond phase is bounded.
     */
    const attemptControl = new AbortController();
    const relayAbort = () => attemptControl.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; attemptControl.abort(); }, providerHeadersTimeoutMs());

    let response: Response;
    try {
      response = await fetch(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers: headers(options.authentication),
        body: JSON.stringify(payload),
        signal: attemptControl.signal,
      });
      clearTimeout(deadline);
    } catch (error) {
      clearTimeout(deadline);
      // The caller hanging up is final; a host going quiet is not.
      if (signal?.aborted) throw new ProviderError("timeout", { provider: "openrouter", model: diagnosticModel, attempt: attempt + 1 });
      if (timedOut) {
        /*
         * Treated as a refusal, so recovery routes away from the silence.
         *
         * No headers came back, so the host that went quiet cannot be named
         * from the response. The endpoint this attempt asked for FIRST is the
         * best evidence available, and excluding it is safe either way: if the
         * guess is right the next attempt avoids the dead host, and if it is
         * wrong the attempt still reaches the same model somewhere else.
         * Attempt 1 onwards also sorts by live throughput, which routes away
         * from a slow host without needing to name it.
         */
        const quiet = provider?.order?.[0];
        if (quiet && !failed.includes(quiet)) failed.push(quiet);
        lastError = new ProviderError("timeout", {
          provider: "openrouter", model: diagnosticModel, attempt: attempt + 1,
          latencyMs: Date.now() - startedAt,
          detail: `no response headers within ${providerHeadersTimeoutMs()}ms`,
        });
        continue;
      }
      // A transport failure is indistinguishable from a dead host, and is
      // treated as one: same model, another provider, bounded attempts.
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
    /*
     * A rejection ONE HOST made about ITS OWN capabilities is not a fact about
     * the request, so it does not end the attempt loop — the same model is
     * asked for somewhere else. See `providerSpecificRejection`, which is
     * deliberately narrow: it fires only for a 400/422/404 that was RELAYED
     * from an upstream and reads as a parameter or capability complaint. A
     * malformed request Afterglow built still fails immediately.
     */
    if (!lastError.retryable && !providerSpecificRejection(response.status, detail)) break;
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
    /*
     * Three states, not two. See `CompletionOptions.thinking`: omitting
     * `reasoning` takes the endpoint's own default, which on a hybrid reasoning
     * model means reasoning, and is therefore not a way to decline it.
     */
    ...(options.thinking === true ? { reasoning: { enabled: true } } : {}),
    ...(options.thinking === "off" ? { reasoning: { enabled: false } } : {}),
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
