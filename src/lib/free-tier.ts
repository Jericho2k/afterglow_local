import { randomUUID } from "node:crypto";
import { query, transaction } from "./db";
import type { PoolClient } from "pg";

/**
 * THE FREE TIER, AND THE ONE SENTENCE IT IS ALLOWED TO SAY.
 *
 * Afterglow's free generations come from ONE platform OpenRouter account's
 * legitimate free-model quota. That quota is not per user and cannot be made
 * per user: OpenRouter's own documentation states that making additional
 * accounts or API keys does not affect rate limits, because capacity is
 * governed globally — and creating accounts to get around a limit is exactly
 * the thing this file must never be built to do. One account, one pool.
 *
 * So the honest product sentence is "a limited shared pool of free generations
 * each day, subject to provider capacity", and the dishonest one — the one a
 * per-user-only counter would let the marketing page print — is "fifty free
 * messages a day". A reader who is told the second and then refused at the
 * eleventh message has been lied to by the schema.
 *
 * TWO LEDGERS, BOTH BINDING. A generation has to fit inside the platform's day
 * AND inside the reader's own day. The platform cap is what actually exists;
 * the per-user cap is what stops one enthusiastic reader consuming the whole
 * pool before anybody else wakes up.
 *
 * TWO FUNDING SOURCES, COUNTED APART. `shared_free` is the free-model quota.
 * `platform_funded` is Afterglow paying real money for an ultra-cheap paid
 * writer once the free quota is gone — a deliberate product decision with its
 * own, separate, much smaller cap, because the one failure this whole design
 * exists to prevent is free-tier failover quietly becoming uncapped spend.
 *
 * RESERVE, THEN SETTLE. The count moves before the request leaves and is
 * settled after it lands, so two readers arriving in the same millisecond
 * cannot both take the last slot and a request that dies before inference does
 * not consume anybody's day.
 *
 * WHAT A REFUND IS NOT. OpenRouter counts a failed free-model attempt against
 * the platform's allowance. Releasing a reservation gives the READER their
 * allowance back; it cannot give the platform its upstream request back. This
 * file is Afterglow's ledger and says so; OpenRouter's 429 remains the
 * authority on whether real capacity is left.
 */

export type FreeFunding = "shared_free" | "platform_funded";

/** Why a free generation was refused. Each maps to a different reader answer. */
export type FreeTierRefusal =
  /** The deployment does not offer a free tier at all. */
  | "disabled"
  /** Today's shared free capacity is gone. Resets at UTC midnight. */
  | "pool_exhausted"
  /** This reader has used their own allowance for today. */
  | "user_cap_reached"
  /** The account is too new to draw on a shared pool. Anti-farming. */
  | "account_too_new";

export type FreeReservation = {
  id: string;
  userId: string;
  utcDay: string;
  funding: FreeFunding;
  modelId: string;
};

export type FreeReservationResult =
  | { ok: true; reservation: FreeReservation }
  | { ok: false; reason: FreeTierRefusal };

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * The free tier's dials, all of them configurable and none of them a product
 * promise baked into code.
 *
 * The defaults below are deliberately CONSERVATIVE rather than aspirational.
 * OpenRouter's published free-model allowance for one account is on the order
 * of fifty requests a day, rising to about a thousand once the account has ever
 * bought ten dollars of credit, against a fixed twenty-requests-per-minute
 * ceiling. A default pool larger than the quota it draws on would turn every
 * refusal into an upstream 429 that Afterglow had already promised would not
 * happen — so the shipped default assumes the smaller allowance and an operator
 * raises it once they know which one their account has.
 *
 * The funded fallback defaults to OFF and to zero. Turning it on is a decision
 * to spend money, and a decision to spend money should never be a default.
 */
export type FreeTierConfig = {
  enabled: boolean;
  /** Generations the platform will serve from free endpoints, per UTC day. */
  sharedDailyPool: number;
  /** The most one reader may take from that pool, per UTC day. */
  userDailyCap: number;
  /** Generations Afterglow will PAY for once the free pool is gone, per day. */
  fundedDailyPool: number;
  /** The most one reader may take from the funded pool, per UTC day. */
  fundedUserDailyCap: number;
  /**
   * The catalogue model the funded fallback uses.
   *
   * Named explicitly rather than "whatever is cheapest", because "cheapest
   * available" is precisely how a free tier ends up on a premium writer at
   * three in the morning. An unset value means there is no funded fallback,
   * which is the default.
   */
  fundedModelId: string | null;
  /**
   * How old an account must be before it may draw on the shared pool.
   *
   * The whole anti-farming measure, and deliberately a small one: a shared pool
   * is worth farming, and a signup that can immediately spend from it is worth
   * automating. Minutes rather than days because the goal is to make scripted
   * account creation unrewarding, not to make a real reader wait.
   */
  minAccountAgeMinutes: number;
};

export function freeTierConfig(): FreeTierConfig {
  return {
    enabled: process.env.ENABLE_FREE_TIER === "true",
    sharedDailyPool: positiveInteger(process.env.FREE_SHARED_DAILY_POOL, 40),
    userDailyCap: positiveInteger(process.env.FREE_USER_DAILY_CAP, 10),
    fundedDailyPool: positiveInteger(process.env.FREE_FUNDED_DAILY_POOL, 0),
    fundedUserDailyCap: positiveInteger(process.env.FREE_FUNDED_USER_DAILY_CAP, 0),
    fundedModelId: process.env.FREE_FUNDED_FALLBACK_MODEL?.trim() || null,
    minAccountAgeMinutes: positiveInteger(process.env.FREE_MIN_ACCOUNT_AGE_MINUTES, 30),
  };
}

/** The caps that apply to one funding source. */
export function capsFor(config: FreeTierConfig, funding: FreeFunding) {
  return funding === "shared_free"
    ? { pool: config.sharedDailyPool, user: config.userDailyCap }
    : { pool: config.fundedDailyPool, user: config.fundedUserDailyCap };
}

/**
 * The day a generation belongs to, in UTC.
 *
 * UTC and not the reader's local midnight, because the pool being divided is
 * OpenRouter's and OpenRouter's day is UTC. A local reset would hand readers in
 * one timezone a second allowance out of a day the platform had already spent.
 */
export function utcDay(at: Date = new Date()) {
  return at.toISOString().slice(0, 10);
}

/**
 * Take a slot, atomically, or say which cap stopped it.
 *
 * THE ATOMICITY IS IN THE UPDATE, not in a read followed by a write. Both
 * statements are `UPDATE … WHERE <cap not yet reached> RETURNING`: PostgreSQL
 * locks the row, and a transaction that blocks on a concurrent update
 * re-evaluates its predicate against the committed version rather than against
 * the stale one it read. Zero rows back means the cap was reached — by this
 * request or by whoever won the race — and either way the answer is the same.
 *
 * The insert that precedes each update only guarantees the row exists;
 * `ON CONFLICT DO NOTHING` makes two requests creating the same day harmless.
 *
 * `reserved - released` is what a cap is compared against, so a released
 * reservation genuinely returns capacity rather than merely being recorded.
 */
export async function reserveFreeGeneration(input: {
  userId: string;
  modelId: string;
  funding: FreeFunding;
  accountCreatedAt?: string | Date | null;
  now?: Date;
}): Promise<FreeReservationResult> {
  const config = freeTierConfig();
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const now = input.now ?? new Date();
  const caps = capsFor(config, input.funding);
  if (caps.pool <= 0 || caps.user <= 0) return { ok: false, reason: "pool_exhausted" };

  if (config.minAccountAgeMinutes > 0 && input.accountCreatedAt) {
    const created = new Date(input.accountCreatedAt).getTime();
    if (Number.isFinite(created) && now.getTime() - created < config.minAccountAgeMinutes * 60_000) {
      return { ok: false, reason: "account_too_new" };
    }
  }

  const day = utcDay(now);
  return transaction(async (client) => {
    /*
     * THE PLATFORM'S CAP IS CHECKED FIRST, and that order is deliberate.
     *
     * If the shared pool is gone, no reader can proceed and the per-user answer
     * would be misleading — "you have used your allowance" is a different
     * sentence from "today's shared capacity has been used", and telling
     * somebody the first when the second is true sends them to the wrong
     * remedy.
     */
    const pool = await client.query(
      `INSERT INTO free_tier_pool_days (utc_day,funding) VALUES ($1,$2) ON CONFLICT (utc_day,funding) DO NOTHING`,
      [day, input.funding],
    ).then(() => client.query<{ reserved: number }>(
      `UPDATE free_tier_pool_days SET reserved=reserved+1,updated_at=now()
        WHERE utc_day=$1 AND funding=$2 AND reserved - released < $3
        RETURNING reserved`,
      [day, input.funding, caps.pool],
    ));
    if (!pool.rowCount) return { ok: false as const, reason: "pool_exhausted" as const };

    await client.query(
      `INSERT INTO free_tier_user_days (user_id,utc_day,funding) VALUES ($1,$2,$3)
        ON CONFLICT (user_id,utc_day,funding) DO NOTHING`,
      [input.userId, day, input.funding],
    );
    const user = await client.query<{ reserved: number }>(
      `UPDATE free_tier_user_days SET reserved=reserved+1,updated_at=now()
        WHERE user_id=$1 AND utc_day=$2 AND funding=$3 AND reserved - released < $4
        RETURNING reserved`,
      [input.userId, day, input.funding, caps.user],
    );
    if (!user.rowCount) {
      /*
       * The reader is over their own cap, so the platform slot this transaction
       * took has to go back. Rolling the transaction back would do it too, and
       * an explicit release is preferred: it leaves the pool row's `released`
       * counter telling the truth about how many slots were claimed and handed
       * back, which is the number an operator needs when the pool looks busier
       * than the generations justify.
       */
      await client.query(
        `UPDATE free_tier_pool_days SET released=released+1,updated_at=now() WHERE utc_day=$1 AND funding=$2`,
        [day, input.funding],
      );
      return { ok: false as const, reason: "user_cap_reached" as const };
    }

    const id = randomUUID();
    await client.query(
      `INSERT INTO free_tier_reservations (id,user_id,utc_day,funding,model_id) VALUES ($1,$2,$3,$4,$5)`,
      [id, input.userId, day, input.funding, input.modelId],
    );
    return { ok: true as const, reservation: { id, userId: input.userId, utcDay: day, funding: input.funding, modelId: input.modelId } };
  });
}

async function settle(client: PoolClient, reservation: FreeReservation, outcome: "spent" | "released") {
  /*
   * SETTLING TWICE MUST NOT COUNT TWICE.
   *
   * A stream can fail after a partial reply, a route can retry, a maintenance
   * sweep can reach a reservation the request is about to settle itself. The
   * `WHERE state='reserved'` is what makes all three harmless: the first
   * settlement wins and every later one is a no-op that moves no counter.
   */
  const claimed = await client.query(
    `UPDATE free_tier_reservations SET state=$2,settled_at=now() WHERE id=$1 AND state='reserved' RETURNING id`,
    [reservation.id, outcome],
  );
  if (!claimed.rowCount) return false;
  const column = outcome === "spent" ? "spent" : "released";
  await client.query(
    `UPDATE free_tier_pool_days SET ${column}=${column}+1,updated_at=now() WHERE utc_day=$1 AND funding=$2`,
    [reservation.utcDay, reservation.funding],
  );
  await client.query(
    `UPDATE free_tier_user_days SET ${column}=${column}+1,updated_at=now() WHERE user_id=$1 AND utc_day=$2 AND funding=$3`,
    [reservation.userId, reservation.utcDay, reservation.funding],
  );
  return true;
}

/** The generation ran. The slot is spent and is not coming back. */
export function spendFreeReservation(reservation: FreeReservation) {
  return transaction((client) => settle(client, reservation, "spent"));
}

/**
 * The generation did not run. Give the reader their slot back.
 *
 * Called when a request fails BEFORE inference — a refused upstream, a context
 * that would not fit, a reader who hung up. It is not called for a generation
 * that produced text and then failed: that one consumed real capacity, and
 * pretending otherwise would make the ledger disagree with the bill.
 */
export function releaseFreeReservation(reservation: FreeReservation) {
  return transaction((client) => settle(client, reservation, "released"));
}

/**
 * Reservations abandoned by a process that died between reserving and settling.
 *
 * Without this they hold capacity forever: `reserved - released` never comes
 * down and the pool looks full while nothing is running. The age threshold is
 * generous on purpose — a long generation is not an abandoned one.
 */
export async function sweepStaleReservations(options: { olderThanMs?: number; limit?: number } = {}) {
  const olderThanMs = options.olderThanMs ?? 15 * 60_000;
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const stale = await query<{ id: string; user_id: string; utc_day: string; funding: FreeFunding; model_id: string }>(
    `SELECT id,user_id,utc_day,funding,model_id FROM free_tier_reservations
      WHERE state='reserved' AND created_at < now() - make_interval(secs => $1)
      ORDER BY created_at LIMIT $2`,
    [Math.floor(olderThanMs / 1000), limit],
  );
  let released = 0;
  for (const row of stale.rows) {
    const done = await releaseFreeReservation({
      id: row.id, userId: row.user_id,
      utcDay: typeof row.utc_day === "string" ? row.utc_day : utcDay(new Date(row.utc_day)),
      funding: row.funding, modelId: row.model_id,
    });
    if (done) released += 1;
  }
  return { examined: stale.rowCount ?? 0, released };
}

export type FreeTierStatus = {
  enabled: boolean;
  /** What the reader has left today, from their own cap. */
  userRemaining: number;
  userCap: number;
  /**
   * Whether the shared pool still has capacity — a boolean, not a count.
   *
   * The exact global remaining figure is deliberately NOT returned. It is a
   * fact about the platform's OpenRouter account rather than about the reader,
   * it invites refreshing until a number goes up, and product review has not
   * decided it is useful. "Free generations available today" and "today's
   * shared free capacity has been used" are both answerable from a boolean.
   */
  sharedCapacityAvailable: boolean;
  /** Whether a funded fallback is configured and still has room today. */
  fundedFallbackAvailable: boolean;
  /** UTC midnight, so the UI can say when it comes back. */
  resetsAt: string;
};

/** What the reader is told about the free tier right now. */
export async function freeTierStatus(userId: string, now: Date = new Date()): Promise<FreeTierStatus> {
  const config = freeTierConfig();
  const day = utcDay(now);
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  if (!config.enabled) {
    return { enabled: false, userRemaining: 0, userCap: 0, sharedCapacityAvailable: false, fundedFallbackAvailable: false, resetsAt };
  }
  const [pool, user] = await Promise.all([
    query<{ funding: FreeFunding; reserved: number; released: number }>(
      `SELECT funding,reserved,released FROM free_tier_pool_days WHERE utc_day=$1`, [day]),
    query<{ funding: FreeFunding; reserved: number; released: number }>(
      `SELECT funding,reserved,released FROM free_tier_user_days WHERE user_id=$1 AND utc_day=$2`, [userId, day]),
  ]);
  const outstanding = (rows: Array<{ funding: FreeFunding; reserved: number; released: number }>, funding: FreeFunding) => {
    const row = rows.find((item) => item.funding === funding);
    return row ? Math.max(0, Number(row.reserved) - Number(row.released)) : 0;
  };
  const sharedPoolUsed = outstanding(pool.rows, "shared_free");
  const fundedPoolUsed = outstanding(pool.rows, "platform_funded");
  const sharedUserUsed = outstanding(user.rows, "shared_free");
  return {
    enabled: true,
    userRemaining: Math.max(0, config.userDailyCap - sharedUserUsed),
    userCap: config.userDailyCap,
    sharedCapacityAvailable: sharedPoolUsed < config.sharedDailyPool,
    fundedFallbackAvailable: Boolean(config.fundedModelId)
      && config.fundedDailyPool > 0
      && fundedPoolUsed < config.fundedDailyPool
      && outstanding(user.rows, "platform_funded") < config.fundedUserDailyCap,
    resetsAt,
  };
}
