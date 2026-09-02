import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A FAILED CHEAP EXTRACTOR MUST NOT QUIETLY TURN MEMORY OFF.
 *
 * The production failure, in order: an experimental memory route was selected;
 * every consolidation on it returned `empty_response`; background work is
 * deliberately not coupled to the reply, so the chat request was correct and
 * cheerful throughout; the failures went to a console nobody was watching; and
 * the reader found out days later that the conversation had NO MEMORIES.
 *
 * Two things had to change and this suite covers both.
 *
 *   THE WINDOW GETS A SECOND CHANCE, from the control. An experiment allowed to
 *   be wrong about cost is fine. An experiment that silently deletes continuity
 *   is not, and the loss is PERMANENT: once the story moves on, the window it
 *   failed on is consolidated-past and no later job goes back for it.
 *
 *   SOMEBODY IS TOLD. Success and failure are both recorded, so "is memory
 *   being written for this story" has an answer that does not require Railway
 *   logs.
 *
 * The bounds matter as much as the behaviour: ONE retry, only for failures that
 * are about a route rather than about a misconfiguration, and never for the
 * Scene Ledger — whose previous state simply stands.
 */

const openrouterCompletion = vi.fn();
const deepseekCompletion = vi.fn();

vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(),
  completionWithUsage: (...args: unknown[]) => deepseekCompletion(...args),
  parseJson: (value: string) => JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")),
}));
vi.mock("@/lib/openrouter", () => ({
  streamCompletion: vi.fn(),
  completionWithUsage: (...args: unknown[]) => openrouterCompletion(...args),
  embed: vi.fn(),
  providerHeadersTimeoutMs: () => 20_000,
  maxAttempts: 3,
}));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const { maybeConsolidate } = await import("@/lib/memory");
const { maybeUpdateSceneState } = await import("@/lib/scene-state-store");
const { clearBackgroundRouteCache } = await import("@/lib/background-routing");
const { backgroundJobHealth, memoryWarning } = await import("@/lib/background-health");
const { ProviderError } = await import("@/lib/provider-errors");

const owner = "11111111-1111-4111-8111-111111111111";

const consolidationReply = (summary: string) => ({
  content: JSON.stringify({ summary, arcSummary: "An arc.", arcKeywords: ["k"], memories: [{ content: "She kept the boat promise.", kind: "event", importance: 4, keywords: ["boat"] }] }),
  usage: { prompt_tokens: 1800, completion_tokens: 400, cost: 0.0004 },
});

let conversationId = "";
let characterId = "";

async function seedStory(messages = 12) {
  characterId = crypto.randomUUID();
  conversationId = crypto.randomUUID();
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query(
    "INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Story',$4)",
    [conversationId, owner, characterId, messages],
  );
  for (let index = 0; index < messages; index += 1) {
    await query(
      "INSERT INTO messages (id,conversation_id,user_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [crypto.randomUUID(), conversationId, owner, index % 2 === 0 ? "user" : "assistant",
        `Turn ${index}. ${"word ".repeat(80)}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()],
    );
  }
}

/** Selects an experimental (non-control) memory route, globally. */
async function selectExperimentalRoute(candidateId = "ling_3_flash") {
  await query(
    "INSERT INTO background_model_routes (task,candidate_id) VALUES ('memory_consolidation',$1) ON CONFLICT (task) DO UPDATE SET candidate_id=EXCLUDED.candidate_id",
    [candidateId],
  );
  clearBackgroundRouteCache();
}

async function usageRows() {
  const result = await query("SELECT * FROM usage_events WHERE user_id=$1 AND usage_type='memory_consolidation' ORDER BY created_at ASC", [owner]);
  return result.rows.map((row) => ({
    model: String(row.model),
    providerId: String(row.provider_id),
    routing: (typeof row.provider_metadata === "string" ? JSON.parse(String(row.provider_metadata)) : row.provider_metadata as Record<string, unknown>).routing as Record<string, unknown>,
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
  }));
}

const health = () => backgroundJobHealth(owner, conversationId);

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  openrouterCompletion.mockReset();
  deepseekCompletion.mockReset();
  clearBackgroundRouteCache();
  vi.stubEnv("DEEPSEEK_API_KEY", "ds-test-key");
  vi.stubEnv("ENABLE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "or-test-key");
});
afterEach(() => { vi.unstubAllEnvs(); clearBackgroundRouteCache(); });

describe("the memory fallback", () => {
  it("rescues an empty response from an experimental route with the control", async () => {
    await seedStory();
    await selectExperimentalRoute();
    openrouterCompletion.mockRejectedValueOnce(new ProviderError("empty_response", { provider: "openrouter", model: "inclusionai/ling-3.0-flash" }));
    deepseekCompletion.mockResolvedValueOnce(consolidationReply("CURRENT STATE: the jetty."));

    expect(await maybeConsolidate(owner, conversationId, true)).toBe(true);
    expect(openrouterCompletion).toHaveBeenCalledTimes(1);
    expect(deepseekCompletion).toHaveBeenCalledTimes(1);

    // The memory the reader would otherwise never have had.
    const memories = await query("SELECT content FROM memories WHERE conversation_id=$1", [conversationId]);
    expect(memories.rowCount).toBe(1);
    const conversation = await query("SELECT summary,last_consolidated_count FROM conversations WHERE id=$1", [conversationId]);
    expect(String(conversation.rows[0].summary)).toContain("the jetty");
    expect(Number(conversation.rows[0].last_consolidated_count)).toBeGreaterThan(0);
  });

  it("records the fallback as a fallback, not as a switch to DeepSeek", async () => {
    /*
     * Without this the comparison lies in the worst direction: two weeks of a
     * challenger's traffic would be credited to the control, and the control
     * would win an A/B it never ran.
     */
    await seedStory();
    await selectExperimentalRoute();
    openrouterCompletion.mockRejectedValueOnce(new ProviderError("empty_response", {}));
    deepseekCompletion.mockResolvedValueOnce(consolidationReply("CURRENT STATE: the jetty."));
    await maybeConsolidate(owner, conversationId, true);

    const rows = await usageRows();
    // The failed attempt threw before any usage came back, so there is one row —
    // the attempt that was actually billed — and it says exactly what it was.
    expect(rows).toHaveLength(1);
    expect(rows[0].providerId).toBe("deepseek");
    expect(rows[0].model).toBe("deepseek-v4-flash");
    expect(rows[0].routing).toMatchObject({
      task: "memory_consolidation",
      candidate: "direct_deepseek",
      fallback: true,
      requestedCandidate: "ling_3_flash",
      failureReason: "empty_response",
    });
    expect(rows[0].completionTokens).toBe(400);
  });

  it("bills both attempts when both actually produced tokens", async () => {
    // A malformed reply was paid for. Dropping its cost would make an
    // experimental route look cheaper than it is, which is the one direction a
    // cost report must not be wrong in.
    await seedStory();
    await selectExperimentalRoute();
    openrouterCompletion.mockResolvedValueOnce({ content: "Sorry, I can't produce JSON.", usage: { prompt_tokens: 1800, completion_tokens: 25, cost: 0.0001 } });
    deepseekCompletion.mockResolvedValueOnce(consolidationReply("CURRENT STATE: the jetty."));
    expect(await maybeConsolidate(owner, conversationId, true)).toBe(true);

    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBe("ling-3.0-flash");
    expect(rows[0].routing).toMatchObject({ candidate: "ling_3_flash" });
    expect(rows[0].routing.fallback).toBeUndefined();
    expect(rows[1].model).toBe("deepseek-v4-flash");
    expect(rows[1].routing).toMatchObject({ fallback: true, failureReason: "malformed_output" });
  });

  it("does not fall back when the experimental route works", async () => {
    await seedStory();
    await selectExperimentalRoute();
    openrouterCompletion.mockResolvedValueOnce(consolidationReply("CURRENT STATE: the jetty."));
    expect(await maybeConsolidate(owner, conversationId, true)).toBe(true);
    expect(deepseekCompletion).not.toHaveBeenCalled();

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("ling-3.0-flash");
    expect(rows[0].routing.fallback).toBeUndefined();
    expect((await health()).get("memory_consolidation")).toMatchObject({ lastSuccessUsedFallback: false, consecutiveFailures: 0 });
  });

  it("does not fall back from the control to itself", async () => {
    // The default route IS the control. A second identical attempt is a second
    // identical failure and a second bill.
    await seedStory();
    deepseekCompletion.mockRejectedValueOnce(new ProviderError("empty_response", {}));
    expect(await maybeConsolidate(owner, conversationId, true)).toBe(false);
    expect(deepseekCompletion).toHaveBeenCalledTimes(1);
  });

  it("is one attempt, not a cascade through the candidate list", async () => {
    await seedStory();
    await selectExperimentalRoute();
    openrouterCompletion.mockRejectedValue(new ProviderError("rate_limited", {}));
    deepseekCompletion.mockRejectedValue(new ProviderError("upstream_unavailable", {}));
    expect(await maybeConsolidate(owner, conversationId, true)).toBe(false);
    expect(openrouterCompletion).toHaveBeenCalledTimes(1);
    expect(deepseekCompletion).toHaveBeenCalledTimes(1);
  });

  it("leaves the window unconsolidated when both routes fail, so a later job can read it", async () => {
    await seedStory();
    await selectExperimentalRoute();
    openrouterCompletion.mockRejectedValueOnce(new ProviderError("empty_response", {}));
    deepseekCompletion.mockRejectedValueOnce(new ProviderError("empty_response", {}));
    await maybeConsolidate(owner, conversationId, true);

    const conversation = await query("SELECT summary,last_consolidated_count FROM conversations WHERE id=$1", [conversationId]);
    // The position pointer only moves on a successful pass. Nothing is lost yet.
    expect(Number(conversation.rows[0].last_consolidated_count)).toBe(0);
    expect(String(conversation.rows[0].summary)).toBe("");
  });

  it("refuses to route around a misconfiguration", async () => {
    /*
     * A wrong key, an empty account, or a request this deployment got wrong.
     * Quietly answering with the control means the operator discovers it at the
     * worst possible moment instead of the first one — and one of these
     * categories is precisely how a pinned host says "I will not run this job",
     * which is a fact somebody needs to see rather than paper over.
     */
    for (const category of ["auth", "billing", "bad_request", "content_filtered"] as const) {
      openrouterCompletion.mockReset();
      deepseekCompletion.mockReset();
      await seedStory();
      await selectExperimentalRoute();
      openrouterCompletion.mockRejectedValueOnce(new ProviderError(category, {}));
      expect(await maybeConsolidate(owner, conversationId, true), category).toBe(false);
      expect(deepseekCompletion, category).not.toHaveBeenCalled();
      expect((await health()).get("memory_consolidation")?.lastFailureReason, category).toBe(category);
    }
  });

  it("never rescues the Scene Ledger with a dearer model", async () => {
    /*
     * Its previous state simply stands, which is a correct answer. Paying a
     * dearer model to re-derive "where are we" is not worth it, and the ledger
     * already treats a skip, a failure and a disabled extractor as one
     * behaviour with three causes.
     */
    await seedStory(2);
    vi.stubEnv("SCENE_STATE_ENABLED", "true");
    vi.stubEnv("SCENE_STATE_USER_IDS", owner);
    await query("INSERT INTO background_model_routes (task,candidate_id) VALUES ('scene_state','ling_3_flash')");
    clearBackgroundRouteCache();

    openrouterCompletion.mockRejectedValue(new ProviderError("empty_response", {}));
    expect(await maybeUpdateSceneState(owner, conversationId, true)).toBe(false);
    expect(deepseekCompletion).not.toHaveBeenCalled();
  });
});

describe("background job health", () => {
  it("records what ran, what failed, and how many times in a row", async () => {
    await seedStory();
    await selectExperimentalRoute();

    openrouterCompletion.mockRejectedValueOnce(new ProviderError("empty_response", {}));
    deepseekCompletion.mockRejectedValueOnce(new ProviderError("empty_response", {}));
    await maybeConsolidate(owner, conversationId, true);
    let row = (await health()).get("memory_consolidation");
    expect(row).toMatchObject({ consecutiveFailures: 1, lastFailureReason: "empty_response → empty_response" });
    expect(row?.lastSuccessAt).toBeNull();

    openrouterCompletion.mockRejectedValueOnce(new ProviderError("rate_limited", {}));
    deepseekCompletion.mockRejectedValueOnce(new ProviderError("rate_limited", {}));
    await maybeConsolidate(owner, conversationId, true);
    expect((await health()).get("memory_consolidation")?.consecutiveFailures).toBe(2);

    // A success ends the streak and says the control had to carry it.
    openrouterCompletion.mockRejectedValueOnce(new ProviderError("empty_response", {}));
    deepseekCompletion.mockResolvedValueOnce(consolidationReply("CURRENT STATE: the jetty."));
    await maybeConsolidate(owner, conversationId, true);
    row = (await health()).get("memory_consolidation");
    expect(row).toMatchObject({ consecutiveFailures: 0, lastSuccessUsedFallback: true, lastSuccessModel: "deepseek-v4-flash" });
    // And the failure it recovered from is still on the record: an operator
    // needs to see what has been going wrong on a job that recovered.
    expect(row?.lastFailureAt).not.toBeNull();
  });

  it("names the candidate that failed even when the fallback saved the job", async () => {
    /*
     * THE PRODUCTION CASE THIS ANSWERS.
     *
     *   requested: deepseek_0731_relace
     *   failure reason: malformed_output
     *   Direct DeepSeek fallback then succeeded
     *
     * The fallback is correct and stays. What was missing is that the drawer
     * read this as a perfectly healthy job on DeepSeek: the candidate under
     * evaluation was never once named as the thing that keeps failing, which is
     * the entire question an A/B period is asking.
     */
    await seedStory();
    await selectExperimentalRoute("deepseek_0731_relace");
    vi.stubEnv("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS", "relace/fp4");
    clearBackgroundRouteCache();

    openrouterCompletion.mockResolvedValueOnce({ content: "Here is the summary you asked for!", usage: { prompt_tokens: 1800, completion_tokens: 30, cost: 0.0002 } });
    deepseekCompletion.mockResolvedValueOnce(consolidationReply("CURRENT STATE: the jetty."));
    expect(await maybeConsolidate(owner, conversationId, true)).toBe(true);

    const row = (await health()).get("memory_consolidation");
    // The job is alive, and by what.
    expect(row).toMatchObject({
      consecutiveFailures: 0,
      lastSuccessModel: "deepseek-v4-flash",
      lastSuccessCandidate: "direct_deepseek",
      lastSuccessUsedFallback: true,
    });
    // And the attempt it rescued is on the same row, named and categorised.
    expect(row).toMatchObject({
      lastFailureModel: "deepseek-v4-flash-0731-relace",
      lastFailureCandidate: "deepseek_0731_relace",
      lastFailureReason: "malformed_output",
    });
    expect(row?.lastFailureAt).not.toBeNull();

    // Both attempts are billed and both say which they were.
    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBe("deepseek-v4-flash-0731-relace");
    expect(rows[0].routing).toMatchObject({ candidate: "deepseek_0731_relace" });
    expect(rows[0].routing.fallback).toBeUndefined();
    expect(rows[0].completionTokens).toBe(30);
    expect(rows[1].model).toBe("deepseek-v4-flash");
    expect(rows[1].routing).toMatchObject({
      candidate: "direct_deepseek", fallback: true,
      requestedCandidate: "deepseek_0731_relace", failureReason: "malformed_output",
    });
    expect(rows[1].completionTokens).toBe(400);
  });

  it("does not invent a rescue on an ordinary success", async () => {
    // A success that needed no fallback leaves whatever failure history was
    // already there, and adds none.
    await seedStory();
    await selectExperimentalRoute();
    openrouterCompletion.mockResolvedValueOnce(consolidationReply("CURRENT STATE: the jetty."));
    await maybeConsolidate(owner, conversationId, true);
    const row = (await health()).get("memory_consolidation");
    expect(row).toMatchObject({ lastSuccessUsedFallback: false, lastFailureReason: "" });
    expect(row?.lastFailureAt).toBeNull();
  });

  it("never stores anything but a category", async () => {
    // This column is rendered in a browser. The upstream body belongs in
    // `ProviderError.diagnostic` and in the server log alone.
    await seedStory();
    await selectExperimentalRoute();
    openrouterCompletion.mockRejectedValueOnce(new ProviderError("empty_response", { detail: "Maya said she would bring the boat back" }));
    deepseekCompletion.mockRejectedValueOnce(new ProviderError("empty_response", { detail: "secret upstream body" }));
    await maybeConsolidate(owner, conversationId, true);

    const stored = await query("SELECT last_failure_reason FROM background_job_health WHERE conversation_id=$1", [conversationId]);
    const reason = String(stored.rows[0].last_failure_reason);
    expect(reason).toBe("empty_response → empty_response");
    expect(reason).not.toContain("boat");
    expect(reason).not.toContain("secret");
    expect(reason.length).toBeLessThanOrEqual(60);
  });

  it("records canon curation separately, and does not rescue it", async () => {
    /*
     * Watched but not rescued, and the difference is what is lost. A failed
     * curation loses nothing — the memories and arcs it reads are all still
     * there and the next interval tries again — so paying the control to re-run
     * it buys being slightly more up to date.
     */
    await seedStory(40);
    vi.stubEnv("MEMORY_RETRIEVAL_V2_ENABLED", "true");
    vi.stubEnv("MEMORY_RETRIEVAL_V2_USER_IDS", owner);
    await query("INSERT INTO background_model_routes (task,candidate_id) VALUES ('memory_curation','ling_3_flash')");
    clearBackgroundRouteCache();
    const { maybeCurateCanon } = await import("@/lib/memory-v2");

    openrouterCompletion.mockRejectedValueOnce(new ProviderError("empty_response", {}));
    expect(await maybeCurateCanon(owner, conversationId, true)).toBe(false);
    expect(deepseekCompletion).not.toHaveBeenCalled();
    expect((await health()).get("memory_curation")).toMatchObject({ consecutiveFailures: 1, lastFailureReason: "empty_response" });
  });
});

describe("the warning an operator is shown", () => {
  const base = { messageCount: 40, consolidatedCount: 40, consolidationInterval: 10 };

  it("says nothing at all about a healthy story", () => {
    // A panel that always shows a warning is a panel nobody reads.
    expect(memoryWarning({ ...base, health: undefined })).toBeNull();
    expect(memoryWarning({
      ...base,
      health: { task: "memory_consolidation", lastSuccessAt: new Date().toISOString(), lastSuccessModel: "deepseek-v4-flash", lastSuccessCandidate: "direct_deepseek", lastFailureAt: null, lastFailureModel: "", lastFailureCandidate: null, lastFailureReason: "", consecutiveFailures: 0, lastSuccessUsedFallback: false },
    })).toBeNull();
  });

  it("warns on the first failure and escalates on a streak", () => {
    const failing = (consecutiveFailures: number) => memoryWarning({
      ...base,
      health: { task: "memory_consolidation" as const, lastSuccessAt: null, lastSuccessModel: "", lastSuccessCandidate: null, lastFailureAt: new Date().toISOString(), lastFailureModel: "ling-3.0-flash", lastFailureCandidate: "ling_3_flash", lastFailureReason: "empty_response", consecutiveFailures, lastSuccessUsedFallback: false },
    });
    expect(failing(1)).toContain("last memory extraction failed");
    expect(failing(1)).toContain("empty_response");
    expect(failing(4)).toContain("failed 4 times in a row");
    expect(failing(4)).toContain("not gaining new memories");
  });

  it("catches the silent case: a story that grows while nothing is consolidated", () => {
    /*
     * The failure that started all this was quiet, not loud. Nothing had to be
     * recorded for a conversation to end up with no memories — it was enough
     * that the job kept not producing any while the story kept growing.
     */
    expect(memoryWarning({ messageCount: 60, consolidatedCount: 0, consolidationInterval: 10, health: undefined }))
      .toContain("60 messages have not been consolidated");
    // But a young story that simply has not reached its interval is not a fault.
    expect(memoryWarning({ messageCount: 12, consolidatedCount: 0, consolidationInterval: 10, health: undefined })).toBeNull();
  });
});
