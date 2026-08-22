import { randomUUID } from "node:crypto";
import { asUser, characterFromRow, conversationFromRow, getUserSettings, memoryArcFromRow, memoryFromRow, messageFromRow, personaFromRow, worldFromRow } from "@/lib/db";
import { backupSchema } from "@/lib/schemas";
import { currentAccount, isAdminAccount, unauthorized } from "@/lib/session";

/**
 * Exports only what the calling account owns.
 *
 * Every statement filters on user_id, and the whole export runs inside the
 * account's own database session, so a published character somebody else
 * created is never swept into a backup along with their private chats.
 */
export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const includeContinuity=isAdminAccount(account);

  const payload = await asUser(account.id, async (client) => {
    const [charactersResult, linksResult, personasResult, worldsResult, conversationsResult, messagesResult, memoriesResult, arcsResult, settings] = await Promise.all([
      client.query("SELECT * FROM characters WHERE user_id=$1 ORDER BY created_at ASC", [account.id]),
      client.query("SELECT cw.character_id,cw.world_id FROM character_worlds cw JOIN characters c ON c.id=cw.character_id AND c.user_id=$1", [account.id]),
      client.query("SELECT * FROM personas WHERE user_id=$1 ORDER BY created_at ASC", [account.id]),
      client.query("SELECT * FROM worlds WHERE user_id=$1 ORDER BY created_at ASC", [account.id]),
      client.query("SELECT * FROM conversations WHERE user_id=$1 ORDER BY created_at ASC", [account.id]),
      client.query("SELECT * FROM messages WHERE user_id=$1 ORDER BY created_at ASC,id ASC", [account.id]),
      includeContinuity?client.query("SELECT * FROM memories WHERE user_id=$1 ORDER BY created_at ASC", [account.id]):Promise.resolve({rows:[]}),
      includeContinuity?client.query("SELECT * FROM memory_arcs WHERE user_id=$1 ORDER BY created_at ASC", [account.id]):Promise.resolve({rows:[]}),
      getUserSettings(client, account.id),
    ]);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings:includeContinuity?settings:{providerId:settings.providerId,model:settings.model,roleplayPreset:settings.roleplayPreset,responseLength:settings.responseLength,temperature:settings.temperature},
      personas: personasResult.rows.map((row) => { const persona = personaFromRow(row); return { id: persona.id, data: persona }; }),
      worlds: worldsResult.rows.map((row) => { const world = worldFromRow(row); return { id: world.id, data: world }; }),
      characters: charactersResult.rows.map((row) => {
        const character = characterFromRow({ ...row, world_ids: linksResult.rows.filter((link) => String(link.character_id) === String(row.id)).map((link) => String(link.world_id)) }, account.id);
        return { id: character.id, data: character };
      }),
      conversations: conversationsResult.rows.map(conversationFromRow),
      messages: messagesResult.rows.map(messageFromRow),
      memories: memoriesResult.rows.map(memoryFromRow),
      arcs: arcsResult.rows.map(memoryArcFromRow),
    };
  });

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="afterglow-backup-${new Date().toISOString().slice(0,10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Imports a backup into the calling account.
 *
 * Identifiers inside the uploaded file are treated purely as internal
 * cross-references: every row is written with a freshly generated id and the
 * authenticated account as its owner. A backup that names another user's id,
 * or claims a character it does not contain, cannot attach anything to them.
 */
export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const includeContinuity=isAdminAccount(account);
  const parsed = backupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid or unsupported Afterglow backup", details: parsed.error.flatten() }, { status: 400 });
  const backup = parsed.data;

  const counts = await asUser(account.id, async (client) => {
    const personaIds = new Map<string,string>();
    const worldIds = new Map<string,string>();
    const characterIds = new Map<string,string>();
    const conversationIds = new Map<string,string>();

    for (const item of backup.personas) {
      const id = randomUUID(); personaIds.set(item.id,id); const p = item.data;
      await client.query(
        "INSERT INTO personas (id,user_id,name,description,avatar_url,avatar_path,accent,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,false)",
        [id,account.id,p.name,p.description,p.avatarUrl,p.avatarPath ?? "",p.accent],
      );
    }
    for (const item of backup.worlds) {
      const id = randomUUID(); worldIds.set(item.id,id); const w = item.data;
      await client.query(
        "INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,$3,$4,$5,'private')",
        [id,account.id,w.name,w.description,w.content],
      );
    }
    for (const item of backup.characters) {
      const id = randomUUID(); characterIds.set(item.id,id); const c = item.data;
      // Imported characters land private regardless of what the file claimed.
      // Publishing is a deliberate act in the owner's own library.
      await client.query(
        `INSERT INTO characters (id,user_id,name,profile_type,tagline,avatar_url,avatar_path,accent,backstory,cast_members,lorebook,personality,scenario,greeting,alternate_greetings,example_dialogue,response_directive,boundaries,source_material,nsfw_enabled,visibility)
         VALUES ($1,$2,$3,$4,'',$5,$6,$7,$8,$9::jsonb,'',$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,'private')`,
        [id,account.id,c.name,c.profileType,c.avatarUrl,c.avatarPath ?? "",c.accent,c.backstory,JSON.stringify(c.cast),c.personality,c.scenario,c.greeting,JSON.stringify(c.alternateGreetings),c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled],
      );
      for (const sourceWorldId of c.worldIds) {
        const worldId = worldIds.get(sourceWorldId);
        if (worldId) await client.query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)",[id,worldId]);
      }
      if (c.lorebook.trim()) {
        const worldId = randomUUID();
        await client.query(
          "INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,$3,$4,$5,'private')",
          [worldId,account.id,`${c.name} world`,"Separated from an older embedded lorebook during backup import.",c.lorebook],
        );
        await client.query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2)",[id,worldId]);
      }
    }
    for (const item of backup.conversations) {
      const characterId = characterIds.get(item.characterId); if (!characterId) continue;
      const id = randomUUID(); conversationIds.set(item.id,id);
      await client.query(
        "INSERT INTO conversations (id,character_id,user_id,title,summary,persona_id,provider_id,model_id,rp_engine_id,instruction_presets,custom_instructions,response_length,temperature) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [id,characterId,account.id,item.title,item.summary,item.personaId ? personaIds.get(item.personaId) ?? null : null,item.providerId,item.modelId,item.rpEngineId,item.instructionPresets,item.customInstructions,item.responseLength,item.temperature],
      );
    }
    let messageCount = 0;
    for (const item of backup.messages) {
      const conversationId = conversationIds.get(item.conversationId); if (!conversationId) continue;
      const messageId=randomUUID();
      await client.query(
        "INSERT INTO messages (id,conversation_id,user_id,role,content,variants,selected_variant,authored_event_id,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,COALESCE($9::timestamptz,now()))",
        [messageId,conversationId,account.id,item.role,item.content,JSON.stringify(item.variants),Math.min(item.selectedVariant,Math.max(0,item.variants.length - 1)),item.role==="user"?messageId:null,item.createdAt ?? null],
      );
      messageCount += 1;
    }
    await client.query(
      `UPDATE conversations c SET message_count=(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) WHERE c.id = ANY($1::uuid[]) AND c.user_id=$2`,
      [[...conversationIds.values()], account.id],
    );
    let memoryCount = 0;
    for (const item of includeContinuity?backup.memories:[]) {
      const characterId = characterIds.get(item.characterId); if (!characterId) continue;
      const conversationId = item.conversationId ? conversationIds.get(item.conversationId) ?? null : null;
      await client.query(
        "INSERT INTO memories (id,character_id,conversation_id,user_id,content,kind,importance,keywords,pinned,status,resolution,resolved_at,source_message_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $10='resolved' THEN now() ELSE NULL END,$12)",
        [randomUUID(),characterId,conversationId,account.id,item.content,item.kind,item.importance,item.keywords,item.pinned,item.status,item.resolution,item.sourceMessageCount],
      );
      memoryCount += 1;
    }
    let arcCount = 0;
    for (const item of includeContinuity?backup.arcs:[]) {
      const conversationId = conversationIds.get(item.conversationId); if (!conversationId) continue;
      await client.query(
        "INSERT INTO memory_arcs (id,conversation_id,user_id,summary,keywords,start_message_count,end_message_count) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [randomUUID(),conversationId,account.id,item.summary,item.keywords,item.startMessageCount,item.endMessageCount],
      );
      arcCount += 1;
    }
    if (backup.settings) {
      const s = backup.settings;
      const current=await getUserSettings(client,account.id);
      const internal=includeContinuity?s:current;
      const identity=includeContinuity?s:current;
      await client.query(
        `UPDATE user_settings SET owner_name=$1,owner_profile=$2,provider_id=$3,model=$4,roleplay_preset=$5,response_length=$6,temperature=$7,max_tokens=$8,
         context_messages=$9,context_token_budget=$10,consolidation_interval=$11,memory_limit=$12,memory_token_budget=$13,updated_at=now() WHERE user_id=$14`,
        [identity.ownerName,identity.ownerProfile,s.providerId,s.model,s.roleplayPreset,s.responseLength,s.temperature,internal.maxTokens,internal.contextMessages,internal.contextTokenBudget,internal.consolidationInterval,internal.memoryLimit,internal.memoryTokenBudget,account.id],
      );
    }
    return { personas: personaIds.size, worlds: worldIds.size, characters: characterIds.size, conversations: conversationIds.size, messages: messageCount, memories: memoryCount, arcs: arcCount };
  });

  return Response.json({ ok: true, imported: counts }, { status: 201 });
}
