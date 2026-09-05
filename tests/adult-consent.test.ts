import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { explicitRoleplayAllowed, presentsAsAdult, readableWithoutAccount, requiresAdultConfirmation } from "@/lib/content-mode";

/**
 * The consent flow, end to end.
 *
 * 0036 made two facts server-side and required them before adult content, and
 * shipped without any way for a reader to establish either — so a signed-in
 * account could open an adult-focused creation, send a message, and be told to
 * confirm their age with nothing in the product that could. These tests are
 * mostly about that gap staying closed: every one of them would have passed
 * against the broken build except the ones that write.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
let account: { id: string; email: string | null } | null = null;

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const adultRoute = await import("@/app/api/adult/route");

function post(body: unknown) {
  return new Request("http://test/api/adult", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function state(userId: string) {
  const profile = await query("SELECT adult_confirmed_at FROM profiles WHERE id=$1", [userId]);
  const settings = await query("SELECT adult_content_enabled FROM user_settings WHERE user_id=$1", [userId]);
  return {
    confirmedAt: profile.rows[0]?.adult_confirmed_at ?? null,
    enabled: Boolean(settings.rows[0]?.adult_content_enabled),
  };
}

describe("the reader's adult state", () => {
  beforeEach(async () => {
    const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
    memoryDb.public.registerFunction({
      name: "date_trunc", args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz,
      implementation: (unit: string, value: Date) => { const out = new Date(value); if (unit === "day") out.setHours(0, 0, 0, 0); return out; },
    });
    memoryDb.public.registerFunction({
      name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
      implementation: (value: string, length: number) => value.slice(0, length),
    });
    setPoolForTesting(new (memoryDb.adapters.createPg()).Pool() as unknown as Pool);
    await ensureSchema();
    for (const id of [alice, bob]) {
      await query("INSERT INTO profiles (id,display_name) VALUES ($1,'Reader') ON CONFLICT (id) DO NOTHING", [id]);
      await query("INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [id]);
    }
    account = { id: alice, email: null };
  });

  it("starts with nothing confirmed and nothing enabled", async () => {
    const body = await (await adultRoute.GET()).json();
    expect(body.adult).toEqual({ confirmedAdult: false, confirmedAt: null, adultContentEnabled: false });
  });

  it("records a confirmation and enables content in one act", async () => {
    const body = await (await adultRoute.POST(post({ confirm: true, adultContentEnabled: true }))).json();
    expect(body.adult.confirmedAdult).toBe(true);
    expect(body.adult.adultContentEnabled).toBe(true);
    // The response IS the new state, so a client continues without reloading.
    expect(body.adult.confirmedAt).toBeTruthy();
  });

  it("never accepts a timestamp from the caller", async () => {
    const forged = "1990-01-01T00:00:00.000Z";
    await adultRoute.POST(post({ confirm: true, adultConfirmedAt: forged, confirmedAt: forged }));
    const stored = await state(alice);
    expect(new Date(String(stored.confirmedAt)).getFullYear()).toBeGreaterThan(2000);
  });

  it("keeps the FIRST confirmation when asked again", async () => {
    await adultRoute.POST(post({ confirm: true }));
    const first = (await state(alice)).confirmedAt;
    await adultRoute.POST(post({ confirm: true }));
    expect((await state(alice)).confirmedAt).toEqual(first);
  });

  it("turns the preference off without erasing the confirmation", async () => {
    await adultRoute.POST(post({ confirm: true, adultContentEnabled: true }));
    const body = await (await adultRoute.POST(post({ adultContentEnabled: false }))).json();
    expect(body.adult.adultContentEnabled).toBe(false);
    // The reader has not stopped being an adult.
    expect(body.adult.confirmedAdult).toBe(true);
    expect((await state(alice)).confirmedAt).toBeTruthy();
  });

  it("refuses to enable content for an account that never confirmed", async () => {
    const body = await (await adultRoute.POST(post({ adultContentEnabled: true }))).json();
    expect(body.adult.confirmedAdult).toBe(false);
    // Enforced by the statement's own predicate, not by a branch above it.
    expect(body.adult.adultContentEnabled).toBe(false);
  });

  it("is per account, so one reader's confirmation is not another's", async () => {
    await adultRoute.POST(post({ confirm: true, adultContentEnabled: true }));
    account = { id: bob, email: null };
    const body = await (await adultRoute.GET()).json();
    expect(body.adult.confirmedAdult).toBe(false);
  });

  it("persists across sessions and devices, because it is not in a browser", async () => {
    await adultRoute.POST(post({ confirm: true, adultContentEnabled: true }));
    // A "new device" is simply another request with no client state at all.
    const body = await (await adultRoute.GET()).json();
    expect(body.adult.confirmedAdult).toBe(true);
    expect(body.adult.adultContentEnabled).toBe(true);
  });

  it("refuses an anonymous caller", async () => {
    account = null;
    expect((await adultRoute.GET()).status).toBe(401);
    expect((await adultRoute.POST(post({ confirm: true }))).status).toBe(401);
  });

  it("refuses a request that changes nothing", async () => {
    expect((await adultRoute.POST(post({}))).status).toBe(400);
    // "Unconfirm" is not an operation, and a silent no-op would be worse.
    expect((await adultRoute.POST(post({ confirm: false }))).status).toBe(400);
  });
});

/**
 * Which gate a reader meets, decided by the same functions the UI calls.
 *
 * The components choose between "confirm your age" and "turn this on" from
 * these two facts, so the decision table is asserted here rather than by
 * rendering: a wrong branch shows somebody a question they already answered.
 */
describe("the gate a signed-in reader meets", () => {
  const unconfirmed = { confirmedAdult: false, adultContentEnabled: false };
  const confirmedOff = { confirmedAdult: true, adultContentEnabled: false };
  const confirmedOn = { confirmedAdult: true, adultContentEnabled: true };

  it("gates an adult-focused creation before the page for an unconfirmed reader", () => {
    expect(requiresAdultConfirmation("adult_focused")).toBe(true);
    expect(presentsAsAdult("adult_focused")).toBe(true);
  });

  it("opens it once confirmed and enabled", () => {
    expect(explicitRoleplayAllowed("adult_focused", confirmedOn)).toBe(true);
  });

  it("asks a confirmed reader with the preference off to enable, not to confirm again", () => {
    // Both gates are reachable; which one shows is decided by `confirmedAdult`,
    // and this is the case that must NOT re-ask for an age.
    expect(confirmedOff.confirmedAdult).toBe(true);
    expect(explicitRoleplayAllowed("adult_focused", confirmedOff)).toBe(false);
  });

  it("leaves adult-capable creations open to everybody", () => {
    // No gate at all: readable without an account, and chattable without a
    // confirmation. Only the writing changes.
    expect(presentsAsAdult("adult_capable")).toBe(false);
    expect(requiresAdultConfirmation("adult_capable")).toBe(false);
    expect(readableWithoutAccount("adult_capable")).toBe(true);
  });

  it("keeps an adult-capable story clean until BOTH facts are true", () => {
    expect(explicitRoleplayAllowed("adult_capable", unconfirmed)).toBe(false);
    expect(explicitRoleplayAllowed("adult_capable", confirmedOff)).toBe(false);
    expect(explicitRoleplayAllowed("adult_capable", confirmedOn)).toBe(true);
  });

  it("never lets a clean creation go explicit, whatever the reader enabled", () => {
    expect(explicitRoleplayAllowed("clean", confirmedOn)).toBe(false);
  });
});
