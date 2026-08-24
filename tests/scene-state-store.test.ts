import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scene State against a database.
 *
 * The extraction model is stubbed so the lineage rules — provisional replies,
 * regeneration, branching, edits and failure — are asserted exactly rather
 * than sampled. What the real model is asked for is covered by the pure suite.
 */

const completionWithUsage = vi.fn();

vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(),
  completionWithUsage: (...args: unknown[]) => completionWithUsage(...args),
  parseJson: (value: string) => JSON.parse(value),
}));

const { asUser, ensureSchema, memoryFromRow, query, setPoolForTesting } = await import("@/lib/db");
const { invalidateDerivedContinuity, maybeConsolidate } = await import("@/lib/memory");
const { copySceneStatesForBranch, currentSceneState, dropSceneStateForMessage, maybeUpdateSceneState, sceneSpanBetween, sceneStampAt } = await import("@/lib/scene-state-store");
const { locationLabel } = await import("@/lib/scene-state");

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

/** One extraction reply. Anything omitted means "no evidence", as in production. */
function sceneReply(update: Record<string, unknown>) {
  completionWithUsage.mockResolvedValueOnce({
    content: JSON.stringify(update),
    usage: { prompt_tokens: 1800, completion_tokens: 120 },
  });
}

async function seedChat(userId = owner) {
  const characterId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await query("INSERT INTO characters (id,user_id,name,scenario) VALUES ($1,$2,'Maya','An evening in.')", [characterId, userId]);
  await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Story')", [conversationId, userId, characterId]);
  return { characterId, conversationId };
}

let clock = 0;
async function addMessage(conversationId: string, role: "user" | "assistant", content: string, userId = owner) {
  const id = crypto.randomUUID();
  clock += 1;
  await query(
    "INSERT INTO messages (id,conversation_id,user_id,role,content,variants,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)",
    [id, conversationId, userId, role, content, JSON.stringify(role === "assistant" ? [content] : []), new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString()],
  );
  await query("UPDATE conversations SET message_count=message_count+1 WHERE id=$1", [conversationId]);
  return id;
}

function currentScene(conversationId: string, userId = owner) {
  return asUser(userId, (client) => currentSceneState(client, userId, conversationId));
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  completionWithUsage.mockReset();
  clock = 0;
  vi.stubEnv("SCENE_STATE_ENABLED", "true");
  vi.stubEnv("SCENE_STATE_USER_IDS", owner);
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("scene state persistence", () => {
  it("starts unknown and fills in as the story establishes things", async () => {
    const { conversationId } = await seedChat();
    expect(await currentScene(conversationId)).toBeNull();

    await addMessage(conversationId, "assistant", "*Maya opens the door to her apartment.*");
    await addMessage(conversationId, "user", "I follow her in and drop onto the couch.");
    sceneReply({
      location: { place: "Maya's apartment", sub: "living room", confidence: "stated" },
      time_of_day: "evening",
      present: ["Maya", "You"],
      active_situation: ["They have just arrived."],
    });
    expect(await maybeUpdateSceneState(owner, conversationId)).toBe(true);

    const state = await currentScene(conversationId);
    expect(locationLabel(state!.location)).toBe("Maya's apartment — living room");
    expect(state!.presentCharacters).toEqual(["Maya", "You"]);
    expect(state!.storyDay).toBe(1);
    expect(state!.dateKind).toBe("unknown");
    expect(state!.throughMessageCount).toBe(2);
    // A state read through a user message is settled; only a reply is replaceable.
    expect(state!.provisional).toBe(false);
  });

  it("does nothing at all for an account the flag does not cover", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "Hello.");
    vi.stubEnv("SCENE_STATE_USER_IDS", other);
    expect(await maybeUpdateSceneState(owner, conversationId)).toBe(false);
    expect(completionWithUsage).not.toHaveBeenCalled();
    expect(await currentScene(conversationId)).toBeNull();
  });

  it("accounts for its own inference separately from the reply", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "We stay in tonight.");
    sceneReply({ location: { place: "the flat", sub: "", confidence: "stated" } });
    await maybeUpdateSceneState(owner, conversationId);
    const usage = await query("SELECT * FROM usage_events WHERE user_id=$1", [owner]);
    expect(usage.rowCount).toBe(1);
    expect(usage.rows[0].usage_type).toBe("scene_state");
    expect(usage.rows[0].task_route).toBe("scene_state_update");
    expect(Number(usage.rows[0].prompt_tokens)).toBe(1800);
  });

  it("I — a regenerated reply replaces the scene the discarded one left", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "Is Sera still here?");
    sceneReply({ location: { place: "the workshop", sub: "", confidence: "stated" }, present: ["Sera", "You"] });
    await maybeUpdateSceneState(owner, conversationId);

    // Generation A: Sera leaves.
    const replyId = await addMessage(conversationId, "assistant", "*Sera picks up her coat and walks out.*");
    sceneReply({ present: ["You"], active_situation: ["Sera has left."] });
    await maybeUpdateSceneState(owner, conversationId);
    expect((await currentScene(conversationId))!.presentCharacters).toEqual(["You"]);
    expect((await currentScene(conversationId))!.provisional).toBe(true);

    // The user regenerates: the chat route drops the state read out of A, and
    // the replacement text is written over the same message row.
    await asUser(owner, (client) => dropSceneStateForMessage(client, conversationId, replyId, owner));
    await query("UPDATE messages SET content=$1 WHERE id=$2", ["*Sera stays where she is, watching you.*", replyId]);
    expect((await currentScene(conversationId))!.presentCharacters).toEqual(["Sera", "You"]);

    sceneReply({ present: ["Sera", "You"] });
    await maybeUpdateSceneState(owner, conversationId);
    const settled = await currentScene(conversationId);
    expect(settled!.presentCharacters).toEqual(["Sera", "You"]);
    expect(settled!.activeSituation).not.toContain("Sera has left.");
  });

  it("I — ignores a state whose reply was rewritten even if cleanup never ran", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "Where are we?");
    sceneReply({ location: { place: "the hotel lobby", sub: "", confidence: "stated" } });
    await maybeUpdateSceneState(owner, conversationId);
    const replyId = await addMessage(conversationId, "assistant", "*She leads you out to the car.*");
    sceneReply({ location: { place: "the car", sub: "", confidence: "stated" } });
    await maybeUpdateSceneState(owner, conversationId);
    expect((await currentScene(conversationId))!.location.place).toBe("the car");

    await query("UPDATE messages SET content=$1 WHERE id=$2", ["*She stays in the lobby.*", replyId]);
    expect((await currentScene(conversationId))!.location.place).toBe("the hotel lobby");
  });

  it("J — a branch never inherits a location from the future it abandoned", async () => {
    const { characterId, conversationId } = await seedChat();
    const branchPoint = await addMessage(conversationId, "user", "Let's stay in Paris for now.");
    sceneReply({ location: { place: "Paris", sub: "the apartment", confidence: "stated" } });
    await maybeUpdateSceneState(owner, conversationId);
    await addMessage(conversationId, "assistant", "*Weeks later, the train pulls into London.*");
    sceneReply({ location: { place: "London", sub: "", confidence: "stated" }, day_advance: 14, day_advance_evidence: "Weeks later" });
    await maybeUpdateSceneState(owner, conversationId);
    expect((await currentScene(conversationId))!.location.place).toBe("London");

    const branchId = crypto.randomUUID();
    const messageMap = new Map([[branchPoint, crypto.randomUUID()]]);
    await query("INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Branch',1)", [branchId, owner, characterId]);
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user','Let''s stay in Paris for now.')", [messageMap.get(branchPoint), branchId, owner]);
    await asUser(owner, (client) => copySceneStatesForBranch(client, {
      userId: owner, sourceConversationId: conversationId, conversationId: branchId, position: 1, messageMap,
    }));

    const branched = await currentScene(branchId);
    expect(branched!.location.place).toBe("Paris");
    expect(branched!.storyDay).toBe(1);
    // The original timeline is untouched by the branch.
    expect((await currentScene(conversationId))!.location.place).toBe("London");
  });

  it("K — an edit that undoes a move takes the moved-to scene with it", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "We are staying in Paris.");
    sceneReply({ location: { place: "Paris", sub: "", confidence: "stated" } });
    await maybeUpdateSceneState(owner, conversationId);
    await addMessage(conversationId, "user", "We leave Paris and move to Rome.");
    sceneReply({ location: { place: "Rome", sub: "", confidence: "stated" } });
    await maybeUpdateSceneState(owner, conversationId);
    expect((await currentScene(conversationId))!.location.place).toBe("Rome");

    // The user rewrites the second message: everything derived after position 1
    // is no longer part of this story.
    await query("UPDATE messages SET content=$1 WHERE conversation_id=$2 AND content LIKE 'We leave Paris%'", ["We decide to stay in Paris after all.", conversationId]);
    await asUser(owner, (client) => invalidateDerivedContinuity(client, conversationId, 1, owner));

    const rebuilt = await currentScene(conversationId);
    expect(rebuilt!.location.place).toBe("Paris");
    const rows = await query("SELECT COUNT(*)::int count FROM conversation_scene_states WHERE conversation_id=$1", [conversationId]);
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it("N — a failed extraction leaves the last good scene in place", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "We settle in at the cabin.");
    sceneReply({ location: { place: "the cabin", sub: "", confidence: "stated" }, present: ["Maya", "You"] });
    await maybeUpdateSceneState(owner, conversationId);

    await addMessage(conversationId, "assistant", "*She lights the stove.*");
    completionWithUsage.mockRejectedValueOnce(new Error("provider unavailable"));
    expect(await maybeUpdateSceneState(owner, conversationId)).toBe(false);

    const state = await currentScene(conversationId);
    expect(state!.location.place).toBe("the cabin");
    expect(state!.presentCharacters).toEqual(["Maya", "You"]);
    const failed = await query("SELECT * FROM conversation_scene_states WHERE conversation_id=$1 AND status='failed'", [conversationId]);
    expect(failed.rowCount).toBe(1);
    expect(String(failed.rows[0].failure_reason)).toContain("provider unavailable");

    // And the next turn simply catches up.
    sceneReply({ active_situation: ["The stove is lit."] });
    expect(await maybeUpdateSceneState(owner, conversationId)).toBe(true);
    expect((await currentScene(conversationId))!.activeSituation).toEqual(["The stove is lit."]);
  });

  it("N — unparseable model output is a failure, not a corrupted scene", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "We are at the harbour.");
    sceneReply({ location: { place: "the harbour", sub: "", confidence: "stated" } });
    await maybeUpdateSceneState(owner, conversationId);
    await addMessage(conversationId, "assistant", "*Gulls scatter.*");
    completionWithUsage.mockResolvedValueOnce({ content: "I'm afraid I can't do that.", usage: null });
    expect(await maybeUpdateSceneState(owner, conversationId)).toBe(false);
    expect((await currentScene(conversationId))!.location.place).toBe("the harbour");
  });
});

describe("historical grounding on the archive", () => {
  it("stamps new memories and arcs with the scene they happened in", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "We are in the university courtyard.");
    sceneReply({ location: { place: "university courtyard", sub: "", confidence: "stated" }, time_of_day: "afternoon", present: ["Maya", "You"] });
    await maybeUpdateSceneState(owner, conversationId);
    await addMessage(conversationId, "assistant", "*Maya admits she hid the letter.*");
    sceneReply({ active_situation: ["The letter is still unexplained."] });
    await maybeUpdateSceneState(owner, conversationId);
    await addMessage(conversationId, "user", "Why would you hide it from me?");
    sceneReply({});
    await maybeUpdateSceneState(owner, conversationId);

    completionWithUsage.mockResolvedValueOnce({
      content: JSON.stringify({
        summary: "CURRENT STATE: the courtyard.",
        arcSummary: "Maya's admission about the letter.",
        arcKeywords: ["letter"],
        memories: [{ content: "Maya admitted she had hidden the letter.", kind: "event", importance: 4, keywords: ["letter"] }],
      }),
      usage: { prompt_tokens: 900, completion_tokens: 200 },
    });
    expect(await maybeConsolidate(owner, conversationId, true)).toBe(true);

    const stored = await query("SELECT * FROM memories WHERE conversation_id=$1", [conversationId]);
    const memory = memoryFromRow(stored.rows[0]);
    expect(memory.scene?.location).toBe("university courtyard");
    expect(memory.scene?.timeOfDay).toBe("afternoon");
    expect(memory.scene?.storyDay).toBe(1);
    expect(memory.scene?.present).toEqual(["Maya", "You"]);

    const arcs = await query("SELECT * FROM memory_arcs WHERE conversation_id=$1", [conversationId]);
    expect(Number(arcs.rows[0].story_day_start)).toBe(1);
    expect(arcs.rows[0].scene_locations).toEqual(["university courtyard"]);
  });

  it("reads back the scene as it stood at a past position", async () => {
    const { conversationId } = await seedChat();
    await addMessage(conversationId, "user", "We are at the station.");
    sceneReply({ location: { place: "the station", sub: "", confidence: "stated" }, time_of_day: "evening" });
    await maybeUpdateSceneState(owner, conversationId);
    await addMessage(conversationId, "user", "We drive out to the coast.");
    sceneReply({ location: { place: "the coast road", sub: "", confidence: "stated" }, day_advance: 1, day_advance_evidence: "The next morning" });
    await maybeUpdateSceneState(owner, conversationId);

    const early = await asUser(owner, (client) => sceneStampAt(client, owner, conversationId, 1));
    expect(early?.location).toBe("the station");
    expect(early?.timeOfDay).toBe("evening");
    const span = await asUser(owner, (client) => sceneSpanBetween(client, owner, conversationId, 0, 2));
    expect(span.storyDayStart).toBe(1);
    expect(span.storyDayEnd).toBe(2);
    expect(span.locations).toEqual(["the station", "the coast road"]);
  });

  it("leaves a memory unstamped rather than inventing a scene for it", async () => {
    const { conversationId } = await seedChat();
    const stamp = await asUser(owner, (client) => sceneStampAt(client, owner, conversationId, 10));
    expect(stamp).toBeNull();
  });
});
