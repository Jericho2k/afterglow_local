import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Continue is not Regenerate.
 *
 * The report was that Continue produced another version of the previous reply.
 * Probing the real route showed why, and it was structural rather than a matter
 * of wording: the control cue was a bare user turn appended after the reply, so
 * the last thing the writer could see itself being asked was still the reader's
 * earlier message — and the natural completion of that is another answer to it,
 * which is an alternative version of the reply already on screen.
 *
 * These assert the three things that make the two operations different: what
 * reaches the model, what is written to the transcript, and what is left alone.
 */

const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };
const streamCompletion = vi.fn();

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", async () => {
  const errors = await vi.importActual<typeof import("@/lib/provider-errors")>("@/lib/provider-errors");
  return {
    streamCompletion: (...args: unknown[]) => streamCompletion(...args),
    completionWithUsage: vi.fn().mockResolvedValue({ content: "{}", usage: null }),
    parseJson: (value: string) => JSON.parse(value),
    ProviderError: errors.ProviderError,
  };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const chat = await import("@/app/api/chat/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";
const firstReply = "*She looks up from the map.* \"You came back.\" *Her hand stays flat on the paper.*";

function post(body: unknown) {
  return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function textStream(text: string) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}
async function events(response: Response) {
  return (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
/** The message array the provider adapter was handed. */
function sent(index = 0) {
  return streamCompletion.mock.calls[index][0] as Array<{ role: string; content: string }>;
}

/**
 * pg-mem cannot execute the data-modifying CTE the route persists replies with,
 * so a finished assistant turn is written the way the route's statement would.
 */
async function persistReply(content: string) {
  await query(
    "INSERT INTO messages (id,conversation_id,user_id,role,content,variants,selected_variant) VALUES ($1,$2,$3,'assistant',$4,$5::jsonb,0)",
    [crypto.randomUUID(), conversationId, owner, content, JSON.stringify([content])],
  );
  await query("UPDATE conversations SET message_count=message_count+1 WHERE id=$1", [conversationId]);
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  streamCompletion.mockReset();
  account = { id: owner, email: null };
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  vi.stubEnv("SCENE_STATE_ENABLED", "false");
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query("INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Story',0)", [conversationId, owner, characterId]);
  await query("INSERT INTO messages (id,conversation_id,user_id,role,content,authored_event_id) VALUES ($1,$2,$3,'user','Tell me what you found.',$1)", [crypto.randomUUID(), conversationId, owner]);
  await query("UPDATE conversations SET message_count=1 WHERE id=$1", [conversationId]);
  await persistReply(firstReply);
});

describe("what Continue sends to the writer", () => {
  it("keeps the reply being continued as the last turn of the transcript", async () => {
    streamCompletion.mockResolvedValueOnce(textStream(" *She stands.*"));
    await events(await chat.POST(post({ conversationId, content: "", action: "continue" })));

    const messages = sent();
    const cue = messages.at(-1)!;
    // The reader's own turns and the writer's replies, with the prompt layers
    // (which are system messages, wherever they sit) taken out.
    const transcript = messages.slice(0, -1).filter((message) => message.role !== "system");
    // The reply is present, and it is the newest thing in the story. When it is
    // absent the writer answers the reader's older turn again, which is exactly
    // how Continue came to behave like Regenerate.
    expect(transcript.at(-1)).toEqual({ role: "assistant", content: firstReply });
    expect(cue.role).toBe("user");
    expect(cue.content).toContain("[CONTINUE SCENE]");
  });

  it("quotes the end of that reply back as the point to continue from", async () => {
    streamCompletion.mockResolvedValueOnce(textStream(" *She stands.*"));
    await events(await chat.POST(post({ conversationId, content: "", action: "continue" })));
    const cue = sent().at(-1)!.content;
    expect(cue).toContain("Her hand stays flat on the paper.");
    expect(cue).toContain("already been delivered and read");
    expect(cue).toContain("Do not rewrite, restate, summarise, or produce an alternative version");
    expect(cue).toContain("Do not answer the user's earlier message again");
  });

  it("omits the cue entirely when there is no reply to continue from", async () => {
    // A story whose newest message is the reader's own. Telling the writer to
    // continue from a reply that is not in the transcript is the failure this
    // whole fix is about, so it is not done at all.
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content,authored_event_id) VALUES ($1,$2,$3,'user','Still there?',$1)", [crypto.randomUUID(), conversationId, owner]);
    streamCompletion.mockResolvedValueOnce(textStream("*She nods.*"));
    await events(await chat.POST(post({ conversationId, content: "", action: "continue" })));
    expect(sent().at(-1)).toEqual({ role: "user", content: "Still there?" });
    expect(sent().map((message) => message.content).join("")).not.toContain("[CONTINUE SCENE]");
  });
});

describe("what Continue writes", () => {
  it("appends a new message and leaves the previous reply exactly as it was", async () => {
    streamCompletion.mockResolvedValueOnce(textStream(" *She stands, and the map curls shut.*"));
    const done = (await events(await chat.POST(post({ conversationId, content: "", action: "continue", assistantMessageId: "dddddddd-0000-4000-8000-000000000009" }))))
      .find((event) => event.type === "done");

    // A new message, not a new variant of the old one.
    expect(done.id).toBe("dddddddd-0000-4000-8000-000000000009");
    expect(done.variants).toEqual([" *She stands, and the map curls shut.*"]);
    expect(done.selectedVariant).toBe(0);

    const rows = await query<{ role: string; content: string; variants: string[] }>(
      "SELECT role,content,variants FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC,id ASC", [conversationId],
    );
    const replies = rows.rows.filter((row) => row.role === "assistant");
    // The reply that was continued is untouched: same text, same single option.
    expect(replies[0].content).toBe(firstReply);
    expect(replies[0].variants).toEqual([firstReply]);
  });
});

describe("Regenerate keeps its own semantics", () => {
  it("replaces the latest reply as another option, and never sends the continue cue", async () => {
    streamCompletion.mockResolvedValueOnce(textStream("*She does not look up at all.*"));
    const done = (await events(await chat.POST(post({ conversationId, content: "", action: "regenerate" }))))
      .find((event) => event.type === "done");

    // Same conversational position, one more option to choose between.
    expect(done.variants).toEqual([firstReply, "*She does not look up at all.*"]);
    expect(done.selectedVariant).toBe(1);

    const messages = sent();
    // The reply being replaced is NOT in the transcript — regenerating from a
    // transcript that still contains the old answer would bias every retry.
    expect(messages.map((message) => message.content).join("")).not.toContain("Her hand stays flat on the paper.");
    expect(messages.map((message) => message.content).join("")).not.toContain("[CONTINUE SCENE]");
    expect(messages.at(-1)).toEqual({ role: "user", content: "Tell me what you found." });
  });
});
