import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The seam between Scene State and the reply itself.
 *
 * Everything else about the layer can be right while the chat route forgets to
 * hand it to the writer, or hands it over with the feature switched off, so
 * this asserts the actual system prompt the provider is called with.
 */

const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };
const streamCompletion = vi.fn();
const completionWithUsage = vi.fn();

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});

vi.mock("@/lib/deepseek", () => ({
  streamCompletion: (...args: unknown[]) => streamCompletion(...args),
  completionWithUsage: (...args: unknown[]) => completionWithUsage(...args),
  parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const chat = await import("@/app/api/chat/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";

function post(body: unknown) {
  return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** The system prompt the provider was actually called with. */
/**
 * Everything the writer was told outside the transcript.
 *
 * The per-turn continuity block is delivered as its own system message on
 * caching models — same words, later position, so the stable prefix in front of
 * it can be reused. Joining the system messages asks the question these tests
 * actually mean: what did the writer read?
 */
function systemPrompt() {
  const messages = streamCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
  return messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
}

async function reply() {
  const encoder = new TextEncoder();
  streamCompletion.mockResolvedValueOnce(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "*She looks up.*" } }] })}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  }));
  // The background scene update that follows the reply.
  completionWithUsage.mockResolvedValue({ content: "{}", usage: null });
  const response = await chat.POST(post({ conversationId, content: "Do you still think about the inheritance?", action: "send" }));
  return { status: response.status, streamed: await response.text() };
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  // The conversation title update uses left(); pg-mem ships very few functions.
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  streamCompletion.mockReset();
  completionWithUsage.mockReset();
  account = { id: owner, email: null };
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  vi.stubEnv("SCENE_STATE_ENABLED", "true");
  vi.stubEnv("SCENE_STATE_USER_IDS", owner);

  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query("INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Story',1)", [conversationId, owner, characterId]);
  await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','*Maya waits.*')", [crypto.randomUUID(), conversationId, owner]);
  await query(
    `INSERT INTO conversation_scene_states (id,conversation_id,user_id,through_message_count,story_day,time_of_day,location_place,location_sub,location_confidence,present_characters,active_situation)
     VALUES ($1,$2,$3,1,12,'late evening','Uki''s apartment','couch','stated',$4,$5)`,
    [crypto.randomUUID(), conversationId, owner, ["Uki", "You"], ["The film has not been started."]],
  );
  await query(
    `INSERT INTO memories (id,character_id,conversation_id,user_id,content,keywords,scene_story_day,scene_time_of_day,scene_location,scene_present)
     VALUES ($1,$2,$3,$4,'They talked on the couch about the inheritance.',$5,11,'afternoon','Uki''s mother''s house — couch',$6)`,
    [crypto.randomUUID(), characterId, conversationId, owner, ["inheritance", "couch"], ["Uki", "You"]],
  );
});

describe("scene state in the reply pipeline", () => {
  it("hands the writer the current scene and the history tags together", async () => {
    expect((await reply()).status).toBe(200);
    const prompt = systemPrompt();
    expect(prompt).toContain("CURRENT SCENE — THIS IS NOW");
    expect(prompt).toContain("Location: Uki's apartment — couch");
    expect(prompt).toContain("Story day: 12");
    expect(prompt).toContain("[Day 11 · afternoon · Uki's mother's house — couch]");
    expect(prompt).toContain("PAST EVENTS");
  });

  /*
   * The row above is deliberately shaped the way rows were before the Scene
   * Ledger: a broad `time_of_day`, names in `present_characters`, no
   * `present_people` and no `time_kind`. Every deployment's table is full of
   * them, so reading one correctly is not an edge case — it is the common case
   * for the first weeks after this ships.
   */
  it("reads a ledger row written before positions and time precision existed", async () => {
    expect((await reply()).status).toBe(200);
    const prompt = systemPrompt();
    // A stored broad period is read back as a period, never promoted to a
    // clock time it never had.
    expect(prompt).toContain("Time: late evening");
    // Names with no stored position render as names, not as blank parentheses.
    expect(prompt).toContain("Present: Uki, You");
    expect(prompt).not.toContain("Uki ()");
  });

  it("carries no trace of the physical simulation, even from a row that holds one", async () => {
    await query(
      `UPDATE conversation_scene_states SET physical_actors=$2::jsonb, physical_contacts=$3, active_situation=$4
       WHERE conversation_id=$1`,
      [conversationId, JSON.stringify([{ name: "Uki", posture: "seated", leftHand: "on the cushion" }]),
        ["Uki's hand on your chest"], ["The film has not been started."]],
    );
    expect((await reply()).status).toBe(200);
    const prompt = systemPrompt();
    for (const gone of ["Physical arrangement", "on the cushion", "Uki's hand on your chest", "The film has not been started.", "Active situation"]) {
      expect(prompt, `${gone} must no longer reach the writer`).not.toContain(gone);
    }
  });

  it("never leaks scene metadata into the visible reply", async () => {
    const { streamed } = await reply();
    // Every event the reader's client receives, not merely the visible text.
    expect(streamed).toContain("*She looks up.*");
    for (const field of ["CURRENT SCENE", "Story day", "story_day", "Uki's apartment", "Present:"]) {
      expect(streamed, `${field} must never reach the reader`).not.toContain(field);
    }
  });

  it("leaves the prompt exactly as it was when the layer is off", async () => {
    vi.stubEnv("SCENE_STATE_ENABLED", "false");
    expect((await reply()).status).toBe(200);
    const prompt = systemPrompt();
    expect(prompt).not.toContain("CURRENT SCENE");
    expect(prompt).not.toContain("PAST EVENTS");
    // The memory itself still reaches the writer; only its grounding is withheld.
    expect(prompt).toContain("They talked on the couch about the inheritance.");
    expect(prompt).not.toContain("[Day 11");
  });
});
