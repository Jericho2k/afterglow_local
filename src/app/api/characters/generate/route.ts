import { asUser, getUserSettings } from "@/lib/db";
import { completionWithUsage, parseJson } from "@/lib/deepseek";
import { characterGenerationPrompt, characterGenerationTokenBudget } from "@/lib/prompts";
import { characterSchema, generateCharacterSchema } from "@/lib/schemas";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";
import { recordUsageEvent } from "@/lib/usage";

export async function POST(request: Request) {
  // Authenticated before the model call, and throttled per account rather than
  // per IP so one signed-in user cannot exhaust the budget for everyone behind
  // a shared address.
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`generate:${account.id}`, 15, 60 * 60_000); if (limited) return limited;
  const input = generateCharacterSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "Describe the character in a little more detail." }, { status: 400 });

  try {
    const settings = await asUser(account.id, (client) => getUserSettings(client, account.id));
    const response = await completionWithUsage([
      { role: "system", content: "You are an expert character designer. Return valid JSON only." },
      { role: "user", content: characterGenerationPrompt(input.data.idea, input.data.tone, input.data.nsfwEnabled, input.data.mode) },
    ], { json: true, maxTokens: characterGenerationTokenBudget(input.data.mode, input.data.idea.length), temperature: input.data.mode === "dump" ? 0.3 : 0.9, model: settings.model });
    if (response.usage) await recordUsageEvent({ userId: account.id, model: settings.model, kind: "character_generation", usage: response.usage });
    const generated = parseJson<Record<string, unknown>>(response.content);
    const character = characterSchema.parse({
      ...generated,
      sourceMaterial: input.data.mode === "dump" ? input.data.idea : "",
      nsfwEnabled: input.data.nsfwEnabled,
    });
    return Response.json({ character });
  } catch (error) {
    console.error("Character generation failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Generation failed" }, { status: 502 });
  }
}
