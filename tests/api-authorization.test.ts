import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level authorisation.
 *
 * These run against the in-memory database, so they verify the explicit
 * ownership predicates the routes carry rather than the policies (which
 * tenancy.test.ts covers against a real PostgreSQL). The two layers are meant
 * to fail independently, and this is the half that survives a policy mistake.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";

let account: { id: string; email: string | null } | null = null;
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

const { ensureSchema, pool, query, setPoolForTesting } = await import("@/lib/db");
const chat = await import("@/app/api/chat/route");
const characters = await import("@/app/api/characters/route");
const characterDetail = await import("@/app/api/characters/[id]/route");
const discovery = await import("@/app/api/discovery/route");
const conversations = await import("@/app/api/conversations/route");
const memories = await import("@/app/api/memories/route");
const consolidate = await import("@/app/api/memories/consolidate/route");
const sceneState = await import("@/app/api/scene-state/route");
const backup = await import("@/app/api/backup/route");
const usage = await import("@/app/api/usage/route");

const aliceCharacter = "aaaaaaaa-0000-4000-8000-000000000001";
const alicePublic = "aaaaaaaa-0000-4000-8000-000000000002";
const aliceConversation = "cccccccc-0000-4000-8000-000000000001";

function post(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(async () => {
  process.env.AFTERGLOW_ADMIN_USER_IDS=alice;
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  // The usage ledger buckets by day; pg-mem ships very few native functions.
  memoryDb.public.registerFunction({
    name: "date_trunc",
    args: [DataType.text, DataType.timestamptz],
    returns: DataType.timestamptz,
    implementation: (unit: string, value: Date) => {
      const truncated = new Date(value);
      if (unit === "day") truncated.setHours(0, 0, 0, 0);
      return truncated;
    },
  });
  memoryDb.public.registerFunction({
    name:"left",args:[DataType.text,DataType.integer],returns:DataType.text,
    implementation:(value:string,length:number)=>value.slice(0,length),
  });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  streamCompletion.mockReset();
  completionWithUsage.mockReset();
  account = null;

  await query("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Alice Private',$3,'private'),($2,'Alice Public',$3,'public')", [aliceCharacter, alicePublic, alice]);
  await query("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Alice chat')", [aliceConversation, aliceCharacter, alice]);
  await query("INSERT INTO messages (id,conversation_id,user_id,role,content,generation_started_at) VALUES ($4,$1,$2,'user','Private words',now())", [aliceConversation, alice, null, crypto.randomUUID()]);
  await query("INSERT INTO memories (id,character_id,conversation_id,user_id,content) VALUES ($4,$1,$2,$3,'Alice memory')", [aliceCharacter, aliceConversation, alice, crypto.randomUUID()]);
  await query("INSERT INTO usage_events (id,user_id,model,usage_type,estimated_cost_usd) VALUES ($2,$1,'deepseek-v4-flash','chat',2.5)", [alice, crypto.randomUUID()]);
});

describe("unauthenticated access", () => {
  it("refuses every private endpoint", async () => {
    const responses = await Promise.all([
      characters.GET(new Request("http://test/api/characters")),
      conversations.GET(new Request("http://test/api/conversations?characterId=" + aliceCharacter)),
      memories.GET(new Request("http://test/api/memories?characterId=" + aliceCharacter)),
      backup.GET(),
      usage.GET(),
      chat.POST(post("http://test/api/chat", { conversationId: aliceConversation, content: "hi", action: "send" })),
    ]);
    for (const response of responses) expect(response.status).toBe(401);
  });

  it("never reaches the model provider", async () => {
    await chat.POST(post("http://test/api/chat", { conversationId: aliceConversation, content: "hi", action: "send" }));
    expect(streamCompletion).not.toHaveBeenCalled();
  });
});

describe("cross-account access", () => {
  it("creates an isolated conversation branch through the selected message", async () => {
    account = { id: alice, email: null };
    const sourceMessage = await query("SELECT id FROM messages WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 1",[aliceConversation]);
    const response = await conversations.POST(post("http://test/api/conversations",{
      branchFromConversationId:aliceConversation,
      branchFromMessageId:String(sourceMessage.rows[0].id),
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.conversation.id).not.toBe(aliceConversation);
    expect(body.conversation.title).toContain("Branch");
    expect(body.messages.map((message:{content:string})=>message.content)).toEqual(["Private words"]);
    expect(Number((await query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1",[aliceConversation])).rows[0].count)).toBe(1);
  });

  it("makes a retried branch request idempotent", async () => {
    account = { id: alice, email: null };
    const sourceMessage = await query("SELECT id FROM messages WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 1",[aliceConversation]);
    const branchRequestId=crypto.randomUUID();
    const requestBody={branchFromConversationId:aliceConversation,branchFromMessageId:String(sourceMessage.rows[0].id),branchRequestId};
    const first=await (await conversations.POST(post("http://test/api/conversations",requestBody))).json();
    const retry=await (await conversations.POST(post("http://test/api/conversations",requestBody))).json();
    expect(retry.conversation.id).toBe(first.conversation.id);
    expect(Number((await query("SELECT COUNT(*) count FROM conversations WHERE user_id=$1 AND branch_request_id=$2",[alice,branchRequestId])).rows[0].count)).toBe(1);
    const ledger=await (await usage.GET()).json();
    expect(ledger.userMessages).toBe(1);
  });

  it("counts only user-authored events that reach generation", async () => {
    account={id:alice,email:null};
    streamCompletion.mockRejectedValueOnce(new Error("provider unavailable"));
    const failed=await chat.POST(post("http://test/api/chat",{conversationId:aliceConversation,content:"This never reached generation",action:"send"}));
    expect(failed.status).toBe(502);
    expect((await (await usage.GET()).json()).userMessages).toBe(1);

    const encoder=new TextEncoder();
    streamCompletion.mockResolvedValueOnce(new ReadableStream({start(controller){
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({choices:[{delta:{content:"Generated reply"}}]})}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    }}));
    const generated=await chat.POST(post("http://test/api/chat",{conversationId:aliceConversation,content:"This reaches generation",action:"send"}));
    expect(generated.status).toBe(200);
    await generated.text();
    expect((await (await usage.GET()).json()).userMessages).toBe(2);
  });

  it("lists only the caller's complete chat index", async () => {
    account = { id: bob, email: null };
    const bobView = await (await conversations.GET(new Request("http://test/api/conversations?scope=all"))).json();
    expect(bobView.conversations).toEqual([]);

    account = { id: alice, email: null };
    const aliceView = await (await conversations.GET(new Request("http://test/api/conversations?scope=all"))).json();
    expect(aliceView.conversations.map((item: { id: string }) => item.id)).toContain(aliceConversation);
  });

  it("rejects a conversation id belonging to another account before spending tokens", async () => {
    account = { id: bob, email: "bob@example.com" };
    const response = await chat.POST(post("http://test/api/chat", { conversationId: aliceConversation, content: "hi", action: "send" }));
    expect(response.status).toBe(404);
    expect(streamCompletion).not.toHaveBeenCalled();
    // The rejected request must not have written a message either.
    const stored = await query("SELECT COUNT(*)::int count FROM messages WHERE conversation_id=$1", [aliceConversation]);
    expect(Number(stored.rows[0].count)).toBe(1);
  });

  it("does not list another account's characters", async () => {
    account = { id: bob, email: null };
    const response = await characters.GET(new Request("http://test/api/characters"));
    const body = await response.json();
    expect(body.characters).toEqual([]);
  });

  it("keeps memory diagnostics behind the admin boundary", async () => {
    account = { id: bob, email: null };
    const response = await memories.GET(new Request(`http://test/api/memories?characterId=${aliceCharacter}&conversationId=${aliceConversation}`));
    expect(response.status).toBe(403);
    const protectedWrites=await Promise.all([
      memories.PATCH(post("http://test/api/memories",{})),
      memories.DELETE(new Request("http://test/api/memories?id="+crypto.randomUUID(),{method:"DELETE"})),
      consolidate.POST(post("http://test/api/memories/consolidate",{conversationId:aliceConversation})),
    ]);
    expect(protectedWrites.map((item)=>item.status)).toEqual([403,403,403]);
    account = { id: alice, email: null };
    const own=await memories.GET(new Request(`http://test/api/memories?characterId=${aliceCharacter}&conversationId=${aliceConversation}`));
    expect(own.status).toBe(200);
    expect((await own.json()).memories).toHaveLength(1);
  });

  it("keeps scene state admin-only, account-scoped, and never user-facing", async () => {
    account = { id: bob, email: null };
    const denied = await Promise.all([
      sceneState.GET(new Request(`http://test/api/scene-state?conversationId=${aliceConversation}`)),
      sceneState.POST(post("http://test/api/scene-state",{conversationId:aliceConversation})),
    ]);
    expect(denied.map((item)=>item.status)).toEqual([403,403]);

    // Administrator or not, another account's conversation resolves to nothing.
    process.env.AFTERGLOW_ADMIN_USER_IDS=`${alice},${bob}`;
    const foreign = await sceneState.GET(new Request(`http://test/api/scene-state?conversationId=${aliceConversation}`));
    expect(foreign.status).toBe(404);
    process.env.AFTERGLOW_ADMIN_USER_IDS=alice;

    account = { id: alice, email: null };
    const own = await sceneState.GET(new Request(`http://test/api/scene-state?conversationId=${aliceConversation}`));
    expect(own.status).toBe(200);
    const body = await own.json();
    expect(body.enabled).toBe(false);
    expect(body.current).toBeNull();
    expect(body.history).toEqual([]);
    // A disabled account cannot spend tokens on an extraction either.
    expect((await sceneState.POST(post("http://test/api/scene-state",{conversationId:aliceConversation}))).status).toBe(409);
  });

  it("refuses to hang a memory off another account's conversation", async () => {
    account = { id: bob, email: null };
    const response = await memories.POST(post("http://test/api/memories", { characterId: alicePublic, conversationId: aliceConversation, content: "injected" }));
    expect(response.status).toBe(403);
  });

  it("keeps the usage ledger admin-only and account-scoped", async () => {
    account = { id: bob, email: null };
    expect((await usage.GET()).status).toBe(403);

    account = { id: alice, email: null };
    const own = await (await usage.GET()).json();
    expect(own.usage.requests).toBe(1);
  });

  it("scopes the backup export to the caller", async () => {
    account = { id: bob, email: null };
    const empty = await (await backup.GET()).json();
    expect(empty.characters).toEqual([]);
    expect(empty.conversations).toEqual([]);
    expect(empty.messages).toEqual([]);

    account = { id: alice, email: null };
    const mine = await (await backup.GET()).json();
    expect(mine.characters).toHaveLength(2);
    expect(mine.messages).toHaveLength(1);
  });
});

describe("public characters", () => {
  it("exposes only a readable character page and viewer-owned aggregates", async () => {
    const privateWorld=crypto.randomUUID();
    await query("INSERT INTO worlds (id,user_id,name,content,visibility) VALUES ($1,$2,'Private world','Creator-only canon','private')",[privateWorld,alice]);
    await query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)",[alicePublic,privateWorld]);
    await query("UPDATE characters SET source_material='Creator-only notes' WHERE id=$1",[alicePublic]);

    account={id:bob,email:null};
    const response=await characterDetail.GET(new Request(`http://test/api/characters/${alicePublic}`),{params:Promise.resolve({id:alicePublic})});
    expect(response.status).toBe(200);
    const body=await response.json();
    expect(body.character).toMatchObject({id:alicePublic,ownedByViewer:false,sourceMaterial:""});
    expect(body.worlds).toEqual([]);
    expect(body.viewerMessageCount).toBe(0);
    expect(body).not.toHaveProperty("conversations");

    const hidden=await characterDetail.GET(new Request(`http://test/api/characters/${aliceCharacter}`),{params:Promise.resolve({id:aliceCharacter})});
    expect(hidden.status).toBe(404);
  });

  it("enforces owner-only character mutation at the route boundary", async () => {
    const editable={
      name:"Owner renamed",profileType:"single",tagline:"A real tagline",avatarUrl:"",avatarPath:"",accent:"#e879a9",
      backstory:"",cast:[],lorebook:"",personality:"",scenario:"",greeting:"",alternateGreetings:[],exampleDialogue:"",
      responseDirective:"",boundaries:"",sourceMaterial:"",worldIds:[],visibility:"public",nsfwEnabled:false,
    };
    account={id:bob,email:null};
    const denied=await characterDetail.PATCH(post(`http://test/api/characters/${alicePublic}`,editable),{params:Promise.resolve({id:alicePublic})});
    expect(denied.status).toBe(404);
    expect(String((await query("SELECT name FROM characters WHERE id=$1",[alicePublic])).rows[0].name)).toBe("Alice Public");

    account={id:alice,email:null};
    const accepted=await characterDetail.PATCH(post(`http://test/api/characters/${alicePublic}`,editable),{params:Promise.resolve({id:alicePublic})});
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).character).toMatchObject({name:"Owner renamed",tagline:"A real tagline"});
  });

  it("stores every opening as an instantly selectable first-message variant", async () => {
    await query("UPDATE characters SET greeting='Opening one',alternate_greetings=$2::jsonb WHERE id=$1", [alicePublic, JSON.stringify(["Opening two","Opening three"])]);
    account = { id: bob, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: alicePublic }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.messages[0]).toMatchObject({ content: "Opening one", variants: ["Opening one","Opening two","Opening three"], selectedVariant: 0 });
  });

  it("lets another account start a chat that stays private", async () => {
    account = { id: bob, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: alicePublic }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.conversation).toMatchObject({ providerId:"deepseek",modelId:"deepseek-v4-flash",rpEngineId:"immersive" });

    const owner = await query("SELECT user_id, character_snapshot FROM conversations WHERE id=$1", [body.conversation.id]);
    expect(String(owner.rows[0].user_id)).toBe(bob);
    // Somebody else's character is frozen at the definition the chat started from.
    expect(owner.rows[0].character_snapshot).toBeTruthy();
    const recentCharacters = await (await characters.GET(new Request("http://test/api/characters?scope=chats"))).json();
    expect(recentCharacters.characters.some((item: {id:string;ownedByViewer:boolean})=>item.id===alicePublic&&!item.ownedByViewer)).toBe(true);

    account = { id: alice, email: null };
    const aliceView = await conversations.GET(new Request(`http://test/api/conversations?characterId=${alicePublic}`));
    const aliceBody = await aliceView.json();
    expect(aliceBody.conversations.every((item: { id: string }) => item.id !== body.conversation.id)).toBe(true);
  });

  it("does not expose the creator's import source material to other accounts", async () => {
    await query("UPDATE characters SET source_material='Private production notes' WHERE id=$1", [alicePublic]);
    account = { id: bob, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: alicePublic }));
    const body = await response.json();
    const stored = await query("SELECT character_snapshot FROM conversations WHERE id=$1", [body.conversation.id]);
    expect(JSON.stringify(stored.rows[0].character_snapshot)).not.toContain("Private production notes");

    const listed = await (await discovery.GET(new Request("http://test/api/discovery"))).json();
    expect(listed.creations).toHaveLength(1);
    expect(listed.creations[0].ownedByViewer).toBe(false);
    // The discovery summary has no source material to expose in the first place.
    expect(listed.creations[0]).not.toHaveProperty("sourceMaterial");
    expect(JSON.stringify(listed.creations)).not.toContain("Private production notes");
  });

  it("refuses to start a chat from a character that is private to somebody else", async () => {
    account = { id: bob, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: aliceCharacter }));
    expect(response.status).toBe(404);
  });

  it("keeps the owner's own chat reading the live character", async () => {
    account = { id: alice, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: aliceCharacter }));
    const body = await response.json();
    const stored = await query("SELECT character_snapshot FROM conversations WHERE id=$1", [body.conversation.id]);
    expect(stored.rows[0].character_snapshot).toBeNull();
  });
});

/**
 * Your Creations.
 *
 * The owner management list is the one place a creator's private work is
 * listed, so it has two jobs that pull in opposite directions: show them
 * everything they own, and show them nothing of anybody else's. It also has to
 * stay lean — a page of cards must not carry a page of hidden definitions.
 */
describe("owner management list", () => {
  const bobCharacter = "bbbbbbbb-0000-4000-8000-000000000001";

  async function manage() {
    const response = await characters.GET(new Request("http://test/api/characters?scope=manage"));
    const body = await response.json() as { creations: Array<Record<string, unknown>> };
    return { status: response.status, creations: body.creations ?? [] };
  }

  beforeEach(async () => {
    await query(
      `UPDATE characters SET title='Alice Public',creation_type='scenario',profile_type='ensemble',
         tagline='The heroes are running out of options.',greeting='A sealed file on the table.',
         personality='Grim.',backstory='The war approaches.',response_directive='Narrate only.',
         boundaries='No minors.',source_material='Private production notes',nsfw_enabled=true
       WHERE id=$1`,
      [alicePublic],
    );
    await query(
      "INSERT INTO characters (id,name,title,user_id,visibility,creation_type) VALUES ($1,'Bob Public','Bob Public',$2,'public','character')",
      [bobCharacter, bob],
    );
  });

  it("requires an account", async () => {
    account = null;
    expect((await manage()).status).toBe(401);
  });

  it("lists everything the caller owns, whatever its visibility", async () => {
    account = { id: alice, email: null };
    const { creations } = await manage();
    expect(creations.map((creation) => creation.id).sort()).toEqual([aliceCharacter, alicePublic].sort());
    expect(creations.map((creation) => creation.visibility).sort()).toEqual(["private", "public"]);
  });

  it("never lists another account's creation, published or not", async () => {
    account = { id: alice, email: null };
    expect((await manage()).creations.map((creation) => creation.id)).not.toContain(bobCharacter);
    account = { id: bob, email: null };
    const { creations } = await manage();
    expect(creations.map((creation) => creation.id)).toEqual([bobCharacter]);
  });

  it("carries the state an owner manages by, and the structure of each creation", async () => {
    account = { id: alice, email: null };
    const card = (await manage()).creations.find((creation) => creation.id === alicePublic)!;
    expect(card.visibility).toBe("public");
    expect(card.creationType).toBe("scenario");
    expect(card.nsfwEnabled).toBe(true);
    expect(card.ownedByViewer).toBe(true);
    expect(typeof card.updatedAt).toBe("string");
  });

  it("does not ship the hidden definition to a page of cards", async () => {
    account = { id: alice, email: null };
    const { creations } = await manage();
    for (const field of ["greeting", "personality", "backstory", "responseDirective", "boundaries", "sourceMaterial", "cast", "description"]) {
      expect(creations[0]).not.toHaveProperty(field);
    }
    expect(JSON.stringify(creations)).not.toContain("Private production notes");
    expect(JSON.stringify(creations)).not.toContain("Narrate only.");
  });

  it("answers the whole list in one statement", async () => {
    account = { id: alice, email: null };
    const statements: string[] = [];
    const client = pool();
    const original = client.query.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).query = (text: any, ...rest: any[]) => {
      if (typeof text === "string" && /FROM characters/i.test(text)) statements.push(text);
      return original(text, ...rest);
    };
    try {
      await manage();
      expect(statements).toHaveLength(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = original;
    }
  });

  it("refuses to edit or delete a creation the caller does not own", async () => {
    account = { id: bob, email: null };
    const edited = await characterDetail.PATCH(
      new Request(`http://test/api/characters/${alicePublic}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hijacked", title: "Hijacked", visibility: "public" }),
      }),
      { params: Promise.resolve({ id: alicePublic }) },
    );
    expect(edited.status).toBe(404);

    const deleted = await characterDetail.DELETE(
      new Request(`http://test/api/characters/${alicePublic}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: alicePublic }) },
    );
    expect(deleted.status).toBe(404);

    // Untouched, and still Alice's.
    const row = await query("SELECT name,user_id FROM characters WHERE id=$1", [alicePublic]);
    expect(row.rows[0].name).toBe("Alice Public");
    expect(String(row.rows[0].user_id)).toBe(alice);
  });

  it("lets the owner delete their own creation", async () => {
    account = { id: alice, email: null };
    const deleted = await characterDetail.DELETE(
      new Request(`http://test/api/characters/${aliceCharacter}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: aliceCharacter }) },
    );
    expect(deleted.status).toBe(200);
    expect(Number((await query("SELECT COUNT(*) count FROM characters WHERE id=$1", [aliceCharacter])).rows[0].count)).toBe(0);
  });

  it("does not let another account read the edit payload for a creation they do not own", async () => {
    account = { id: bob, email: null };
    const response = await characterDetail.GET(
      new Request(`http://test/api/characters/${alicePublic}`),
      { params: Promise.resolve({ id: alicePublic }) },
    );
    const body = await response.json();
    expect(body.owner).toBe(false);
    // Readable because it is published — but as a public creation, not as a
    // definition anybody could edit or copy wholesale.
    expect(body.character.responseDirective).toBe("");
    expect(body.character.boundaries).toBe("");
    expect(body.character.sourceMaterial).toBe("");
  });
});
