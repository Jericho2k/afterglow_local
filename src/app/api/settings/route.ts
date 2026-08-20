import { asUser, getUserSettings, settingsFromRow } from "@/lib/db";
import { allowedModels, availableCatalog, defaultModel, resolveModel } from "@/lib/provider";
import { settingsSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const settings = await asUser(account.id, (client) => getUserSettings(client, account.id));
  return Response.json({ settings, models: allowedModels(), catalog: availableCatalog() });
}

export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid settings", details: parsed.error.flatten() }, { status: 400 });
  const s = parsed.data;

  // Model choice is an entitlement, not a preference: the server decides which
  // models an account may spend money on, so an arbitrary string from the
  // browser never reaches the provider.
  if (!resolveModel(s.providerId, s.model)) {
    return Response.json({ error: `That model is not available on this deployment. Choose one of: ${allowedModels().join(", ")}` }, { status: 403 });
  }

  const settings = await asUser(account.id, async (client) => {
    await getUserSettings(client, account.id);
    const result = await client.query(
      `UPDATE user_settings SET owner_name=$1,owner_profile=$2,provider_id=$3,model=$4,roleplay_preset=$5,temperature=$6,max_tokens=$7,
       context_messages=$8,context_token_budget=$9,consolidation_interval=$10,memory_limit=$11,memory_token_budget=$12,updated_at=now()
       WHERE user_id=$13 RETURNING *`,
      [s.ownerName,s.ownerProfile,s.providerId,s.model || defaultModel(),s.roleplayPreset,s.temperature,s.maxTokens,s.contextMessages,s.contextTokenBudget,s.consolidationInterval,s.memoryLimit,s.memoryTokenBudget,account.id],
    );
    return settingsFromRow(result.rows[0]);
  });

  return Response.json({ settings, models: allowedModels(), catalog: availableCatalog() });
}
