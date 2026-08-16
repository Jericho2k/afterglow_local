import { describe, expect, it } from "vitest";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

describe("rate limiting", () => {
  it("allows requests up to the limit then returns 429", () => {
    const key = `test:${crypto.randomUUID()}`;
    expect(checkRateLimit(key, 2, 60_000)).toBeNull();
    expect(checkRateLimit(key, 2, 60_000)).toBeNull();
    expect(checkRateLimit(key, 2, 60_000)?.status).toBe(429);
  });

  it("uses the first forwarded client address", () => {
    const request = new Request("https://example.test", { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } });
    expect(clientIp(request)).toBe("203.0.113.5");
  });
});
