import { asUser, getUserSettings } from "@/lib/db";
import { completionWithUsage } from "@/lib/llm";
import { characterGenerationPrompt, characterGenerationTokenBudget, characterImportInventoryPrompt } from "@/lib/prompts";
import { generateCharacterSchema } from "@/lib/schemas";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";
import { recordUsageEvent } from "@/lib/usage";
import { normalizeGeneratedCharacter } from "@/lib/character-import";
import { providerModelId, taskModelSelection } from "@/lib/provider";

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
    const selection = taskModelSelection("character_import");
    const actualModel = providerModelId(selection.providerId,selection.modelId) ?? selection.modelId;
    let inventory = "";
    if (input.data.mode === "dump" && input.data.idea.length >= 12_000) {
      const audited = await completionWithUsage(selection, [
        { role: "system", content: "You are a meticulous source archivist. Return valid JSON only." },
        { role: "user", content: characterImportInventoryPrompt(input.data.idea) },
      ], { json: true, maxTokens: Math.min(5000, Math.max(2600, Math.ceil(input.data.idea.length / 9))), temperature: 0.1 });
      inventory = audited.content;
      if (audited.usage) await recordUsageEvent({ userId: account.id, providerId: selection.providerId, model: selection.modelId, actualModel, rpEngineId: settings.roleplayPreset, kind: "character_generation", taskRoute: "character_import", usage: audited.usage });
    }
    const response = await completionWithUsage(selection, [
      { role: "system", content: "You are an expert character designer. Return valid JSON only." },
      { role: "user", content: characterGenerationPrompt(input.data.idea, input.data.tone, input.data.nsfwEnabled, input.data.mode, inventory) },
    ], { json: true, maxTokens: characterGenerationTokenBudget(input.data.mode, input.data.idea.length), temperature: input.data.mode === "dump" ? 0.25 : 0.9 });
    if (response.usage) await recordUsageEvent({ userId: account.id, providerId: selection.providerId, model: selection.modelId, actualModel, rpEngineId: settings.roleplayPreset, kind: "character_generation", taskRoute: "character_import", usage: response.usage });
    const character = normalizeGeneratedCharacter(response.content, input.data.mode === "dump" ? input.data.idea : "", input.data.nsfwEnabled);
    const retainedCharacters = character.backstory.length + character.personality.length + character.scenario.length + character.exampleDialogue.length
      + character.responseDirective.length + character.boundaries.length + character.lorebook.length
      + character.cast.reduce((total, member) => total + member.name.length + member.role.length + member.description.length, 0)
      + character.greeting.length + character.alternateGreetings.reduce((total, opening) => total + opening.length, 0);
    return Response.json({ character, importStats: { sourceCharacters: input.data.idea.length, organizedCharacters: retainedCharacters, castMembers: character.cast.length, openings: character.alternateGreetings.length + (character.greeting ? 1 : 0), audited: Boolean(inventory) } });
  } catch (error) {
    console.error("Character generation failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Generation failed" }, { status: 502 });
  }
}
