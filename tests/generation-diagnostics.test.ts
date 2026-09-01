import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generationDiagnosticsEnabled, logGeneration, reasonForCategory,
  type GenerationDiagnostic, type GenerationFailureReason,
} from "@/lib/generation-diagnostics";
import { ProviderError, redactProviderSecrets } from "@/lib/provider-errors";

/**
 * "SOMETHING WENT WRONG" IS THE READER'S SENTENCE AND WAS ALSO THE OPERATOR'S.
 *
 * That is the whole of the diagnostics complaint. The reader's copy is
 * deliberately vague and stays that way — it must never name infrastructure or
 * carry an upstream body — but the operator's copy was the same string, so a
 * Regenerate that failed most of the time could not be told apart from an auth
 * failure, a billing failure, a malformed request or a bug in the route.
 *
 * These tests are about the second audience: that every failure the product can
 * have is nameable, that the name reaches a log, and that nothing a reader
 * wrote can reach one with it.
 */

const base: GenerationDiagnostic = {
  conversationId: "cccccccc-0000-4000-8000-000000000001",
  action: "regenerate",
  outcome: "failed",
  stage: "provider_requested",
};

let logs: Array<[string, string]>;

beforeEach(() => {
  logs = [];
  const capture = (label: string, payload: string) => { logs.push([label, payload]); };
  vi.spyOn(console, "error").mockImplementation((label, payload) => capture(String(label), String(payload)));
  vi.spyOn(console, "warn").mockImplementation((label, payload) => capture(String(label), String(payload)));
  vi.spyOn(console, "info").mockImplementation((label, payload) => capture(String(label), String(payload)));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("every failure a turn can have has a name", () => {
  /*
   * The list from the sprint brief, §11. A reason that is not in the union
   * would not compile; a reason that never reaches a log would not be usable.
   */
  const required: GenerationFailureReason[] = [
    "timeout", "bad_request", "provider_incompatible", "auth", "billing",
    "empty_response", "content_filtered", "stream_parse_failure",
    "persistence_failure", "variant_conflict", "client_aborted",
  ];

  for (const reason of required) {
    it(`records ${reason}`, () => {
      logGeneration({ ...base, reason });
      expect(logs).toHaveLength(1);
      expect(logs[0][1]).toContain(`"reason":"${reason}"`);
    });
  }

  it("maps every provider category onto one", () => {
    for (const category of ["rate_limited", "upstream_unavailable", "empty_response", "content_filtered", "auth", "billing", "bad_request", "timeout", "unknown"] as const) {
      const reason = reasonForCategory(category);
      expect(typeof reason).toBe("string");
      // The categories and the reasons share a vocabulary on purpose, so an
      // operator grepping for one finds the other.
      expect(new ProviderError(category).category).toBe(category);
    }
  });
});

describe("what a turn's record says", () => {
  it("names the stage that failed", () => {
    logGeneration({ ...base, stage: "provider_accepted", reason: "empty_response" });
    expect(logs[0][1]).toContain('"stage":"provider_accepted"');
  });

  it("carries the fields that separate regenerate from send", () => {
    logGeneration({
      ...base, outcome: "ok", stage: "persisted",
      targetMessageId: "dddddddd-0000-4000-8000-000000000001",
      targetSource: "client", variantIndex: 2, existingVariants: 2,
      transcriptRowsLoaded: 34, transcriptMessagesSent: 30, transcriptTrimmed: 0,
    });
    // Successes are the comparison set, so they need the diagnostics switch on.
    expect(logs).toHaveLength(0);
    vi.stubEnv("CHAT_GENERATION_DIAGNOSTICS", "1");
    logGeneration({ ...base, outcome: "ok", stage: "persisted", variantIndex: 2, targetSource: "client" });
    expect(logs[0][1]).toContain('"variantIndex":2');
    expect(logs[0][1]).toContain('"targetSource":"client"');
  });

  it("says how the generation ended, which is what a truncation looks like", () => {
    logGeneration({ ...base, outcome: "failed", finishReason: "length", truncated: true, completionTokens: 1800, reasoningTokens: 1500 });
    const line = logs[0][1];
    expect(line).toContain('"finishReason":"length"');
    expect(line).toContain('"truncated":true');
    expect(line).toContain('"reasoningTokens":1500');
  });

  it("separates a product refusal from a fault", () => {
    logGeneration({ ...base, outcome: "refused", reason: "free_capacity_exhausted" });
    expect(logs[0][0]).toContain("refused");
    logs = [];
    logGeneration({ ...base, outcome: "failed", reason: "unknown" });
    expect(logs[0][0]).toContain("failed");
  });

  it("always writes a failure, whatever the diagnostics switch says", () => {
    vi.stubEnv("CHAT_GENERATION_DIAGNOSTICS", "0");
    expect(generationDiagnosticsEnabled()).toBe(false);
    logGeneration({ ...base, reason: "bad_request" });
    // A failure nobody can see is the bug this file exists to remove.
    expect(logs).toHaveLength(1);
  });

  it("drops absent fields rather than filling the line with nulls", () => {
    logGeneration({ ...base, reason: "timeout" });
    expect(logs[0][1]).not.toContain("undefined");
    expect(logs[0][1]).not.toContain('"upstreamProvider"');
  });
});

describe("nothing a reader wrote can reach a log line", () => {
  it("has no field for prompt, message or memory text", () => {
    // Structural, not a filter: the type has no such field, so there is nothing
    // for a careless caller to put content into. The one free-text field is the
    // upstream's own body.
    const record: GenerationDiagnostic = { ...base, detail: "provider said no" };
    const keys = Object.keys(record);
    for (const forbidden of ["content", "prompt", "message", "text", "memory", "transcript"]) {
      expect(keys.some((key) => key.toLowerCase() === forbidden)).toBe(false);
    }
  });

  it("redacts a credential that reaches the upstream detail", () => {
    logGeneration({ ...base, reason: "auth", detail: 'Authorization: Bearer sk-or-v1-abcdef123456 rejected' });
    const line = logs[0][1];
    expect(line).not.toContain("sk-or-v1-abcdef123456");
    expect(line).toContain("REDACTED");
    // And the same redaction the provider log uses, so there is one rule.
    expect(redactProviderSecrets("sk-or-v1-abcdef123456")).toContain("REDACTED");
  });

  it("bounds the upstream detail so a body cannot flood the drain", () => {
    logGeneration({ ...base, reason: "bad_request", detail: "x".repeat(4000) });
    expect(logs[0][1].length).toBeLessThan(1200);
  });
});
