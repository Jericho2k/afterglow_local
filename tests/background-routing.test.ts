import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHO DECIDES WHICH MODEL DOES THE BACKGROUND WORK.
 *
 * Four layers, and the whole value of the feature is that the right one wins
 * and that everybody can tell which one did. A setting that silently loses to
 * an environment variable somebody set during an incident three weeks ago
 * produces an A/B period whose result describes the wrong model.
 *
 * The other half of this suite is the invariant that has nothing to do with
 * routing: changing the setting must not touch a single stored memory.
 */

const completionWithUsage = vi.fn();

vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(),
  completionWithUsage: (...args: unknown[]) => completionWithUsage(...args),
  parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const {
  availabilityForTask, backgroundCandidate, backgroundRoute, backgroundTasks,
  candidateAvailability, clearBackgroundRouteCache, clearBackgroundRoute, setBackgroundRoute,
} = await import("@/lib/background-routing");
const { maybeConsolidate } = await import("@/lib/memory");

const owner = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  completionWithUsage.mockReset();
  clearBackgroundRouteCache();
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  vi.stubEnv("ENABLE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
});
afterEach(() => { vi.unstubAllEnvs(); clearBackgroundRouteCache(); });

describe("which layer decides", () => {
  it("ships DeepSeek for memory when nobody has chosen anything", async () => {
    const route = await backgroundRoute("memory_consolidation");
    expect(route.selection).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-flash" });
    expect(route.candidateId).toBe("direct_deepseek");
    expect(route.source).toBe("default");
  });

  it("ships Ling for the Scene Ledger when nobody has chosen anything", async () => {
    /*
     * The one job whose code default is not the incumbent, and the reason is a
     * property of the job: a tiny prompt, a tiny reply, a schema that is
     * validated and retried rather than trusted, and a previous ledger to fall
     * back to when it fails. Nothing about that is improved by a dearer model.
     */
    const route = await backgroundRoute("scene_state");
    expect(route.candidateId).toBe("ling_3_flash");
    expect(route.source).toBe("default");
  });

  it("falls back to DeepSeek for the ledger on a deployment with no OpenRouter", async () => {
    vi.stubEnv("ENABLE_OPENROUTER", "false");
    const route = await backgroundRoute("scene_state");
    expect(route.selection).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-flash" });
  });

  it("lets the environment route beat the code default", async () => {
    vi.stubEnv("MEMORY_CONSOLIDATION_MODEL_ROUTE", "openrouter:mimo-v2.5");
    const route = await backgroundRoute("memory_consolidation");
    expect(route.selection).toEqual({ providerId: "openrouter", modelId: "mimo-v2.5" });
    expect(route.source).toBe("environment");
  });

  it("lets the admin setting beat the environment route", async () => {
    // The point of the whole feature: the normal runtime control is the
    // setting, and the environment stays as the lever that still works when
    // the database does not.
    vi.stubEnv("MEMORY_CONSOLIDATION_MODEL_ROUTE", "openrouter:mimo-v2.5");
    await setBackgroundRoute("memory_consolidation", "ling_3_flash", owner);
    const route = await backgroundRoute("memory_consolidation");
    expect(route.candidateId).toBe("ling_3_flash");
    expect(route.source).toBe("admin_global");
  });

  it("lets a conversation override beat the admin setting", async () => {
    await setBackgroundRoute("memory_consolidation", "ling_3_flash", owner);
    const route = await backgroundRoute("memory_consolidation", { overrideCandidateId: "mimo_v25" });
    expect(route.candidateId).toBe("mimo_v25");
    expect(route.source).toBe("conversation_override");
  });

  it("falls through a stale setting rather than failing the job", async () => {
    /*
     * A candidate that was selectable when it was chosen and is not any more —
     * a provider disabled, a host verification withdrawn — must not be able to
     * stop a reader's memories being written. Falling through is the right
     * behaviour at 3am; refusing to STORE such a setting in the first place is
     * what stops an administrator creating one by accident.
     */
    await setBackgroundRoute("memory_consolidation", "ling_3_flash", owner);
    vi.stubEnv("ENABLE_OPENROUTER", "false");
    clearBackgroundRouteCache();
    const route = await backgroundRoute("memory_consolidation");
    expect(route.selection).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-flash" });
    expect(route.source).toBe("default");
  });

  it("falls through an unusable environment route rather than failing the job", async () => {
    vi.stubEnv("MEMORY_CONSOLIDATION_MODEL_ROUTE", "openrouter:a-model-that-does-not-exist");
    const route = await backgroundRoute("memory_consolidation");
    expect(route.selection).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-flash" });
  });

  it("refuses to store a setting that would not be honoured", async () => {
    await expect(setBackgroundRoute("memory_consolidation", "deepseek_0731_relace", owner)).rejects.toThrow(/background-route-verify/);
    await expect(setBackgroundRoute("memory_consolidation", "off", owner)).rejects.toThrow();
    await expect(setBackgroundRoute("memory_consolidation", "nonsense", owner)).rejects.toThrow();
    expect(Number((await query("SELECT COUNT(*)::int count FROM background_model_routes")).rows[0].count)).toBe(0);
  });

  it("keeps the three jobs independent", async () => {
    await setBackgroundRoute("scene_state", "off", owner);
    expect((await backgroundRoute("scene_state")).selection).toBeNull();
    // Turning the ledger off must not stop memories being extracted.
    expect((await backgroundRoute("memory_consolidation")).selection).not.toBeNull();
    expect((await backgroundRoute("memory_curation")).selection).not.toBeNull();
  });

  it("survives its own configuration table being unreadable", async () => {
    await query("DROP TABLE background_model_routes");
    clearBackgroundRouteCache();
    const route = await backgroundRoute("memory_consolidation");
    expect(route.selection).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-flash" });
  });
});

describe("the candidate field", () => {
  it("offers 'Disabled' for the Scene Ledger and for nothing else", () => {
    for (const task of backgroundTasks) {
      const off = candidateAvailability(task, backgroundCandidate("off")!);
      expect(off.selectable).toBe(task === "scene_state");
    }
  });

  it("explains every refusal in terms of something an operator can do", () => {
    vi.stubEnv("ENABLE_OPENROUTER", "false");
    for (const entry of availabilityForTask("memory_consolidation")) {
      if (entry.selectable) continue;
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });
});

/**
 * THE INVARIANT THE WHOLE SPRINT RESTS ON.
 *
 * Switching the memory model changes which model does the NEXT piece of
 * background work. It does not regenerate, re-extract, re-summarise or re-score
 * anything already stored, because a memory is a fact about a reader's story
 * rather than an output of the model that happened to phrase it — and rewriting
 * the archive on every experiment would make the archive a function of the
 * operator's curiosity.
 */
describe("changing the setting never rewrites history", () => {
  it("leaves stored memories, arcs and the rolling summary exactly as they were", async () => {
    const characterId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
    await query(
      "INSERT INTO conversations (id,user_id,character_id,title,summary,message_count,last_consolidated_count) VALUES ($1,$2,$3,'Story','An older summary written by the previous model.',0,0)",
      [conversationId, owner, characterId],
    );
    await query(
      "INSERT INTO memories (id,character_id,conversation_id,user_id,content,kind,importance) VALUES ($1,$2,$3,$4,'She inherited the boat from her father.','event',4)",
      [crypto.randomUUID(), characterId, conversationId, owner],
    );
    await query(
      "INSERT INTO memory_arcs (id,conversation_id,user_id,summary,start_message_count,end_message_count) VALUES ($1,$2,$3,'The autumn at the boatyard.',1,10)",
      [crypto.randomUUID(), conversationId, owner],
    );

    const before = {
      memories: (await query("SELECT id,content,kind,importance,created_at FROM memories WHERE user_id=$1 ORDER BY id", [owner])).rows,
      arcs: (await query("SELECT id,summary FROM memory_arcs WHERE user_id=$1 ORDER BY id", [owner])).rows,
      summary: (await query("SELECT summary FROM conversations WHERE id=$1", [conversationId])).rows[0].summary,
    };

    // Move the memory model, then move it again, then take it away entirely.
    await setBackgroundRoute("memory_consolidation", "ling_3_flash", owner);
    await setBackgroundRoute("memory_consolidation", "mimo_v25", owner);
    await clearBackgroundRoute("memory_consolidation");

    const after = {
      memories: (await query("SELECT id,content,kind,importance,created_at FROM memories WHERE user_id=$1 ORDER BY id", [owner])).rows,
      arcs: (await query("SELECT id,summary FROM memory_arcs WHERE user_id=$1 ORDER BY id", [owner])).rows,
      summary: (await query("SELECT summary FROM conversations WHERE id=$1", [conversationId])).rows[0].summary,
    };

    expect(after).toEqual(before);
    // And nothing was queued to do it later, either.
    expect(completionWithUsage).not.toHaveBeenCalled();
  });

  it("stamps the decision on the usage row so an A/B period can be identified afterwards", async () => {
    const characterId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
    await query(
      "INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Story',4)",
      [conversationId, owner, characterId],
    );
    for (let index = 0; index < 4; index += 1) {
      await query(
        "INSERT INTO messages (id,conversation_id,user_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [crypto.randomUUID(), conversationId, owner, index % 2 === 0 ? "user" : "assistant",
          `Turn ${index}. ${"word ".repeat(60)}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()],
      );
    }
    completionWithUsage.mockResolvedValueOnce({
      content: JSON.stringify({ summary: "CURRENT STATE: the jetty.", arcSummary: "", memories: [] }),
      usage: { prompt_tokens: 1800, completion_tokens: 200, prompt_cache_hit_tokens: 700 },
    });
    expect(await maybeConsolidate(owner, conversationId, true)).toBe(true);

    const row = (await query("SELECT * FROM usage_events WHERE user_id=$1 AND usage_type='memory_consolidation'", [owner])).rows[0];
    const metadata = typeof row.provider_metadata === "string" ? JSON.parse(String(row.provider_metadata)) : row.provider_metadata;
    expect(metadata.routing).toEqual({ task: "memory_consolidation", candidate: "direct_deepseek", source: "default" });
    // The facts a cost comparison needs, all on the one row.
    expect(row.model).toBe("deepseek-v4-flash");
    expect(row.actual_provider_model).toBe("deepseek-v4-flash");
    expect(Number(row.cache_hit_tokens)).toBe(700);
    expect(Number(row.completion_tokens)).toBe(200);
  });
});
