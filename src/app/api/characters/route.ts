import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { characterFromRow, query } from "@/lib/db";
import { characterSchema } from "@/lib/schemas";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const result = await query("SELECT * FROM characters ORDER BY updated_at DESC");
  return Response.json({ characters: result.rows.map(characterFromRow) });
}

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid character", details: parsed.error.flatten() }, { status: 400 });
  const id = randomUUID();
  const c = parsed.data;
  const result = await query(
    `INSERT INTO characters (id,name,tagline,avatar_url,accent,backstory,personality,scenario,greeting,example_dialogue,response_directive,boundaries,nsfw_enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id,c.name,c.tagline,c.avatarUrl,c.accent,c.backstory,c.personality,c.scenario,c.greeting,c.exampleDialogue,c.responseDirective,c.boundaries,c.nsfwEnabled],
  );
  return Response.json({ character: characterFromRow(result.rows[0]) }, { status: 201 });
}
