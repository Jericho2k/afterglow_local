import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { characterFromRow, conversationFromRow, getSettings, memoryArcFromRow, memoryFromRow, messageFromRow, query, transaction } from "@/lib/db";
import { backupSchema } from "@/lib/schemas";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const [charactersResult, conversationsResult, messagesResult, memoriesResult, arcsResult, settings] = await Promise.all([
    query("SELECT * FROM characters ORDER BY created_at ASC"),
    query("SELECT * FROM conversations ORDER BY created_at ASC"),
    query("SELECT * FROM messages ORDER BY created_at ASC,id ASC"),
    query("SELECT * FROM memories ORDER BY created_at ASC"),
    query("SELECT * FROM memory_arcs ORDER BY created_at ASC"),
    getSettings(),
  ]);
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    characters: charactersResult.rows.map((row) => { const character = characterFromRow(row); return { id: character.id, data: character }; }),
    conversations: conversationsResult.rows.map(conversationFromRow),
    messages: messagesResult.rows.map(messageFromRow),
    memories: memoriesResult.rows.map(memoryFromRow),
    arcs: arcsResult.rows.map(memoryArcFromRow),
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="afterglow-backup-${new Date().toISOString().slice(0,10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const parsed = backupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid or unsupported Afterglow backup", details: parsed.error.flatten() }, { status: 400 });
  const backup = parsed.data;
  const counts = await transaction(async (client) => {
    const characterIds = new Map<string,string>();
    const conversationIds = new Map<string,string>();
    for (const item of backup.characters) {
      const id = randomUUID(); characterIds.set(item.id,id); const c = item.data;
      await client.query(
        `INSERT INTO characters (id,name,profile_type,tagline,avatar_url,accent,backstory,cast_members,lorebook,personality,scenario,greeting,alternate_greetings,example_dialogue,response_directive,boundaries,source_material,nsfw_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)`,
        [id,c.name,c.profileType,c.tagline,c.avatarUrl,c.accent,c.backstory,JSON.stringify(c.cast),c.lorebook,c.personality,c.scenario,c.greeting,JSON.stringify(c.alternateGreetings),c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled],
      );
    }
    for (const item of backup.conversations) {
      const characterId = characterIds.get(item.characterId); if (!characterId) continue;
      const id = randomUUID(); conversationIds.set(item.id,id);
      await client.query("INSERT INTO conversations (id,character_id,title,summary) VALUES ($1,$2,$3,$4)", [id,characterId,item.title,item.summary]);
    }
    let messageCount = 0;
    for (const item of backup.messages) {
      const conversationId = conversationIds.get(item.conversationId); if (!conversationId) continue;
      await client.query(
        "INSERT INTO messages (id,conversation_id,role,content,variants,selected_variant,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,COALESCE($7::timestamptz,now()))",
        [randomUUID(),conversationId,item.role,item.content,JSON.stringify(item.variants),Math.min(item.selectedVariant,Math.max(0,item.variants.length - 1)),item.createdAt ?? null],
      );
      messageCount += 1;
    }
    await client.query(`UPDATE conversations c SET message_count=(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) WHERE c.id = ANY($1::uuid[])`, [[...conversationIds.values()]]);
    let memoryCount = 0;
    for (const item of backup.memories) {
      const characterId = characterIds.get(item.characterId); if (!characterId) continue;
      const conversationId = item.conversationId ? conversationIds.get(item.conversationId) ?? null : null;
      await client.query(
        "INSERT INTO memories (id,character_id,conversation_id,content,kind,importance,keywords,pinned,status,resolution,resolved_at,source_message_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $9='resolved' THEN now() ELSE NULL END,$11)",
        [randomUUID(),characterId,conversationId,item.content,item.kind,item.importance,item.keywords,item.pinned,item.status,item.resolution,item.sourceMessageCount],
      );
      memoryCount += 1;
    }
    let arcCount = 0;
    for (const item of backup.arcs) {
      const conversationId = conversationIds.get(item.conversationId); if (!conversationId) continue;
      await client.query(
        "INSERT INTO memory_arcs (id,conversation_id,summary,keywords,start_message_count,end_message_count) VALUES ($1,$2,$3,$4,$5,$6)",
        [randomUUID(),conversationId,item.summary,item.keywords,item.startMessageCount,item.endMessageCount],
      );
      arcCount += 1;
    }
    if (backup.settings) {
      const s = backup.settings;
      await client.query(
        `UPDATE app_settings SET owner_name=$1,owner_profile=$2,model=$3,roleplay_preset=$4,temperature=$5,max_tokens=$6,
         context_messages=$7,context_token_budget=$8,consolidation_interval=$9,memory_limit=$10,memory_token_budget=$11,updated_at=now() WHERE id='owner'`,
        [s.ownerName,s.ownerProfile,s.model,s.roleplayPreset,s.temperature,s.maxTokens,s.contextMessages,s.contextTokenBudget,s.consolidationInterval,s.memoryLimit,s.memoryTokenBudget],
      );
    }
    return { characters: characterIds.size, conversations: conversationIds.size, messages: messageCount, memories: memoryCount, arcs: arcCount };
  });
  return Response.json({ ok: true, imported: counts }, { status: 201 });
}
