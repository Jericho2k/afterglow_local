type Entry = { count: number; resetAt: number };
const globalRateLimits = globalThis as unknown as { afterglowLimits?: Map<string, Entry> };
const limits = globalRateLimits.afterglowLimits ??= new Map<string, Entry>();

export function clientIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "local";
}

export function checkRateLimit(key: string, maximum: number, windowMs: number) {
  const now = Date.now();
  const current = limits.get(key);
  if (!current || current.resetAt <= now) {
    limits.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  current.count += 1;
  if (current.count <= maximum) return null;
  const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  return Response.json({ error: "Too many requests. Please wait a moment." }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}
