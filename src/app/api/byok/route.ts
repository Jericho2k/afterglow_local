import { byokFeatureEnabled, byokMetadata, ByokError, removeProviderKey, setWriterFunding, storeValidatedProviderKey, validateByokEncryptionConfiguration, validateOpenRouterKey } from "@/lib/byok";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";

function disabled() {
  return Response.json({ error: "Personal OpenRouter funding is not available right now.", reason: "feature_disabled" }, { status: 503 });
}

export async function GET() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  return Response.json(await byokMetadata(account.id));
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`byok-connect:${account.id}`, 6, 60_000); if (limited) return limited;
  const ipLimited = checkRateLimit(`byok-connect-ip:${clientIp(request)}`, 20, 60_000); if (ipLimited) return ipLimited;
  if (!byokFeatureEnabled()) return disabled();

  const body = await request.json().catch(() => null) as { apiKey?: unknown } | null;
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length < 12 || apiKey.length > 512) {
    return Response.json({ error: "Enter a valid OpenRouter API key." }, { status: 400 });
  }

  try {
    validateByokEncryptionConfiguration();
  } catch (error) {
    console.error("[byok] encryption configuration is invalid", error instanceof Error ? error.message : "invalid configuration");
    return Response.json({ error: "Personal OpenRouter keys are not configured correctly on this deployment." }, { status: 503 });
  }

  const validation = await validateOpenRouterKey(apiKey, request.signal);
  if (!validation.ok) {
    return Response.json({
      error: validation.kind === "invalid"
        ? "OpenRouter rejected that key. Check that it is active, then try again."
        : "OpenRouter could not validate the key right now. Your existing key was not changed.",
      reason: validation.kind,
    }, { status: validation.kind === "invalid" ? 400 : 503 });
  }

  await storeValidatedProviderKey(account.id, apiKey);
  return Response.json(await byokMetadata(account.id));
}

export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  if (!byokFeatureEnabled()) return disabled();
  const body = await request.json().catch(() => null) as { writerFunding?: unknown } | null;
  if (body?.writerFunding !== "afterglow" && body?.writerFunding !== "byok") {
    return Response.json({ error: "Choose Afterglow or My OpenRouter for writer funding." }, { status: 400 });
  }
  try {
    await setWriterFunding(account.id, body.writerFunding);
    return Response.json(await byokMetadata(account.id));
  } catch (error) {
    if (error instanceof ByokError) return Response.json({ error: error.message, reason: error.code }, { status: 409 });
    throw error;
  }
}

export async function DELETE() {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`byok-remove:${account.id}`, 10, 60_000); if (limited) return limited;
  await removeProviderKey(account.id);
  return Response.json(await byokMetadata(account.id));
}
