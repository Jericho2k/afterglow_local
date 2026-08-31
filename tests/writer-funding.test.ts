import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema, query, setPoolForTesting } from "@/lib/db";
import { acceptFundedFallback, fundedFallbackMode, planWriterFunding, settleWriterFunding } from "@/lib/writer-funding";
import { fundedWriterAllowed, guardSummary, spendGuardConfig } from "@/lib/spend-guards";
import { freeTierStatus } from "@/lib/free-tier";

/**
 * WHO PAYS, AND THE FOUR WAYS THAT COULD GO QUIETLY WRONG.
 *
 * Free-tier failover becoming uncapped paid spend is the failure this whole
 * sprint exists to prevent, and it has four separate entrances. Afterglow could
 * charge its own shared pool for a reader who brought their own key. It could
 * let a reader over their personal cap reach the funded budget instead. It
 * could swap somebody's writer for a paid one without saying so. Or it could
 * fund a model whose price has no ceiling at all.
 *
 * Each of those is a test below, and each is written so that the assertion
 * fails loudly rather than costing money silently.
 */

const reader = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const freeRoute = { providerId: "openrouter", modelId: "ling-3.0-flash-free" };

function enableFreeTier(pool = 5, perUser = 5) {
  vi.stubEnv("ENABLE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
  vi.stubEnv("ENABLE_FREE_TIER", "true");
  vi.stubEnv("FREE_SHARED_DAILY_POOL", String(pool));
  vi.stubEnv("FREE_USER_DAILY_CAP", String(perUser));
  vi.stubEnv("FREE_MIN_ACCOUNT_AGE_MINUTES", "0");
}

function enableFundedFallback() {
  vi.stubEnv("FREE_FUNDED_FALLBACK_MODEL", "ling-3.0-flash");
  vi.stubEnv("FREE_FUNDED_DAILY_POOL", "10");
  vi.stubEnv("FREE_FUNDED_USER_DAILY_CAP", "3");
  vi.stubEnv("PLATFORM_FUNDED_MODELS", "ling-3.0-flash");
  vi.stubEnv("PLATFORM_WRITER_DAILY_BUDGET_USD", "5");
}

/** A reader with their own OpenRouter key, and the preference switched on. */
async function connectByok(userId: string) {
  vi.stubEnv("ENABLE_BYOK", "true");
  await query("INSERT INTO user_settings (user_id,writer_funding) VALUES ($1,'byok')", [userId]);
  await query(
    `INSERT INTO user_provider_credentials (user_id,provider,ciphertext,nonce,auth_tag,key_version,key_suffix,validated_at)
     VALUES ($1,'openrouter',$2,$3,$4,1,'abcd',now())`,
    [userId, Buffer.from("x"), Buffer.from("y"), Buffer.from("z")],
  );
}

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("a reader who brought their own key", () => {
  it("spends their own free quota, not Afterglow's shared pool", async () => {
    enableFreeTier(1, 1);
    await connectByok(reader);
    const plan = await planWriterFunding({ userId: reader, selection: freeRoute });
    expect(plan.kind).toBe("byok");
    /*
     * SECTION M, AS AN INVARIANT. A `:free` route on somebody else's key draws
     * on THEIR OpenRouter allowance. Charging Afterglow's pool for it would
     * exhaust a shared resource for everybody else and report a cost that
     * nobody paid — and the pool here is exactly one deep, so a bug shows up as
     * the next reader being refused.
     */
    await expect(freeTierStatus(reader)).resolves.toMatchObject({ sharedCapacityAvailable: true, userRemaining: 1 });
    const plan2 = await planWriterFunding({ userId: other, selection: freeRoute });
    expect(plan2.kind).toBe("shared_free");
  });
});

describe("the shared pool", () => {
  it("reserves a slot for a free route and settles it when the reply lands", async () => {
    enableFreeTier(2, 2);
    const plan = await planWriterFunding({ userId: reader, selection: freeRoute });
    expect(plan.kind).toBe("shared_free");
    if (plan.kind !== "shared_free") return;
    expect(plan.substituted).toBe(false);
    await settleWriterFunding(plan, true);
    await expect(freeTierStatus(reader)).resolves.toMatchObject({ userRemaining: 1 });
  });

  it("gives the slot back when nothing ran", async () => {
    enableFreeTier(1, 1);
    const plan = await planWriterFunding({ userId: reader, selection: freeRoute });
    await settleWriterFunding(plan, false);
    // A refused context, a dead upstream, a reader who hung up: none of those
    // is a generation, and none of them should cost anybody their day.
    await expect(planWriterFunding({ userId: other, selection: freeRoute })).resolves.toMatchObject({ kind: "shared_free" });
  });

  it("leaves paid models exactly as they were", async () => {
    enableFreeTier();
    const plan = await planWriterFunding({ userId: reader, selection: { providerId: "openrouter", modelId: "glm-4.7" } });
    // The free tier is additive. A paid writer is funded the way it always was,
    // takes no reservation, and needs no settlement.
    expect(plan).toEqual({ kind: "afterglow", selection: { providerId: "openrouter", modelId: "glm-4.7" } });
    await expect(settleWriterFunding(plan, true)).resolves.toBeUndefined();
  });
});

describe("what happens when the free capacity is gone", () => {
  it("names the funded writer rather than switching to it", async () => {
    enableFreeTier(1, 5);
    enableFundedFallback();
    expect(fundedFallbackMode()).toBe("ask");
    await planWriterFunding({ userId: other, selection: freeRoute });

    const refused = await planWriterFunding({ userId: reader, selection: freeRoute });
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    /*
     * THE DEFAULT IS A QUESTION, NOT A SUBSTITUTION.
     *
     * A reader's writer is part of their story. Changing it because a shared
     * pool ran dry is a decision they should get to make, and the remedies are
     * ordered the way somebody mid-scene would want them: the thing that gets
     * them writing again first, then the ways to stop this happening tomorrow.
     */
    expect(refused.reason).toBe("pool_exhausted");
    expect(refused.fundedModelId).toBe("ling-3.0-flash");
    expect(refused.remedies).toEqual(["use_funded_model", "wait_for_reset", "connect_byok", "choose_paid_model"]);
    expect(refused.message).toContain("shared free capacity");
    // And asking must not itself consume the funded budget, or a crawler could
    // drain it by asking questions it never answers.
    await expect(freeTierStatus(reader)).resolves.toMatchObject({ fundedFallbackAvailable: true });
  });

  it("takes the funded slot only once the reader has said yes", async () => {
    enableFreeTier(1, 5);
    enableFundedFallback();
    await planWriterFunding({ userId: other, selection: freeRoute });
    const accepted = await acceptFundedFallback({ userId: reader, modelId: "ling-3.0-flash" });
    expect(accepted.kind).toBe("platform_funded");
    if (accepted.kind !== "platform_funded") return;
    // The writer changed, and the plan says so — in the response and, through
    // `funding_source`, in the ledger.
    expect(accepted.substituted).toBe(true);
    expect(accepted.selection).toEqual({ providerId: "openrouter", modelId: "ling-3.0-flash" });
  });

  it("refuses to fund a model the deployment never nominated", async () => {
    enableFreeTier(1, 5);
    enableFundedFallback();
    // "Cheapest available" is precisely how a free tier ends up on a premium
    // writer at three in the morning, so the funded route is named, not derived.
    await expect(acceptFundedFallback({ userId: reader, modelId: "glm-4.7" }))
      .resolves.toMatchObject({ kind: "refused", reason: "route_not_allowed" });
  });

  it("switches by itself only where a deployment has asked it to", async () => {
    enableFreeTier(1, 5);
    enableFundedFallback();
    vi.stubEnv("FREE_FUNDED_FALLBACK_MODE", "auto");
    expect(fundedFallbackMode()).toBe("auto");
    await planWriterFunding({ userId: other, selection: freeRoute });
    const plan = await planWriterFunding({ userId: reader, selection: freeRoute });
    expect(plan).toMatchObject({ kind: "platform_funded", substituted: true });
  });

  it("does not hand the funded budget to a reader who spent their own allowance", async () => {
    enableFreeTier(50, 1);
    enableFundedFallback();
    await planWriterFunding({ userId: reader, selection: freeRoute });
    const refused = await planWriterFunding({ userId: reader, selection: freeRoute });
    /*
     * The funded fallback exists to survive the PLATFORM running out. Using it
     * for somebody who has spent their own daily allowance would turn the
     * per-user cap into a suggestion and hand the heaviest reader the funded
     * budget as well, which is exactly backwards.
     */
    expect(refused).toMatchObject({ kind: "refused", reason: "user_cap_reached" });
    if (refused.kind !== "refused") return;
    expect(refused.remedies).not.toContain("use_funded_model");
  });

  it("refuses honestly when the pool is gone and no funded writer is configured", async () => {
    enableFreeTier(1, 5);
    await planWriterFunding({ userId: other, selection: freeRoute });
    const refused = await planWriterFunding({ userId: reader, selection: freeRoute });
    expect(refused).toMatchObject({ kind: "refused", reason: "pool_exhausted" });
    if (refused.kind !== "refused") return;
    // No funded writer offered, because a decision to spend money is never a
    // default and this deployment has not made one.
    expect(refused.fundedModelId).toBeUndefined();
  });
});

describe("the spend guards", () => {
  it("fund nothing at all until a deployment names what may be funded", async () => {
    expect(spendGuardConfig().fundedModelAllowlist).toEqual([]);
    await expect(fundedWriterAllowed({ userId: reader, modelId: "glm-4.7" }))
      .resolves.toEqual({ allowed: false, reason: "route_not_allowed" });
  });

  it("refuse to fund a model whose price has no ceiling", async () => {
    /*
     * A model with no `costCeiling` can be served by whichever endpoint
     * OpenRouter picks, at whatever it charges. That is an acceptable risk for
     * a writer somebody chose deliberately; it is not an acceptable risk for a
     * writer Afterglow reached for automatically because something else was
     * unavailable.
     */
    vi.stubEnv("PLATFORM_FUNDED_MODELS", "midnight-cherry");
    await expect(fundedWriterAllowed({ userId: reader, modelId: "midnight-cherry" }))
      .resolves.toEqual({ allowed: false, reason: "unbounded_price" });
  });

  it("stop at the daily budget, and at one account's share of it", async () => {
    vi.stubEnv("PLATFORM_FUNDED_MODELS", "ling-3.0-flash");
    vi.stubEnv("PLATFORM_WRITER_DAILY_BUDGET_USD", "1");
    vi.stubEnv("PLATFORM_WRITER_USER_DAILY_BUDGET_USD", "0.10");
    await expect(fundedWriterAllowed({ userId: reader, modelId: "ling-3.0-flash" })).resolves.toEqual({ allowed: true });

    let ledgerRow = 0;
    const spend = async (userId: string, usd: number) => {
      ledgerRow += 1;
      return query(
        `INSERT INTO usage_events (id,user_id,model,funding_source,usage_type,task_route,provider_cost_usd,created_at)
         VALUES ($3,$1,'ling-3.0-flash','platform_funded','chat','rp_generation',$2,now())`,
        [userId, usd, `33333333-3333-4333-8333-00000000000${ledgerRow}`],
      );
    };

    await spend(reader, 0.2);
    // One account past its share, with plenty of platform budget left.
    await expect(fundedWriterAllowed({ userId: reader, modelId: "ling-3.0-flash" }))
      .resolves.toEqual({ allowed: false, reason: "user_budget_reached" });
    await expect(fundedWriterAllowed({ userId: other, modelId: "ling-3.0-flash" })).resolves.toEqual({ allowed: true });

    await spend(other, 0.9);
    // And now the backstop, which holds regardless of who spent it.
    await expect(fundedWriterAllowed({ userId: other, modelId: "ling-3.0-flash" }))
      .resolves.toEqual({ allowed: false, reason: "daily_budget_reached" });
  });

  it("never charge a dollar budget for a route that costs nothing", async () => {
    vi.stubEnv("PLATFORM_WRITER_DAILY_BUDGET_USD", "0");
    // Sending free routes through the money guard would mean an unset budget
    // disabled the free tier, which is precisely backwards. What bounds a free
    // route is the shared pool.
    await expect(fundedWriterAllowed({ userId: reader, modelId: "ling-3.0-flash-free" })).resolves.toEqual({ allowed: true });
  });

  it("report back what is guarding a model, so an operator can read it", () => {
    vi.stubEnv("ENABLE_OPENROUTER", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
    // A guard nobody can inspect is a guard nobody can trust.
    expect(guardSummary("glm-4.7")).toEqual({
      modelId: "glm-4.7",
      free: false,
      approvedProviders: ["deepinfra", "novita", "z-ai"],
      maxPrice: { prompt: 0.65, completion: 2.25 },
      enforcedPool: ["deepinfra", "novita", "z-ai"],
      dataPolicy: { dataCollection: "deny" },
      fundable: false,
    });
  });
});
