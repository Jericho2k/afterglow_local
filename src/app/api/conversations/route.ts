import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { characterSnapshot, ownedPersona, readableCharacter } from "@/lib/access";
import { asUser, characterFromRow, conversationFromRow, coreCanonFromRow, getUserSettings, memoryArcFromRow, memoryFromRow, messageForViewer, messageFromRow } from "@/lib/db";
import { currentAccount, isAdminAccount, unauthorized } from "@/lib/session";

/**
 * Starts a chat.
 *
 * The character must be one the caller owns or one its creator published;
 * anything else resolves to null and the request fails before a row is
 * written. When the character belongs to somebody else the conversation keeps
 * a frozen copy of the definition, so the creator editing or unpublishing it
 * later cannot rewrite the system prompt inside this story.
 */
async function createConversation(client: PoolClient, userId: string, characterId: string, greetingIndex = 0, personaId?: string | null) {
  const characterRow = await readableCharacter(client, userId, characterId);
  if (!characterRow) return null;
  const owned = String(characterRow.user_id ?? "") === userId;
  const character = characterFromRow({ ...characterRow, world_ids: [] }, userId);

  let resolvedPersonaId: string | null = null;
  if (personaId) {
    const persona = await ownedPersona(client, userId, personaId);
    resolvedPersonaId = persona ? String(persona.id) : null;
  }
  if (!resolvedPersonaId) {
    const defaultPersona = await client.query("SELECT id FROM personas WHERE user_id=$1 AND is_default=true LIMIT 1", [userId]);
    resolvedPersonaId = defaultPersona.rowCount ? String(defaultPersona.rows[0].id) : null;
  }

  const id = randomUUID();
  const settings = await getUserSettings(client, userId);
  let result = await client.query(
    "INSERT INTO conversations (id,character_id,user_id,title,persona_id,character_snapshot,provider_id,model_id,rp_engine_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *",
    [id, characterId, userId, `Chat with ${character.name}`, resolvedPersonaId, owned ? null : JSON.stringify(characterSnapshot(character)),settings.providerId,settings.model,settings.roleplayPreset],
  );

  const greetings = [character.greeting, ...character.alternateGreetings].map((item) => String(item || "").trim()).filter(Boolean);
  const safeIndex = Number.isInteger(greetingIndex) && greetingIndex >= 0 && greetingIndex < greetings.length ? greetingIndex : 0;
  const greeting = greetings[safeIndex] || "";
  if (greeting) {
    await client.query(
      "INSERT INTO messages (id,conversation_id,user_id,role,content,variants,selected_variant) VALUES ($1,$2,$3,'assistant',$4,$5::jsonb,$6)",
      [randomUUID(), id, userId, greeting, JSON.stringify(greetings), safeIndex],
    );
    result = await client.query("UPDATE conversations SET message_count=1 WHERE id=$1 AND user_id=$2 RETURNING *", [id, userId]);
  }
  return conversationFromRow(result.rows[0]);
}

async function branchConversation(client:PoolClient,userId:string,sourceConversationId:string,sourceMessageId:string,branchRequestId:string) {
  const prior=await client.query("SELECT * FROM conversations WHERE user_id=$1 AND branch_request_id=$2",[userId,branchRequestId]);
  if (prior.rowCount) {
    const messages=await client.query("SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC,id ASC",[prior.rows[0].id,userId]);
    return {conversation:conversationFromRow(prior.rows[0]),messages:messages.rows.map(messageFromRow)};
  }
  const source=(await client.query("SELECT * FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE",[sourceConversationId,userId])).rows[0];
  if (!source) return null;
  const target=(await client.query("SELECT id FROM messages WHERE id=$1 AND conversation_id=$2 AND user_id=$3",[sourceMessageId,sourceConversationId,userId])).rows[0];
  if (!target) return null;
  const position=Number((await client.query(
    `SELECT COUNT(*)::int position FROM messages candidate JOIN messages target ON target.id=$2 AND target.conversation_id=$1
     WHERE candidate.conversation_id=$1 AND candidate.user_id=$3 AND (candidate.created_at<target.created_at OR (candidate.created_at=target.created_at AND candidate.id::text<=target.id::text))`,
    [sourceConversationId,sourceMessageId,userId],
  )).rows[0]?.position||0);
  if (!position) return null;

  const id=randomUUID();
  const created=await client.query(
    `INSERT INTO conversations
     (id,character_id,user_id,title,summary,persona_id,character_snapshot,provider_id,model_id,rp_engine_id,instruction_presets,custom_instructions,response_length,temperature,branch_request_id,message_count,last_consolidated_count,last_curated_message_count,canon_version)
     VALUES ($1,$2,$3,$4,'',$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,0,0)
     ON CONFLICT (user_id,branch_request_id) DO NOTHING RETURNING *`,
    [id,source.character_id,userId,`${String(source.title).slice(0,105)} — Branch`,source.persona_id,source.character_snapshot?JSON.stringify(source.character_snapshot):null,source.provider_id,source.model_id,source.rp_engine_id,source.instruction_presets,source.custom_instructions,source.response_length,source.temperature,branchRequestId,position],
  );
  if (!created.rowCount) {
    const existing=(await client.query("SELECT * FROM conversations WHERE user_id=$1 AND branch_request_id=$2",[userId,branchRequestId])).rows[0];
    if (!existing) return null;
    const messages=await client.query("SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC,id ASC",[existing.id,userId]);
    return {conversation:conversationFromRow(existing),messages:messages.rows.map(messageFromRow)};
  }

  const memoryMap=new Map<string,string>();
  const sourceMemories=await client.query(
    "SELECT * FROM memories WHERE conversation_id=$1 AND user_id=$2 AND source_message_count<=$3 ORDER BY created_at ASC,id ASC",
    [sourceConversationId,userId,position],
  );
  for (const memory of sourceMemories.rows) {
    const parsed=memoryFromRow(memory);
    const memoryId=randomUUID(); memoryMap.set(String(memory.id),memoryId);
    await client.query(
      `INSERT INTO memories
       (id,character_id,conversation_id,user_id,content,kind,importance,keywords,pinned,status,resolution,resolved_at,last_recalled_at,recall_count,source_message_count,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [memoryId,memory.character_id,id,userId,memory.content,memory.kind,memory.importance,parsed.keywords,memory.pinned,memory.status,memory.resolution,memory.resolved_at,memory.last_recalled_at,memory.recall_count,memory.source_message_count,memory.created_at,memory.updated_at],
    );
  }

  const arcMap=new Map<string,string>();
  const sourceArcs=await client.query("SELECT * FROM memory_arcs WHERE conversation_id=$1 AND user_id=$2 AND end_message_count<=$3 ORDER BY created_at ASC,id ASC",[sourceConversationId,userId,position]);
  for (const arc of sourceArcs.rows) {
    const parsed=memoryArcFromRow(arc);
    const arcId=randomUUID(); arcMap.set(String(arc.id),arcId);
    await client.query(
      "INSERT INTO memory_arcs (id,conversation_id,user_id,summary,keywords,start_message_count,end_message_count,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [arcId,id,userId,arc.summary,parsed.keywords,arc.start_message_count,arc.end_message_count,arc.created_at],
    );
  }

  const sourceCanon=await client.query("SELECT * FROM core_canon_entries WHERE conversation_id=$1 AND user_id=$2 AND source_message_count<=$3 ORDER BY created_at ASC,id ASC",[sourceConversationId,userId,position]);
  for (const canon of sourceCanon.rows) {
    const parsed=coreCanonFromRow(canon);
    await client.query(
    `INSERT INTO core_canon_entries
     (id,conversation_id,character_id,user_id,content,category,importance,status,source_memory_ids,source_arc_ids,source_message_count,token_count,curation_version,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [randomUUID(),id,canon.character_id,userId,canon.content,canon.category,canon.importance,canon.status,parsed.sourceMemoryIds.map((value)=>memoryMap.get(value)||value),parsed.sourceArcIds.map((value)=>arcMap.get(value)||value),canon.source_message_count,canon.token_count,canon.curation_version,canon.created_at,canon.updated_at],
    );
  }

  const sourceMessages=await client.query("SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC,id ASC LIMIT $3",[sourceConversationId,userId,position]);
  for (const message of sourceMessages.rows) {
    const parsed=messageFromRow(message);
    await client.query(
    `INSERT INTO messages (id,conversation_id,user_id,role,content,variants,selected_variant,memory_ids,memory_arc_ids,authored_event_id,generation_started_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::uuid[],$9::uuid[],$10,$11,$12)`,
    [randomUUID(),id,userId,message.role,message.content,JSON.stringify(parsed.variants),parsed.selectedVariant,parsed.memoryIds.map((value)=>memoryMap.get(value)||value),parsed.arcIds.map((value)=>arcMap.get(value)||value),message.role==="user"?message.authored_event_id??message.id:null,message.role==="user"?message.generation_started_at:null,message.created_at],
    );
  }
  const messages=await client.query("SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC,id ASC",[id,userId]);
  return {conversation:conversationFromRow(created.rows[0]),messages:messages.rows.map(messageFromRow)};
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const url = new URL(request.url);
  const characterId = url.searchParams.get("characterId");
  const requestedId = url.searchParams.get("conversationId");
  const includeDiagnostics=isAdminAccount(account);
  if (url.searchParams.get("scope") === "all") {
    const result = await asUser(account.id, (client) => client.query(
      "SELECT * FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC,created_at DESC",
      [account.id],
    ));
    return Response.json({ conversations: result.rows.map(conversationFromRow) });
  }
  if (!characterId) return Response.json({ error: "characterId is required" }, { status: 400 });

  const payload = await asUser(account.id, async (client) => {
    let listResult = await client.query(
      "SELECT * FROM conversations WHERE character_id=$1 AND user_id=$2 ORDER BY updated_at DESC, created_at DESC",
      [characterId, account.id],
    );
    if (!listResult.rowCount) {
      const created = await createConversation(client, account.id, characterId);
      if (!created) return { error: "Character not found", status: 404 as const };
      listResult = await client.query(
        "SELECT * FROM conversations WHERE character_id=$1 AND user_id=$2 ORDER BY updated_at DESC, created_at DESC",
        [characterId, account.id],
      );
    }
    const conversations = listResult.rows.map(conversationFromRow);
    const conversation = requestedId ? conversations.find((item) => item.id === requestedId) : conversations[0];
    if (!conversation) return { error: "Conversation not found", status: 404 as const };
    const messages = await client.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC, id ASC",
      [conversation.id, account.id],
    );
    return { conversations, conversation, messages: messages.rows.map(messageFromRow).map((message)=>messageForViewer(message,includeDiagnostics)) };
  });

  if ("error" in payload) return Response.json({ error: payload.error }, { status: payload.status });
  return Response.json(payload);
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const body = await request.json().catch(() => ({}));
  if (typeof body.branchFromConversationId === "string" && typeof body.branchFromMessageId === "string") {
    const branchRequestId=typeof body.branchRequestId === "string" ? body.branchRequestId : randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(branchRequestId)) return Response.json({error:"Invalid branch request"},{status:400});
    const branch=await asUser(account.id,(client)=>branchConversation(client,account.id,body.branchFromConversationId,body.branchFromMessageId,branchRequestId));
    if (!branch) return Response.json({error:"Conversation or branch point not found"},{status:404});
    return Response.json({...branch,messages:branch.messages.map((message)=>messageForViewer(message,isAdminAccount(account)))},{status:201});
  }
  if (typeof body.characterId !== "string") return Response.json({ error: "characterId is required" }, { status: 400 });
  const greetingIndex = typeof body.greetingIndex === "number" ? body.greetingIndex : 0;
  const personaId = typeof body.personaId === "string" ? body.personaId : null;

  const payload = await asUser(account.id, async (client) => {
    const conversation = await createConversation(client, account.id, body.characterId, greetingIndex, personaId);
    if (!conversation) return null;
    const messages = await client.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC, id ASC",
      [conversation.id, account.id],
    );
    return { conversation, messages: messages.rows.map(messageFromRow).map((message)=>messageForViewer(message,isAdminAccount(account))) };
  });

  if (!payload) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json(payload, { status: 201 });
}
