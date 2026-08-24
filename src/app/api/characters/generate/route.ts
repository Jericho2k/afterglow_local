import { asUser, getUserSettings } from "@/lib/db";
import { completionWithUsage } from "@/lib/llm";
import { normalizeCreationResult } from "@/lib/creation-ai";
import {
  creationTokenBudget, importInventoryPrompt, importOrganizePrompt,
  inventoryThreshold, inventoryTokenBudget, quickIdeaPrompt,
} from "@/lib/creation-prompts";
import { generateCreationSchema } from "@/lib/schemas";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";
import { recordUsageEvent } from "@/lib/usage";
import { providerModelId, taskModelSelection } from "@/lib/provider";

/**
 * The AI accelerators behind Quick Idea and Paste Everything.
 *
 * Both produce the same canonical Creation draft the manual studio edits, and
 * neither publishes anything: the response is a draft the creator reviews,
 * with visibility left private and every field editable.
 *
 * The two behaviours are separated here rather than only in the prompt. Quick
 * Idea invents, so it runs warm with a fixed budget; an import organises, so
 * it runs cold, scales its budget with the source, and — for a source large
 * enough that a single pass reliably forgets a secondary character — audits
 * the material first and hands that inventory to the organising call.
 *
 * The accounting is per behaviour rather than per endpoint, so the ledger can
 * answer what generation costs separately from what importing costs.
 */

const taskRoutes = { idea: "creation_quick_idea", import: "creation_import" } as const;

export async function POST(request: Request) {
  // Authenticated before the model call, and throttled per account rather than
  // per IP so one signed-in user cannot exhaust the budget for everyone behind
  // a shared address.
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited = checkRateLimit(`generate:${account.id}`, 15, 60 * 60_000); if (limited) return limited;
  const input = generateCreationSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return Response.json({ error: "Describe your idea, or paste the material you want to import, in a little more detail." }, { status: 400 });
  }
  const { idea, mode, direction, polish, creationType, nsfwEnabled } = input.data;

  try {
    const settings = await asUser(account.id, (client) => getUserSettings(client, account.id));
    // Structured extraction with reliable instruction following, not the
    // conversation's roleplay writer. The route is deployment-configured.
    const selection = taskModelSelection("character_import");
    const actualModel = providerModelId(selection.providerId, selection.modelId) ?? selection.modelId;
    const taskRoute = taskRoutes[mode];
    const record = (usage: Parameters<typeof recordUsageEvent>[0]["usage"], route: string) => recordUsageEvent({
      userId: account.id, providerId: selection.providerId, model: selection.modelId, actualModel,
      rpEngineId: settings.roleplayPreset, kind: "character_generation", taskRoute: route, usage,
    });

    let inventory = "";
    if (mode === "import" && idea.length >= inventoryThreshold) {
      const audited = await completionWithUsage(selection, [
        { role: "system", content: "You are a meticulous source archivist. Return valid JSON only." },
        { role: "user", content: importInventoryPrompt(idea) },
      ], { json: true, maxTokens: inventoryTokenBudget(idea.length), temperature: 0.1 });
      inventory = audited.content;
      if (audited.usage) await record(audited.usage, `${taskRoute}_inventory`);
    }

    const system = mode === "import"
      // Said twice on purpose: the system message is where a model's default
      // "improve the writing" instinct is easiest to head off.
      ? "You are a precise import archivist for a roleplay platform. You reorganise supplied material into structured fields without rewriting, softening or censoring it. Return valid JSON only."
      : "You are an inventive character and scenario designer for a roleplay platform. Return valid JSON only.";
    const prompt = mode === "import"
      ? importOrganizePrompt({ source: idea, polish, creationType, inventory, adultAllowed: nsfwEnabled })
      : quickIdeaPrompt({ idea, direction, creationType, adultAllowed: nsfwEnabled });

    const response = await completionWithUsage(selection, [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ], {
      json: true,
      maxTokens: creationTokenBudget(mode, idea.length),
      // An import must not paraphrase, so it runs as cold as the provider
      // usefully allows; a generator that cold produces identical drafts.
      temperature: mode === "import" ? 0.2 : 0.9,
    });
    if (response.usage) await record(response.usage, taskRoute);

    const result = normalizeCreationResult(response.content, {
      // The original paste is the creator's working material and is preserved
      // verbatim for review and re-import. A generated idea has no source.
      sourceMaterial: mode === "import" ? idea : "",
      nsfwEnabled,
      creationType,
      audited: Boolean(inventory),
    });

    return Response.json({
      creation: result.draft,
      world: result.world,
      notices: result.notices,
      stats: result.stats,
      // The previous client read `character`; keeping the alias means an
      // older tab that is still open does not break mid-session.
      character: result.draft,
    });
  } catch (error) {
    console.error("Creation generation failed", error);
    // The caller keeps their pasted source and their existing draft: nothing
    // is written here, so a failure costs a retry and nothing else.
    return Response.json({
      error: error instanceof Error ? error.message : "That did not work. Your text is still here — try again.",
    }, { status: 502 });
  }
}
