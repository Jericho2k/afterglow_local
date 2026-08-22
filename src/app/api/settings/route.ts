import { asUser, getUserSettings, settingsFromRow } from "@/lib/db";
import { allowedModels, availableCatalog, defaultModel, resolveModel } from "@/lib/provider";
import { settingsSchema } from "@/lib/schemas";
import { currentAccount, isAdminAccount, unauthorized } from "@/lib/session";

function settingsForClient(settings:ReturnType<typeof settingsFromRow>,admin:boolean) {
  if(admin)return settings;
  const {providerId,model,roleplayPreset,responseLength,temperature}=settings;
  return {providerId,model,roleplayPreset,responseLength,temperature};
}

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const settings = await asUser(account.id, (client) => getUserSettings(client, account.id));
  return Response.json({ settings:settingsForClient(settings,isAdminAccount(account)), models: allowedModels(), catalog: availableCatalog() });
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
    const current=await getUserSettings(client, account.id);
    const admin=isAdminAccount(account);
    const internal=admin?s:current;
    const identity=admin?s:current;
    const result = await client.query(
      `UPDATE user_settings SET owner_name=$1,owner_profile=$2,provider_id=$3,model=$4,roleplay_preset=$5,response_length=$6,temperature=$7,max_tokens=$8,
       context_messages=$9,context_token_budget=$10,consolidation_interval=$11,memory_limit=$12,memory_token_budget=$13,updated_at=now()
       WHERE user_id=$14 RETURNING *`,
      [identity.ownerName,identity.ownerProfile,s.providerId,s.model || defaultModel(),s.roleplayPreset,s.responseLength,s.temperature,internal.maxTokens,internal.contextMessages,internal.contextTokenBudget,internal.consolidationInterval,internal.memoryLimit,internal.memoryTokenBudget,account.id],
    );
    return settingsFromRow(result.rows[0]);
  });

  return Response.json({ settings:settingsForClient(settings,isAdminAccount(account)), models: allowedModels(), catalog: availableCatalog() });
}
