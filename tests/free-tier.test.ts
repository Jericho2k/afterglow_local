import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema, query, setPoolForTesting } from "@/lib/db";
import {
  capsFor, freeTierConfig, freeTierStatus, releaseFreeReservation, reserveFreeGeneration,
  spendFreeReservation, sweepStaleReservations, utcDay,
} from "@/lib/free-tier";

/**
 * THE LEDGER BEHIND THE ONLY SENTENCE THE FREE TIER IS ALLOWED TO SAY.
 *
 * Afterglow's free generations come from one platform OpenRouter account, whose
 * free-model allowance is global — OpenRouter documents that extra accounts and
 * keys do not raise it — so the pool is shared and the honest product sentence
 * is "a limited shared pool each day, subject to provider capacity". A schema
 * that counted only per user would let the marketing page print "fifty free
 * messages each" and then refuse somebody at their eleventh.
 *
 * So these tests are about the four ways that promise could quietly become
 * false: the pool cap not binding, the per-user cap not binding, a failed
 * request eating somebody's day, and a settlement counting twice.
 */

const reader = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

function enableFreeTier(pool: number, perUser: number) {
  vi.stubEnv("ENABLE_FREE_TIER", "true");
  vi.stubEnv("FREE_SHARED_DAILY_POOL", String(pool));
  vi.stubEnv("FREE_USER_DAILY_CAP", String(perUser));
  // The age gate is a separate concern with its own test; off by default here
  // so it cannot silently explain a refusal these tests are attributing to a cap.
  vi.stubEnv("FREE_MIN_ACCOUNT_AGE_MINUTES", "0");
}

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
});

afterEach(() => { vi.unstubAllEnvs(); });

async function reserve(userId = reader, modelId = "ling-3.0-flash-free") {
  return reserveFreeGeneration({ userId, modelId, funding: "shared_free" });
}

describe("the shared pool", () => {
  it("is off unless a deployment turns it on", async () => {
    expect(freeTierConfig().enabled).toBe(false);
    // A free tier nobody configured is not a free tier, and answering
    // "disabled" rather than "exhausted" sends the reader to the right remedy.
    await expect(reserve()).resolves.toEqual({ ok: false, reason: "disabled" });
  });

  it("stops at the platform cap however many readers are asking", async () => {
    enableFreeTier(3, 10);
    expect(capsFor(freeTierConfig(), "shared_free")).toEqual({ pool: 3, user: 10 });
    await expect(reserve(reader)).resolves.toMatchObject({ ok: true });
    await expect(reserve(other)).resolves.toMatchObject({ ok: true });
    await expect(reserve(reader)).resolves.toMatchObject({ ok: true });
    /*
     * THE FOURTH ONE IS THE POINT. The per-user cap is nowhere near reached and
     * the answer is still no, because what ran out belongs to the platform. If
     * this ever passes, the product is free to promise a per-user allowance the
     * upstream quota cannot honour.
     */
    await expect(reserve(other)).resolves.toEqual({ ok: false, reason: "pool_exhausted" });
  });

  it("stops one reader consuming the pool before anybody else wakes up", async () => {
    enableFreeTier(50, 2);
    await reserve(reader);
    await reserve(reader);
    await expect(reserve(reader)).resolves.toEqual({ ok: false, reason: "user_cap_reached" });
    // Plenty of pool left, and somebody else can still have it. That is the
    // whole reason the per-user cap exists.
    await expect(reserve(other)).resolves.toMatchObject({ ok: true });
  });

  it("hands the platform slot back when the reader's own cap is what refused", async () => {
    enableFreeTier(2, 1);
    await reserve(reader);
    await expect(reserve(reader)).resolves.toEqual({ ok: false, reason: "user_cap_reached" });
    /*
     * A refusal must not consume capacity. The pool check runs first and
     * succeeds, so without an explicit release the platform would lose a slot
     * every time a reader hit their own cap — and a busy day would exhaust the
     * pool with generations nobody ever received.
     */
    const rows = await query<{ reserved: number; released: number }>(
      "SELECT reserved,released FROM free_tier_pool_days WHERE utc_day=$1 AND funding='shared_free'", [utcDay()]);
    expect(Number(rows.rows[0].reserved) - Number(rows.rows[0].released)).toBe(1);
    await expect(reserve(other)).resolves.toMatchObject({ ok: true });
  });

  it("keeps a fresh account out of the pool for a short while", async () => {
    enableFreeTier(10, 10);
    vi.stubEnv("FREE_MIN_ACCOUNT_AGE_MINUTES", "30");
    const justNow = new Date();
    await expect(reserveFreeGeneration({
      userId: reader, modelId: "ling-3.0-flash-free", funding: "shared_free",
      accountCreatedAt: justNow, now: justNow,
    })).resolves.toEqual({ ok: false, reason: "account_too_new" });
    // Minutes rather than days: the point is to make scripted signups
    // unrewarding, not to make a real reader wait for anything they would notice.
    await expect(reserveFreeGeneration({
      userId: reader, modelId: "ling-3.0-flash-free", funding: "shared_free",
      accountCreatedAt: new Date(justNow.getTime() - 45 * 60_000), now: justNow,
    })).resolves.toMatchObject({ ok: true });
  });
});

describe("settlement", () => {
  it("gives the slot back when nothing ran", async () => {
    enableFreeTier(1, 1);
    const taken = await reserve();
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    // The pool is exactly one deep, so a release either works or the next
    // reader is refused — there is nowhere for a bug to hide.
    await expect(reserve(other)).resolves.toEqual({ ok: false, reason: "pool_exhausted" });
    await releaseFreeReservation(taken.reservation);
    await expect(reserve(other)).resolves.toMatchObject({ ok: true });
  });

  it("does not give the slot back when a generation actually happened", async () => {
    enableFreeTier(1, 1);
    const taken = await reserve();
    if (!taken.ok) throw new Error("expected a reservation");
    await spendFreeReservation(taken.reservation);
    /*
     * OpenRouter counted this against the platform allowance the moment the
     * request left. Crediting it back here would make Afterglow believe it has
     * capacity that upstream will refuse, which is how a free tier starts
     * promising generations that arrive as 429s.
     */
    await expect(reserve(other)).resolves.toEqual({ ok: false, reason: "pool_exhausted" });
  });

  it("counts once however many times it is settled", async () => {
    enableFreeTier(5, 5);
    const taken = await reserve();
    if (!taken.ok) throw new Error("expected a reservation");
    await spendFreeReservation(taken.reservation);
    // A retry, a duplicated callback, a maintenance sweep arriving late: all
    // three reach here, and the first settlement is the only one that moves a
    // counter.
    await expect(spendFreeReservation(taken.reservation)).resolves.toBe(false);
    await expect(releaseFreeReservation(taken.reservation)).resolves.toBe(false);
    const rows = await query<{ spent: number; released: number }>(
      "SELECT spent,released FROM free_tier_pool_days WHERE utc_day=$1 AND funding='shared_free'", [utcDay()]);
    expect(Number(rows.rows[0].spent)).toBe(1);
    expect(Number(rows.rows[0].released)).toBe(0);
  });

  it("releases reservations abandoned by a process that died mid-request", async () => {
    enableFreeTier(2, 2);
    const taken = await reserve();
    if (!taken.ok) throw new Error("expected a reservation");
    // Nothing settled it, so without the sweep it holds capacity forever and
    // the pool reads as full while nothing is running.
    await expect(sweepStaleReservations({ before: new Date(Date.now() + 60_000) })).resolves.toEqual({ examined: 1, released: 1 });
    const rows = await query<{ reserved: number; released: number }>(
      "SELECT reserved,released FROM free_tier_pool_days WHERE utc_day=$1 AND funding='shared_free'", [utcDay()]);
    expect(Number(rows.rows[0].reserved) - Number(rows.rows[0].released)).toBe(0);
    // A generous threshold leaves a long generation alone, because a long
    // generation is not an abandoned one.
    await expect(sweepStaleReservations({ olderThanMs: 15 * 60_000 })).resolves.toEqual({ examined: 0, released: 0 });
  });
});

describe("the day boundary", () => {
  it("is UTC, matching the quota it divides", async () => {
    // A local-midnight reset would hand readers in one timezone a second
    // allowance out of a day the platform had already spent.
    expect(utcDay(new Date("2026-08-31T23:59:59.000Z"))).toBe("2026-08-31");
    expect(utcDay(new Date("2026-09-01T00:00:01.000Z"))).toBe("2026-09-01");
  });

  it("starts the pool over on the next UTC day", async () => {
    enableFreeTier(1, 1);
    const today = new Date("2026-08-31T12:00:00.000Z");
    const tomorrow = new Date("2026-09-01T00:30:00.000Z");
    await reserveFreeGeneration({ userId: reader, modelId: "ling-3.0-flash-free", funding: "shared_free", now: today });
    await expect(reserveFreeGeneration({ userId: reader, modelId: "ling-3.0-flash-free", funding: "shared_free", now: today }))
      .resolves.toEqual({ ok: false, reason: "pool_exhausted" });
    await expect(reserveFreeGeneration({ userId: reader, modelId: "ling-3.0-flash-free", funding: "shared_free", now: tomorrow }))
      .resolves.toMatchObject({ ok: true });
  });
});

describe("what the reader is told", () => {
  it("reports their own remaining count and never the platform's", async () => {
    enableFreeTier(9, 3);
    await reserve();
    const status = await freeTierStatus(reader);
    expect(status).toMatchObject({ enabled: true, userCap: 3, userRemaining: 2, sharedCapacityAvailable: true });
    /*
     * THE GLOBAL REMAINING COUNT IS DELIBERATELY ABSENT.
     *
     * It is a fact about Afterglow's OpenRouter account rather than about the
     * reader, it invites refreshing until a number goes up, and product review
     * has not decided it is useful. Both sentences the UI needs — "free
     * generations available today" and "today's shared free capacity has been
     * used" — are answerable from a boolean.
     */
    expect(Object.keys(status)).not.toContain("sharedRemaining");
    expect(status.resetsAt.endsWith("T00:00:00.000Z")).toBe(true);
  });

  it("says the shared capacity is gone once it is", async () => {
    enableFreeTier(1, 5);
    await reserve(other);
    const status = await freeTierStatus(reader);
    // The reader still has their own allowance and still cannot use it. Saying
    // "you have used yours" here would send them to entirely the wrong remedy.
    expect(status.userRemaining).toBe(5);
    expect(status.sharedCapacityAvailable).toBe(false);
  });

  it("offers no funded fallback until a deployment has configured and paid for one", async () => {
    enableFreeTier(5, 5);
    await expect(freeTierStatus(reader)).resolves.toMatchObject({ fundedFallbackAvailable: false });
    // A decision to spend money is never a default.
    vi.stubEnv("FREE_FUNDED_FALLBACK_MODEL", "ling-3.0-flash");
    await expect(freeTierStatus(reader)).resolves.toMatchObject({ fundedFallbackAvailable: false });
    vi.stubEnv("FREE_FUNDED_DAILY_POOL", "20");
    vi.stubEnv("FREE_FUNDED_USER_DAILY_CAP", "5");
    await expect(freeTierStatus(reader)).resolves.toMatchObject({ fundedFallbackAvailable: true });
  });
});
