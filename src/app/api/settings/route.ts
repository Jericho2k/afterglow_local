import { requireAuth } from "@/lib/auth";
import { getSettings, query } from "@/lib/db";
import { settingsSchema } from "@/lib/schemas";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  return Response.json({ settings: await getSettings() });
}

export async function PATCH(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid settings", details: parsed.error.flatten() }, { status: 400 });
  const s = parsed.data;
  await query(
    `UPDATE app_settings SET owner_name=$1,owner_profile=$2,model=$3,temperature=$4,max_tokens=$5,
     context_messages=$6,consolidation_interval=$7,memory_limit=$8,updated_at=now() WHERE id='owner'`,
    [s.ownerName,s.ownerProfile,s.model,s.temperature,s.maxTokens,s.contextMessages,s.consolidationInterval,s.memoryLimit],
  );
  return Response.json({ settings: await getSettings() });
}
