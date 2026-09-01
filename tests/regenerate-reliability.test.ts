import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tenancyDatabaseUrl } from "./helpers/tenancy";

/**
 * REGENERATE, RUN AT VOLUME AGAINST A REAL DATABASE.
 *
 * The report this suite answers is a comparison, not a single failure: "Send
 * usually works, Continue usually works, Regenerate fails almost every
 * attempt." A comparison can only be tested by running all three and looking at
 * what differs, and two of the things that differed were invisible to pg-mem —
 * one needs `SELECT … FOR UPDATE` and one needs the real `(message_id,
 * variant_index)` unique index — so this suite needs an actual PostgreSQL.
 *
 * Skipped without TEST_DATABASE_URL; CI provides one.
 *
 * WHAT IT CANNOT ANSWER. Nothing here reaches a paid provider, so it proves the
 * turn Afterglow BUILDS and the rows it WRITES, never what an upstream does
 * with them. The provider-side half of the acceptance criteria is named in the
 * sprint report as still requiring live verification.
 */
const describeReal = tenancyDatabaseUrl ? describe : describe.skip;

const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };
const streamCompletion = vi.fn();
const completionWithUsage = vi.fn();

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
/*
 * The per-account rate limit is 60 turns a minute and this suite deliberately
 * runs 80 in a few seconds. It is tested on its own in tests/rate-limit.test.ts;
 * here it would only be measuring the clock.
 */
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, checkRateLimit: () => null };
});

vi.mock("@/lib/deepseek", async () => {
  const errors = await vi.importActual<typeof import("@/lib/provider-errors")>("@/lib/provider-errors");
  return {
    streamCompletion: (...args: unknown[]) => streamCompletion(...args),
    completionWithUsage: (...args: unknown[]) => completionWithUsage(...args),
    parseJson: (value: string) => JSON.parse(value),
    ProviderError: errors.ProviderError,
  };
});

const openRouterStream = vi.fn();
vi.mock("@/lib/openrouter", async () => {
  const errors = await vi.importActual<typeof import("@/lib/provider-errors")>("@/lib/provider-errors");
  return {
    streamCompletion: (...args: unknown[]) => openRouterStream(...args),
    completionWithUsage: async () => ({ content: "{}", usage: null }),
    embed: async () => ({ embeddings: [], usage: null, model: "" }),
    providerHeadersTimeoutMs: () => 20_000,
    maxAttempts: 3,
    ProviderError: errors.ProviderError,
  };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const chat = await import("@/app/api/chat/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000041";
const conversationId = "cccccccc-0000-4000-8000-000000000041";

function post(body: unknown) {
  return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** A well-formed SSE stream carrying one reply, plus usage and [DONE]. */
function textStream(text: string, finishReason = "stop") {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "gen", choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** A database of this suite's own; siblings here rebuild the public schema. */
function probeUrl() {
  const url = new URL(tenancyDatabaseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}_regen`;
  return url.toString();
}

let pool: Pool;
let replyCounter = 0;

async function run(body: Record<string, unknown>, stream?: ReadableStream<Uint8Array>) {
  replyCounter += 1;
  streamCompletion.mockResolvedValueOnce(stream ?? textStream(`reply ${replyCounter}. She looks up and the door closes.`));
  completionWithUsage.mockResolvedValue({ content: "{}", usage: null });
  const response = await chat.POST(post({ conversationId, ...body }));
  const text = await response.text();
  const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    status: response.status,
    events,
    done: events.find((event) => event.type === "done") ?? null,
    error: events.find((event) => event.type === "error") ?? (response.status >= 400 ? JSON.parse(text) : null),
    text: events.filter((event) => event.type === "delta").map((event) => String(event.content)).join(""),
  };
}

/** The last assistant row, as the browser would see it. */
async function newestReply() {
  const result = await query<{ id: string; role: string; variants: unknown; selected_variant: number }>(
    "SELECT id,role,variants,selected_variant FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
    [conversationId],
  );
  return result.rows[0] ?? null;
}

/** The message array a mocked provider call received. */
function messagesSent(index: number) {
  return streamCompletion.mock.calls[index][0] as Array<{ role: string; content: string }>;
}

describeReal("regenerate is as reliable as send", () => {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: tenancyDatabaseUrl, max: 1, ssl: false });
    const target = new URL(probeUrl()).pathname.replace(/^\//, "");
    await admin.query(`CREATE DATABASE "${target}"`).catch((error) => {
      if (!String(error?.message ?? "").includes("already exists")) throw error;
    });
    await admin.end();
    pool = new Pool({ connectionString: probeUrl(), max: 6, ssl: false });
    setPoolForTesting(pool);
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await ensureSchema();
    /*
     * THE `authenticated` ROLE IS CLUSTER-WIDE, AND THAT MATTERS HERE.
     *
     * `asUser` probes once whether the database can assume that role, and every
     * statement afterwards runs as it. The role is created by the auth shim in
     * the isolation suites — on the same PostgreSQL cluster, because roles are
     * not per-database — so whether this suite's requests run as `postgres` or
     * as `authenticated` depends on whether one of those suites has ever run
     * against this server. That is a coin flip, and the losing side fails with
     * "relation does not exist" for tables that plainly exist, because the role
     * has no USAGE on the schema.
     *
     * So the answer is made deterministic rather than left to run order: this
     * database always has the role, and the role always has the access the real
     * migrations grant it. Policies are not part of this suite's question — the
     * isolation suites own that — and every statement in the chat route carries
     * its own `user_id` predicate regardless.
     */
    await pool.query("DO $$ BEGIN CREATE ROLE authenticated NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
    await pool.query(`
      GRANT USAGE ON SCHEMA public TO authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
    `);
  });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    /*
     * DELETE rather than TRUNCATE, and a tick to let the previous turn's
     * fire-and-forget writes land. Usage accounting and free-tier settlement
     * are deliberately off the reply's critical path, so they are still in
     * flight when the next test starts; TRUNCATE takes an exclusive lock and
     * deadlocks against them.
     */
    await new Promise((resolve) => setTimeout(resolve, 40));
    await pool.query("DELETE FROM message_generations");
    await pool.query("DELETE FROM messages");
    await pool.query("DELETE FROM conversations");
    await pool.query("DELETE FROM characters");
    streamCompletion.mockReset();
    openRouterStream.mockReset();
    completionWithUsage.mockReset();
    account = { id: owner, email: null };
    // A test that narrows ALLOWED_MODELS must not narrow it for the next one.
    vi.unstubAllEnvs();
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("SCENE_STATE_ENABLED", "false");
    await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
    await query("INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Story',1)", [conversationId, owner, characterId]);
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','*Maya waits.*')", [crypto.randomUUID(), conversationId, owner]);
  });

  /*
   * THE ACCEPTANCE RUN. 20 sends, 20 continues, 40 regenerations including
   * repeated regenerations of one reply, against a provider that behaves.
   *
   * Under a healthy provider every one of them must succeed. Anything less is
   * a defect in Afterglow rather than in an upstream, which is exactly the
   * distinction the production report could not make.
   */
  it("completes 20 sends, 20 continues and 40 regenerations without a failure", async () => {
    const failures: Array<{ action: string; index: number; error: unknown }> = [];
    const record = (action: string, index: number, result: Awaited<ReturnType<typeof run>>) => {
      if (result.status !== 200 || !result.done || result.error) failures.push({ action, index, error: result.error ?? result.status });
    };

    for (let index = 0; index < 20; index += 1) {
      record("send", index, await run({ content: `Turn ${index}.`, action: "send" }));
      // Two regenerations of the same reply, which is the case that used to
      // strand a message: both attempts computed the same variant index.
      record("regenerate", index, await run({ action: "regenerate", assistantMessageId: (await newestReply())!.id }));
      record("regenerate", index, await run({ action: "regenerate", assistantMessageId: (await newestReply())!.id }));
    }
    for (let index = 0; index < 20; index += 1) record("continue", index, await run({ action: "continue" }));

    expect(failures).toEqual([]);
    expect(streamCompletion.mock.calls.length).toBe(80);

    // Every generation left exactly one immutable provenance row, and no two
    // share a (message, variant) pair.
    const generations = await query<{ message_id: string; variant_index: number; action: string }>(
      "SELECT message_id,variant_index,action FROM message_generations", []);
    expect(generations.rowCount).toBe(80);
    const keys = generations.rows.map((row) => `${row.message_id}:${row.variant_index}`);
    expect(new Set(keys).size).toBe(80);
    expect(generations.rows.filter((row) => row.action === "regenerate").length).toBe(40);
  }, 120_000);

  it("appends a variant rather than replacing the reply", async () => {
    await run({ content: "Say something.", action: "send" });
    const first = await newestReply();
    const regenerated = await run({ action: "regenerate", assistantMessageId: first!.id });

    expect(regenerated.done?.id).toBe(first!.id);
    expect((regenerated.done?.variants as string[]).length).toBe(2);
    expect(regenerated.done?.selectedVariant).toBe(1);

    const row = await newestReply();
    expect((row!.variants as string[]).length).toBe(2);
    expect(row!.selected_variant).toBe(1);
    // The message count did not move: a regeneration is not a new message.
    const conversation = await query<{ message_count: number }>("SELECT message_count FROM conversations WHERE id=$1", [conversationId]);
    expect(conversation.rows[0].message_count).toBe(3);
  });

  /*
   * TWO REGENERATIONS OF ONE REPLY, IN FLIGHT AT THE SAME TIME.
   *
   * The old route read `variants.length` at the start of the turn and used it
   * tens of seconds later, so both attempts claimed the same index: one text
   * was overwritten and one provenance row was never written, silently, by
   * `ON CONFLICT DO NOTHING`. The allocation is now inside a locked
   * transaction, so the two serialise into variants 1 and 2.
   */
  it("serialises concurrent regenerations instead of stranding one", async () => {
    await run({ content: "Say something.", action: "send" });
    const target = (await newestReply())!.id;

    streamCompletion.mockResolvedValueOnce(textStream("Option A."));
    streamCompletion.mockResolvedValueOnce(textStream("Option B."));
    completionWithUsage.mockResolvedValue({ content: "{}", usage: null });
    const [a, b] = await Promise.all([
      chat.POST(post({ conversationId, action: "regenerate", assistantMessageId: target })).then((r) => r.text()),
      chat.POST(post({ conversationId, action: "regenerate", assistantMessageId: target })).then((r) => r.text()),
    ]);
    for (const body of [a, b]) expect(body).not.toContain("could not be saved");

    const row = await newestReply();
    const variants = row!.variants as string[];
    expect(variants.length).toBe(3);
    expect(variants).toContain("Option A.");
    expect(variants).toContain("Option B.");

    const generations = await query<{ variant_index: number }>(
      "SELECT variant_index FROM message_generations WHERE message_id=$1 ORDER BY variant_index", [target]);
    // One row per generation, and no index claimed twice.
    expect(generations.rows.map((row2) => row2.variant_index)).toEqual([0, 1, 2]);
  });

  it("refuses to regenerate a reply the story has moved past", async () => {
    await run({ content: "Say something.", action: "send" });
    const stale = (await newestReply())!.id;
    await run({ action: "continue" });

    const result = await run({ action: "regenerate", assistantMessageId: stale });
    expect(result.status).toBe(409);
    expect(String(result.error?.reason)).toBe("regenerate_target_stale");
    // And the newer reply was NOT rewritten in its place.
    const newest = await newestReply();
    expect(newest!.id).not.toBe(stale);
    expect((newest!.variants as string[]).length).toBe(1);
  });

  it("falls back to the newest reply when the browser's id never persisted", async () => {
    // A reply whose write failed leaves the browser holding an id nothing knows
    // about. That is not a conflict and must not be refused.
    await run({ content: "Say something.", action: "send" });
    const result = await run({ action: "regenerate", assistantMessageId: crypto.randomUUID() });
    expect(result.status).toBe(200);
    expect((result.done?.variants as string[]).length).toBe(2);
  });

  it("says so plainly when there is no reply to regenerate", async () => {
    await query("DELETE FROM messages WHERE conversation_id=$1", [conversationId]);
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user','Hello?')", [crypto.randomUUID(), conversationId, owner]);
    const result = await run({ action: "regenerate" });
    expect(result.status).toBe(409);
    expect(String(result.error?.reason)).toBe("regenerate_target_missing");
    expect(String(result.error?.error)).not.toContain("Something went wrong");
  });

  /*
   * THE ASYMMETRY THAT MADE REGENERATE THE EXPENSIVE ACTION.
   *
   * The anchored transcript window is quantised against the conversation's
   * absolute message count so its first token stops moving every turn, which is
   * the whole basis of provider prompt caching. Regenerate excludes its target
   * from the rows it draws from but the count still included it, so the window
   * began one message EARLIER than the send that produced the same reply — a
   * different first token, and therefore a guaranteed cache miss on every
   * single regeneration.
   *
   * That is a COST AND LATENCY regression and this test measures exactly that:
   * whether the two requests share a prefix. It is not evidence that any
   * provider refused anything, and nothing here claims it is.
   */
  it("sends the same transcript window as the send it is regenerating", async () => {
    for (let index = 0; index < 120; index += 1) {
      await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user',$4)", [crypto.randomUUID(), conversationId, owner, `user turn ${index} ${"x".repeat(200)}`]);
      await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant',$4)", [crypto.randomUUID(), conversationId, owner, `assistant turn ${index} ${"y".repeat(400)}`]);
    }
    await query("UPDATE conversations SET message_count=241 WHERE id=$1", [conversationId]);

    await run({ content: "Say something.", action: "send" });
    await run({ action: "regenerate", assistantMessageId: (await newestReply())!.id });

    const sent = messagesSent(0);
    const regenerated = messagesSent(1);
    expect(regenerated.length).toBe(sent.length);
    // Byte-identical up to the continuity block, which is what a cache reuses.
    for (let index = 0; index < sent.length - 2; index += 1) {
      expect(regenerated[index].content).toBe(sent[index].content);
      expect(regenerated[index].role).toBe(sent[index].role);
    }
  }, 60_000);

  /*
   * THE EXACT SHAPE OF THE OUTGOING REQUEST, FOR BOTH REGENERATE CASES.
   *
   * A chat API generates from a trailing USER turn. Anything else is asking it
   * for something different: a trailing assistant turn is a prefill to extend,
   * and a trailing system message is background with no turn after it. Both are
   * shapes this route produced, and both are asserted against here by role
   * order rather than by description.
   *
   * The opening greeting is an assistant message, so the fixture's transcripts
   * begin with one.
   */
  describe("the outgoing request shape", () => {
    it("ends on the reader's own turn when regenerating a reply to it", async () => {
      // greeting → user → assistant(target); the target is removed.
      await run({ content: "Say something.", action: "send" });
      await run({ action: "regenerate", assistantMessageId: (await newestReply())!.id });

      expect(messagesSent(1).map((message) => message.role)).toEqual([
        "system",     // the stable head
        "assistant",  // the greeting
        "system",     // continuity, immediately before the turn being answered
        "user",       // the reader's message — unchanged behaviour
      ]);
      // And no control cue is added: there is nothing to disambiguate.
      expect(messagesSent(1).at(-1)!.content).not.toContain("[REGENERATE]");
    });

    it("ends on an explicit control turn when regenerating a reply to a reply", async () => {
      // greeting → user → assistant → assistant(target from Continue).
      await run({ content: "Say something.", action: "send" });
      await run({ action: "continue" });
      await run({ action: "regenerate", assistantMessageId: (await newestReply())!.id });

      const sent = messagesSent(2);
      expect(sent.map((message) => message.role)).toEqual([
        "system",     // the stable head
        "assistant",  // the greeting
        "user",       // the reader's message, already answered
        "assistant",  // the reply the target continued from, still accepted
        "system",     // continuity
        "user",       // the control turn the generation is triggered from
      ]);
      const cue = sent.at(-1)!.content;
      expect(cue).toContain("[REGENERATE]");
      // It says what it is, what not to touch, and not to mention itself.
      expect(cue).toContain("control signal");
      expect(cue).toMatch(/Never mention it/i);
      expect(cue).toMatch(/Do not rewrite/i);
      // And it does not hand the writer the reply it is replacing, which is how
      // a regeneration comes back as a paraphrase of the attempt it replaces.
      expect(cue).not.toContain("reply 2");
    });

    it("never places a system message inside the transcript, in either case", async () => {
      await run({ content: "Say something.", action: "send" });
      await run({ action: "continue" });
      await run({ action: "regenerate", assistantMessageId: (await newestReply())!.id });

      for (const index of [1, 2]) {
        const sent = messagesSent(index);
        const systems = sent.map((message, at) => (message.role === "system" ? at : -1)).filter((at) => at >= 0);
        // The head, and continuity immediately before the final turn.
        expect(systems).toEqual([0, sent.length - 2]);
        expect(sent.at(-1)!.role).toBe("user");
      }
    });
  });

  /*
   * The catalogue's reasoning setting is what gets sent, and it is now sendable.
   *
   * `defaultReasoningFor` existed and was called by nothing, so a model added
   * precisely because it reasons before it speaks — a measured time-to-first-
   * token in the tens of seconds — was asked for the endpoint's default, which
   * on a hybrid reasoning model is reasoning. Those tokens come out of the same
   * output envelope as the prose, which is how a Natural reply with 1,800
   * tokens of room got cut off mid-sentence.
   *
   * Wiring it up then met the second half of the problem: Z.AI refuses
   * `{enabled:false}` outright. So GLM 5.3 Flash's declared setting is the
   * lowest effort the endpoint serves, and that is what leaves the route.
   */
  it("sends the catalogue's reasoning setting for a model that declares one", async () => {
    vi.stubEnv("ENABLE_OPENROUTER", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
    vi.stubEnv("ALLOWED_MODELS", "glm-5.3-flash,glm-4.7");
    await query("UPDATE conversations SET provider_id='openrouter',model_id='glm-5.3-flash' WHERE id=$1", [conversationId]);

    openRouterStream.mockResolvedValueOnce(textStream("A reply."));
    completionWithUsage.mockResolvedValue({ content: "{}", usage: null });
    const response = await chat.POST(post({ conversationId, content: "Say something.", action: "send" }));
    await response.text();

    const options = openRouterStream.mock.calls[0][2] as { thinking?: unknown; modelId?: string };
    // Not "off": that is the one thing this endpoint will not accept.
    expect(options.thinking).toBe("low");
    expect(options.modelId).toBe("glm-5.3-flash");

    // And a model that declares no default keeps saying nothing, which is the
    // behaviour every other conversation already has.
    openRouterStream.mockReset();
    await query("UPDATE conversations SET model_id='glm-4.7' WHERE id=$1", [conversationId]);
    openRouterStream.mockResolvedValueOnce(textStream("Another reply."));
    await (await chat.POST(post({ conversationId, content: "Again.", action: "send" }))).text();
    expect((openRouterStream.mock.calls[0][2] as { thinking?: unknown }).thinking).toBe(false);
  });

  /*
   * A STORED VARIANT WITHOUT ITS GENERATION ROW IS THE ONE STATE
   * `message_generations` EXISTS TO PREVENT.
   *
   * `recordGeneration` is `ON CONFLICT DO NOTHING`, which is right — provenance
   * is a statement about something that already happened and nothing later may
   * revise it — and used to be reported as a flag the caller merely logged. That
   * left a stored reply whose provenance row belongs to a DIFFERENT generation,
   * and an inspector confidently describing the wrong context for it.
   *
   * The conflict is provoked here by claiming the variant index out of band,
   * which is the only way to reach it now that allocation happens under a lock.
   */
  it("abandons the whole variant rather than storing one with no provenance", async () => {
    await run({ content: "Say something.", action: "send" });
    const target = (await newestReply())!;
    const before = { variants: target.variants as string[], selected: target.selected_variant, };
    expect(before.variants).toHaveLength(1);

    // Somebody else already owns (message, variant 1).
    await query(
      `INSERT INTO message_generations (id,message_id,conversation_id,user_id,variant_index,action)
       VALUES ($1,$2,$3,$4,1,'regenerate')`,
      [crypto.randomUUID(), target.id, conversationId, owner],
    );

    const blocked = await run({ action: "regenerate", assistantMessageId: target.id });
    // The reader is told, rather than being left with a reply that will vanish.
    expect(blocked.events.some((event) => event.type === "error")).toBe(true);
    expect(String(blocked.events.at(-1)?.error)).toContain("could not be saved");

    // AND THE ROW IS EXACTLY AS IT WAS. The UPDATE rolled back with the failed
    // provenance write, so nothing was half-applied.
    const after = await newestReply();
    expect(after!.id).toBe(target.id);
    expect(after!.variants).toEqual(before.variants);
    expect(after!.selected_variant).toBe(before.selected);
    const content = await query<{ content: string }>("SELECT content FROM messages WHERE id=$1", [target.id]);
    expect(content.rows[0].content).toBe(before.variants[0]);

    // And no second generation row was created beside the squatted one.
    const generations = await query<{ variant_index: number }>(
      "SELECT variant_index FROM message_generations WHERE message_id=$1 ORDER BY variant_index", [target.id]);
    expect(generations.rows.map((row) => row.variant_index)).toEqual([0, 1]);
  });

  it("holds the same invariant for a send", async () => {
    // A send writes variant 0 of a new row, so a conflict means the id was
    // reused. The message must not survive its provenance either way.
    const assistantId = crypto.randomUUID();
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user','Hello?')", [crypto.randomUUID(), conversationId, owner]);
    // Claim (assistantId, 0) before the turn runs. The foreign key needs the
    // message to exist, so it is created and removed around the claim.
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','placeholder')", [assistantId, conversationId, owner]);
    await query(
      `INSERT INTO message_generations (id,message_id,conversation_id,user_id,variant_index,action)
       VALUES ($1,$2,$3,$4,0,'send')`,
      [crypto.randomUUID(), assistantId, conversationId, owner],
    );

    const blocked = await run({ content: "Again.", action: "send", assistantMessageId: assistantId });
    expect(String(blocked.events.at(-1)?.error)).toContain("could not be saved");
    // The placeholder is untouched: the INSERT could not have succeeded anyway,
    // and nothing partially applied around it.
    const row = await query<{ content: string }>("SELECT content FROM messages WHERE id=$1", [assistantId]);
    expect(row.rows[0].content).toBe("placeholder");
  });

  it("keeps a truncated reply and says it was truncated", async () => {
    // finish_reason=length is a fact the client is entitled to. Nothing here
    // silently generates a second turn to paper over it.
    await run({ content: "Say something.", action: "send" }, textStream("A reply that ran out of room mid-", "length"));
    const events = streamCompletion.mock.calls.length;
    expect(events).toBe(1);
    const stored = await newestReply();
    expect((stored!.variants as string[])[0]).toBe("A reply that ran out of room mid-");
  });

  /*
   * WHEN THE READER IS TOLD THE REPLY IS FINISHED.
   *
   * A send announces before the write, because its variant list is already
   * known and holding the event behind two database round trips left the
   * finished reply on screen with its controls hidden — the "freeze" an earlier
   * sprint removed. A regeneration cannot: its variant index is only knowable
   * from the locked write. Both halves are asserted, because moving either one
   * silently costs something real.
   */
  it("tells the reader a send finished even when the write then fails", async () => {
    await run({ content: "Say something.", action: "send" });
    const existing = (await newestReply())!.id;
    // An id that already names a row: the INSERT cannot succeed.
    const collided = await run({ content: "Again.", action: "send", assistantMessageId: existing });

    const types = collided.events.map((event) => event.type);
    expect(types).toContain("done");
    // Announced first, then corrected — never silently swallowed.
    expect(types.indexOf("done")).toBeLessThan(types.indexOf("error"));
    expect(String(collided.events.at(-1)?.error)).toContain("could not be saved");
  });

  it("tells the reader a regeneration finished only once its variant is known", async () => {
    await run({ content: "Say something.", action: "send" });
    const target = (await newestReply())!.id;
    const regenerated = await run({ action: "regenerate", assistantMessageId: target });

    // `selectedVariant: 1` is not knowable before the locked read, so its
    // presence in the completion event IS the ordering.
    expect(regenerated.done?.selectedVariant).toBe(1);
    expect((regenerated.done?.variants as string[]).length).toBe(2);
    expect(regenerated.events.some((event) => event.type === "error")).toBe(false);
  });

  /*
   * A STREAM THAT STOPS IS NOT A GENERATION THAT FINISHED.
   *
   * The dropped-final-frame fix removed one silent truncation. This is the
   * other one: prose arrives, the transport dies, and nothing in the protocol
   * ever says the generation ended. Stored and announced as an ordinary
   * success, it is indistinguishable from a reply that finished — which is how
   * it stayed invisible.
   */
  describe("an interrupted stream", () => {
    /** Prose, then nothing: no finish reason, no [DONE], no error. */
    function abruptStream(text: string) {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "gen", choices: [{ delta: { content: text } }] })}\n\n`));
          controller.close();
        },
      });
    }

    it("keeps the partial reply and says it did not finish", async () => {
      const result = await run({ content: "Say something.", action: "send" }, abruptStream("She turns, and then—"));

      expect(result.text).toBe("She turns, and then—");
      expect(result.done).toBeTruthy();
      expect(result.done?.incomplete).toBe(true);
      expect(result.done?.interruptedBy).toBe("transport");
      // Every byte that arrived was produced and billed. Discarding it would
      // lose the reader's scene and change nothing about the cost.
      const stored = await newestReply();
      expect((stored!.variants as string[])[0]).toBe("She turns, and then—");
    });

    it("does not quietly generate a second turn to cover it", async () => {
      await run({ content: "Say something.", action: "send" }, abruptStream("Half a sentence"));
      // One provider call. The empty-reply retry exists for a stream with NO
      // prose; a partial reply is never silently doubled.
      expect(streamCompletion.mock.calls.length).toBe(1);
      const rows = await query("SELECT id FROM messages WHERE conversation_id=$1 AND role='assistant'", [conversationId]);
      // The greeting and the one partial reply.
      expect(rows.rowCount).toBe(2);
    });

    it("is not marked complete when the transport dies after an error frame", async () => {
      const encoder = new TextEncoder();
      const failing = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial." } }] })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: "upstream connection reset", code: 502 } })}\n\n`));
          controller.close();
        },
      });
      const result = await run({ content: "Say something.", action: "send" }, failing);
      expect(result.done?.incomplete).toBe(true);
      expect(result.done?.interruptedBy).toBe("upstream_error");
      expect(result.text).toBe("Partial.");
    });

    it("says nothing of the sort when the stream ended properly", async () => {
      const result = await run({ content: "Say something.", action: "send" });
      expect(result.done?.incomplete).toBeUndefined();
      expect(result.done?.interruptedBy).toBeUndefined();
    });

    it("still calls a reply that stopped at the ceiling complete, and truncated", async () => {
      // `length` IS terminal evidence: the generation ended, on purpose, at a
      // limit we set. A complete stream of an incomplete reply.
      const result = await run({ content: "Say something.", action: "send" }, textStream("Ran out of room mid-", "length"));
      expect(result.done?.truncated).toBe(true);
      expect(result.done?.incomplete).toBeUndefined();
    });
  });

  it("delivers the final sentence when the stream closes without a trailing newline", async () => {
    const encoder = new TextEncoder();
    const abrupt = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "She turns, " } }] })}\n\n`));
        // No terminator at all: the connection ends on the last frame.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "and the door closes." } }] })}`));
        controller.close();
      },
    });
    const result = await run({ content: "Say something.", action: "send" }, abrupt);
    expect(result.text).toBe("She turns, and the door closes.");
    const stored = await newestReply();
    expect((stored!.variants as string[])[0]).toBe("She turns, and the door closes.");
  });
});
