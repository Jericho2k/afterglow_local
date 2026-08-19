import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { characterFromRow, query, transaction } from "@/lib/db";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const [result, links] = await Promise.all([
    query("SELECT * FROM characters ORDER BY updated_at DESC"),
    query("SELECT character_id,world_id FROM character_worlds"),
  ]);
  return Response.json({ characters: result.rows.map((row) => characterFromRow({ ...row, world_ids: links.rows.filter((link) => String(link.character_id) === String(row.id)).map((link) => String(link.world_id)) })) });
}

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: characterValidationMessage(parsed.error), details: parsed.error.flatten() }, { status: 400 });
  const id = randomUUID();
  const c = parsed.data;
  const row = await transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO characters (id,name,profile_type,tagline,avatar_url,accent,backstory,cast_members,lorebook,personality,scenario,greeting,alternate_greetings,example_dialogue,response_directive,boundaries,source_material,nsfw_enabled)
       VALUES ($1,$2,$3,'',$4,$5,$6,$7::jsonb,'',$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16) RETURNING *`,
      [id,c.name,c.profileType,c.avatarUrl,c.accent,c.backstory,JSON.stringify(c.cast),c.personality,c.scenario,c.greeting,JSON.stringify(c.alternateGreetings),c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled],
    );
    for (const worldId of c.worldIds) await client.query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id,worldId]);
    return result.rows[0];
  });
  return Response.json({ character: characterFromRow({ ...row, world_ids: c.worldIds }) }, { status: 201 });
}
