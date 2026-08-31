import { describe, expect, it } from "vitest";
import { driftVerdict, providerSlug, summarizeAffinity, summarizeProviderEconomics, type AffinityEvent } from "@/lib/provider-affinity";

/**
 * The two worlds that look identical in an account-wide report.
 *
 * WORLD A: one conversation bounced across four hosts, re-reading its prompt
 * from cold each time. A routing bug, and expensive.
 *
 * WORLD B: four conversations each settled on a different host and stayed
 * warm. Working exactly as designed.
 *
 * Summed by provider, these two produce the SAME table — the same four hosts,
 * the same call counts, the same spend. That is why the observed GLM breakdown
 * could not be read as evidence of drift, and it is the specific confusion
 * these tests exist to make impossible to repeat.
 */

let clock = 0;
function event(conversationId: string, provider: string | null, over: Partial<AffinityEvent> = {}): AffinityEvent {
  clock += 60_000;
  return {
    conversationId, model: "glm-4.7", upstreamProvider: provider,
    createdAt: new Date(1_700_000_000_000 + clock).toISOString(),
    promptTokens: 10_000, cacheHitTokens: 8_000, completionTokens: 500, reasoningTokens: 0,
    providerCostUsd: 0.01, latencyMs: 4_000, ttftMs: 900,
    ...over,
  };
}

describe("one conversation bouncing versus several settled ones", () => {
  const hosts = ["DeepInfra", "Z.AI", "Novita", "Xiaomi"];
  const bouncing = hosts.map((host) => event("conv-a", host));
  const settled = hosts.map((host) => event(`conv-${host}`, host));

  it("produces the same provider rollup for both, which is the trap", () => {
    const asBounce = summarizeProviderEconomics(bouncing).map((row) => [row.provider, row.generations]).sort();
    const asSettled = summarizeProviderEconomics(settled).map((row) => [row.provider, row.generations]).sort();
    expect(asBounce).toEqual(asSettled);
  });

  it("tells them apart the moment the unit of analysis is one conversation", () => {
    const bounced = summarizeAffinity(bouncing);
    expect(bounced).toHaveLength(1);
    expect(bounced[0].providerSwitches).toBe(3);
    expect(bounced[0].firstProvider).toBe("DeepInfra");
    expect(bounced[0].latestProvider).toBe("Xiaomi");

    const stuck = summarizeAffinity(settled);
    expect(stuck).toHaveLength(4);
    expect(stuck.every((row) => row.providerSwitches === 0)).toBe(true);
  });
});

describe("counting switches", () => {
  it("counts changes, not distinct hosts", () => {
    // A → B → A is two switches and two hosts. Counting hosts would say one
    // switch and would understate exactly the pattern that costs the most:
    // a conversation ping-ponging between two warm-then-cold caches.
    const rows = summarizeAffinity([
      event("c", "DeepInfra"), event("c", "Z.AI"), event("c", "DeepInfra"),
    ]);
    expect(rows[0].providerSwitches).toBe(2);
    expect(rows[0].providers).toHaveLength(2);
  });

  it("orders by time rather than by arrival", () => {
    const later = event("c", "Z.AI");
    const earlier = event("c", "DeepInfra", { createdAt: new Date(1_600_000_000_000).toISOString() });
    // Rows can come back in any order; "how many times did the host change" is
    // a question about a sequence and is meaningless over a set.
    const rows = summarizeAffinity([later, earlier]);
    expect(rows[0].firstProvider).toBe("DeepInfra");
    expect(rows[0].latestProvider).toBe("Z.AI");
    expect(rows[0].providerSwitches).toBe(1);
  });

  it("never manufactures churn out of a missing provider name", () => {
    // A row whose provider was not reported is not a fifth host. Treating
    // unknown as distinct would invent drift from missing data, which is the
    // same error as the aggregate makes, in the opposite direction.
    const rows = summarizeAffinity([
      event("c", "DeepInfra"), event("c", null), event("c", "DeepInfra"),
    ]);
    expect(rows[0].providerSwitches).toBe(0);
    expect(rows[0].generations).toBe(3);
  });

  it("keeps two models in one conversation apart", () => {
    // Changing writer mid-story changes the prompt AND the endpoint set, so
    // pooling them would report a model switch as provider churn.
    const rows = summarizeAffinity([
      event("c", "DeepInfra"),
      { ...event("c", "Xiaomi"), model: "mimo-v2.5" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.providerSwitches === 0)).toBe(true);
  });
});

describe("the drift verdict", () => {
  it("ignores conversations too short to have drifted", () => {
    // A one-turn story cannot bounce. Counting it as "did not drift" would
    // dilute the rate toward zero and hide a real problem behind volume.
    const rows = summarizeAffinity([
      event("short", "DeepInfra"),
      event("long", "DeepInfra"), event("long", "Z.AI"), event("long", "Z.AI"),
    ]);
    const verdict = driftVerdict(rows);
    expect(verdict.eligibleConversations).toBe(1);
    expect(verdict.driftedConversations).toBe(1);
    expect(verdict.driftedShare).toBe(1);
    expect(verdict.switchesPerGeneration).toBeCloseTo(1 / 3);
  });

  it("reports no drift as no drift rather than as no data", () => {
    const rows = summarizeAffinity(Array.from({ length: 6 }, () => event("c", "DeepInfra")));
    const verdict = driftVerdict(rows);
    expect(verdict.driftedConversations).toBe(0);
    expect(verdict.driftedShare).toBe(0);
    expect(verdict.worst).toEqual([]);
  });
});

describe("effective input price", () => {
  it("splits a reported total into its input half at the endpoint's list output rate", () => {
    /*
     * OpenRouter reports what a generation COST, not how that cost divided, and
     * the input half is the number the caching work is judged on. So the output
     * half is subtracted at the endpoint's list rate and the rest is attributed
     * to prompt tokens.
     *
     * Here: 1M prompt tokens at DeepInfra's 90% cache ratio should cost
     * 0.9M × $0.08 + 0.1M × $0.40 = $0.112, plus 100k output at $1.75 = $0.175.
     */
    const rows = summarizeProviderEconomics([
      event("c", "DeepInfra", { promptTokens: 1_000_000, cacheHitTokens: 900_000, completionTokens: 100_000, providerCostUsd: 0.112 + 0.175 }),
    ]);
    expect(rows[0].effectiveInputBasis).toBe("derived");
    expect(rows[0].effectiveInputUsdPerMillion).toBeCloseTo(0.112, 3);
    // Worth stating plainly: a 90% cache ratio turns a $0.40/M list price into
    // an $0.11/M real one. That multiple is the entire economic case for
    // keeping one conversation on one host.
    expect(rows[0].effectiveInputUsdPerMillion).toBeLessThan(0.4);
  });

  it("says it does not know rather than guessing for an unpriced endpoint", () => {
    const rows = summarizeProviderEconomics([event("c", "SomeNewHost")]);
    expect(rows[0].effectiveInputUsdPerMillion).toBeNull();
    expect(rows[0].effectiveInputBasis).toBe("unknown_endpoint_pricing");
  });

  it("declines to report a negative price when the list rate disagrees with the bill", () => {
    // A cost lower than the output half alone means the table is wrong for this
    // endpoint. Reporting a negative $/M would be worse than reporting none.
    const rows = summarizeProviderEconomics([
      event("c", "DeepInfra", { completionTokens: 1_000_000, providerCostUsd: 0.5 }),
    ]);
    expect(rows[0].effectiveInputUsdPerMillion).toBeNull();
    // The authoritative figures are still reported: these are measured, not derived.
    expect(rows[0].costUsd).toBe(0.5);
    expect(rows[0].cacheRatio).toBeCloseTo(0.8);
  });
});

describe("provider names versus routing slugs", () => {
  it("maps the ledger's display names onto the slugs routing uses", () => {
    // The ledger stores "DeepInfra"; `provider.only` takes "deepinfra". Two
    // namespaces for one thing, and comparing across them without this would
    // report every row as a different provider.
    expect(providerSlug("DeepInfra")).toBe("deepinfra");
    expect(providerSlug("Z.AI")).toBe("z-ai");
    expect(providerSlug("NovitaAI")).toBe("novita");
    expect(providerSlug("AtlasCloud")).toBe("atlas-cloud");
  });

  it("degrades to a guess rather than to an error for a host it has never seen", () => {
    expect(providerSlug("Some New Host")).toBe("some-new-host");
    expect(providerSlug(null)).toBeNull();
    expect(providerSlug("  ")).toBeNull();
  });
});
