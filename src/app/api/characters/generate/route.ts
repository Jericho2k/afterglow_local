import { asUser, getUserSettings } from "@/lib/db";
import { completionWithUsage } from "@/lib/llm";
import { normalizeCreationResult } from "@/lib/creation-ai";
import { parseLenientJsonWithRepair, type JsonRepair } from "@/lib/json-repair";
import {
  contentImportTokenBudget, coreImportTokenBudget, creationTokenBudget,
  importContentPrompt, importCorePrompt, importInventoryPrompt, importOpeningsPrompt,
  importOrganizePrompt, importRecoveryTokenBudget, importSupportingContentPrompt,
  inventoryThreshold, inventoryTokenBudget, quickIdeaPrompt, splitImportThreshold,
} from "@/lib/creation-prompts";
import { generateCreationSchema } from "@/lib/schemas";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";
import { recordUsageEvent } from "@/lib/usage";
import { backgroundReasoningFor, providerModelId, taskModelSelection } from "@/lib/provider";

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

    const backgroundThinking = backgroundReasoningFor(selection.modelId);
    const completionOptions = (maxTokens: number, temperature: number) => ({
      json: true as const,
      maxTokens,
      temperature,
      modelId: selection.modelId,
      ...(backgroundThinking === undefined ? {} : { thinking: backgroundThinking }),
      // A structured extraction must not silently re-enable endpoint-default
      // reasoning inside a completion envelope sized for JSON.
      strictReasoning: true,
    });

    let inventory = "";
    if (mode === "import" && idea.length >= inventoryThreshold) {
      const audited = await completionWithUsage(selection, [
        { role: "system", content: "You are a meticulous source archivist. Return valid JSON only." },
        { role: "user", content: importInventoryPrompt(idea) },
      ], completionOptions(inventoryTokenBudget(idea.length), 0.1));
      inventory = audited.content;
      if (audited.usage) await record(audited.usage, `${taskRoute}_inventory`);
    }

    const normalizeOptions = {
      sourceMaterial: mode === "import" ? idea : "",
      nsfwEnabled,
      creationType,
      audited: Boolean(inventory),
    };

    let result;

    if (mode === "idea") {
      const response = await completionWithUsage(selection, [
        { role: "system", content: "You are an inventive character and scenario designer for a roleplay platform. Return valid JSON only." },
        { role: "user", content: quickIdeaPrompt({ idea, direction, creationType, adultAllowed: nsfwEnabled }) },
      ], completionOptions(creationTokenBudget("idea", idea.length), 0.9));
      if (response.usage) await record(response.usage, taskRoute);
      result = normalizeCreationResult(response.content, normalizeOptions);
    } else {
      /**
       * Large imports are split by payload shape, not arbitrarily by source
       * chunks. Durable definition and long authored scenes are two different
       * outputs that used to compete for one token envelope; keeping both calls
       * on the complete source lets each preserve context while preventing six
       * long greetings from crowding personality/backstory out of the JSON.
       */
      const splitImport = async () => {
        const [core, contentPass] = await Promise.all([
          completionWithUsage(selection, [
            { role: "system", content: "You are a precise import archivist. Extract durable character/scenario definition without rewriting it. Return valid JSON only." },
            { role: "user", content: importCorePrompt({ source: idea, polish, creationType, inventory, adultAllowed: nsfwEnabled }) },
          ], completionOptions(coreImportTokenBudget(idea.length), 0.15)),
          completionWithUsage(selection, [
            { role: "system", content: "You are a precise import archivist. Preserve supplied scenes, dialogue and lore without rewriting them. Return valid JSON only." },
            { role: "user", content: importContentPrompt({ source: idea, polish, inventory }) },
          ], completionOptions(contentImportTokenBudget(idea.length), 0.1)),
        ]);
        if (core.usage) await record(core.usage, `${taskRoute}_core`);
        if (contentPass.usage) await record(contentPass.usage, `${taskRoute}_content`);

        const coreParsed = parseLenientJsonWithRepair<Record<string, unknown>>(core.content);
        let contentParsed = parseLenientJsonWithRepair<Record<string, unknown>>(contentPass.content);

        // A truncated core definition is not acceptable as a successful import:
        // unlike the old path, we refuse to normalize "never emitted" into "".
        // One larger retry is cheap and normally resolves a provider that simply
        // stopped a little early; if it still truncates, the request fails and
        // the creator's existing draft/source remains untouched.
        let finalCore = coreParsed;
        if (coreParsed.repair === "truncated") {
          const retry = await completionWithUsage(selection, [
            { role: "system", content: "The previous durable-definition import was cut short. Return the complete durable definition as valid JSON only; do not include openings, dialogue or world lore." },
            { role: "user", content: importCorePrompt({ source: idea, polish, creationType, inventory, adultAllowed: nsfwEnabled }) },
          ], completionOptions(importRecoveryTokenBudget(), 0.1));
          if (retry.usage) await record(retry.usage, `${taskRoute}_core_recovery`);
          finalCore = parseLenientJsonWithRepair<Record<string, unknown>>(retry.content);
          if (finalCore.repair === "truncated") {
            throw new Error("The importer could not fit the character definition into a complete response. Your source was not changed; please retry the import.");
          }
        }

        // Scene payloads can themselves be enormous. If that narrow pass still
        // truncates, split once more so openings and supporting content cannot
        // crowd each other out either.
        if (contentParsed.repair === "truncated") {
          const [openings, supporting] = await Promise.all([
            completionWithUsage(selection, [
              { role: "system", content: "Recover supplied opening scenes verbatim. Return valid JSON only." },
              { role: "user", content: importOpeningsPrompt({ source: idea, polish, inventory }) },
            ], completionOptions(importRecoveryTokenBudget(), 0.05)),
            completionWithUsage(selection, [
              { role: "system", content: "Recover supplied example dialogue and world lore verbatim. Return valid JSON only." },
              { role: "user", content: importSupportingContentPrompt({ source: idea, polish }) },
            ], completionOptions(importRecoveryTokenBudget(), 0.05)),
          ]);
          if (openings.usage) await record(openings.usage, `${taskRoute}_openings_recovery`);
          if (supporting.usage) await record(supporting.usage, `${taskRoute}_supporting_recovery`);
          const openingParsed = parseLenientJsonWithRepair<Record<string, unknown>>(openings.content);
          const supportingParsed = parseLenientJsonWithRepair<Record<string, unknown>>(supporting.content);
          if (openingParsed.repair === "truncated" || supportingParsed.repair === "truncated") {
            throw new Error("The importer could not preserve all supplied openings in a complete response. Your source was not changed; please retry the import.");
          }
          contentParsed = {
            value: { ...supportingParsed.value, ...openingParsed.value },
            repair: (openingParsed.repair === "structure" || supportingParsed.repair === "structure" ? "structure" : "none") as JsonRepair,
          };
        }

        const merged = JSON.stringify({ ...finalCore.value, ...contentParsed.value });
        return normalizeCreationResult(merged, normalizeOptions);
      };

      if (idea.length >= splitImportThreshold) {
        result = await splitImport();
      } else {
        const response = await completionWithUsage(selection, [
          { role: "system", content: "You are a precise import archivist for a roleplay platform. You reorganise supplied material into structured fields without rewriting, softening or censoring it. Return valid JSON only." },
          { role: "user", content: importOrganizePrompt({ source: idea, polish, creationType, inventory, adultAllowed: nsfwEnabled }) },
        ], completionOptions(creationTokenBudget("import", idea.length), 0.2));
        if (response.usage) await record(response.usage, taskRoute);
        const first = normalizeCreationResult(response.content, normalizeOptions);

        // The old behaviour surfaced a syntactically repaired prefix as if it
        // were a finished import, turning every key the model never reached into
        // an empty field. Truncation now means "recover automatically".
        result = first.stats.repair === "truncated" ? await splitImport() : first;
      }
    }

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
