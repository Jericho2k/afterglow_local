import type { ModelCatalog, ModelDefinition, ProviderDefinition, RoleplayEngineDefinition, RoleplayEngineId } from "./types";

export type InferenceTask = "rp_generation" | "memory_consolidation" | "memory_curation" | "scene_state" | "character_import";
export type InferenceSelection = { providerId: string; modelId: string };
type InternalModelDefinition = ModelDefinition & { providerModelId: string };

/**
 * Deployment-owned inference catalog.
 *
 * Provider, base model, and roleplay engine are deliberately separate. A
 * conversation stores all three, while Afterglow continues to own the
 * transcript and continuity state. Adding another provider therefore means
 * registering an adapter and model definitions, not rewriting the chat route.
 */
const providers: ProviderDefinition[] = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "openrouter", label: "OpenRouter" },
];

const knownModels: InternalModelDefinition[] = [
  {
    id: "deepseek-v4-flash",
    providerId: "deepseek",
    providerModelId: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "Fast, economical roleplay for everyday conversations.",
    supportsThinking: true,
  },
  {
    id: "deepseek-v4-pro",
    providerId: "deepseek",
    providerModelId: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "Higher-detail writing and stronger handling of complex scenes.",
    supportsThinking: true,
  },
  {
    id: "minimax-m2-her",
    providerId: "openrouter",
    providerModelId: "minimax/minimax-m2-her",
    label: "MiniMax M2-her",
    description: "Dialogue-first roleplay model for expressive, character-driven conversations.",
    supportsThinking: false,
  },
  {
    id: "kimi-k2.5",
    providerId: "openrouter",
    providerModelId: "moonshotai/kimi-k2.5",
    label: "MoonshotAI Kimi K2.5",
    description: "Long-context comparison writer with strong scene comprehension and planning.",
    supportsThinking: true,
  },
  {
    id: "glm-4.7",
    providerId: "openrouter",
    providerModelId: "z-ai/glm-4.7",
    label: "Z.ai GLM 4.7",
    description: "General comparison writer with stable multi-step reasoning and long context.",
    supportsThinking: true,
  },
  {
    id: "midnight-cherry",
    providerId: "openrouter",
    providerModelId: "thedrummer/skyfall-36b-v2",
    label: "Midnight Cherry — Cinematic RP",
    description: "Creative, nuanced prose with coherent scene flow and storytelling emphasis.",
    supportsThinking: false,
  },
  {
    id: "passion-fruit",
    providerId: "openrouter",
    providerModelId: "thedrummer/cydonia-24b-v4.1",
    label: "Passion Fruit — Unbound NSFW",
    description: "Uncensored creative roleplay with strong recall and prompt adherence.",
    supportsThinking: false,
  },
  {
    id: "wild-peach",
    providerId: "openrouter",
    providerModelId: "thedrummer/rocinante-12b",
    label: "Wild Peach — Expressive RP",
    description: "Lighter expressive writer tuned for vivid vocabulary and engaging prose.",
    supportsThinking: false,
  },
];

const engines: RoleplayEngineDefinition[] = [
  { id: "immersive", label: "Afterglow Immersive", description: "The balanced default: fluid story, emotion, intimacy, humor, and character initiative without forcing one tone.", thinking: false, adult: true, tags: ["balanced", "story", "romance"] },
  { id: "raw", label: "Afterglow Unbound", description: "Unapologetically direct adult roleplay with character-led desire, explicit language, emotional messiness, and real consequences.", thinking: false, adult: true, tags: ["explicit", "intense", "character agency"] },
  { id: "kink_aware", label: "Afterglow Kink-Aware", description: "Keeps power dynamics, roles, preferences, limits, pacing, and negotiated boundaries coherent instead of reducing kink to generic sex.", thinking: false, adult: true, tags: ["kink", "power dynamics", "boundaries"] },
  { id: "multi_clarity", label: "Afterglow Multi-Clarity", description: "Built for casts and group scenes: distinct voices, identities, positions, motives, relationships, and parallel reactions without character blending.", thinking: false, adult: true, tags: ["multiple characters", "group scenes", "clarity"] },
  { id: "slow_burn", label: "Afterglow Slow Burn", description: "Prioritizes earned tension, subtext, gradual trust, longing, and relationship progression without rushing every scene toward sex.", thinking: false, adult: true, tags: ["slow burn", "tension", "romance"] },
  { id: "cinematic", label: "Afterglow Cinematic", description: "Atmospheric, dramatic prose with selective sensory detail, strong scene framing, and novel-like momentum.", thinking: false, adult: true, tags: ["atmosphere", "prose", "drama"] },
  { id: "deliberate", label: "Afterglow Deliberate", description: "Careful causality, strategy, spatial logic, plans, and long-running consequences for complex plots.", thinking: true, adult: true, tags: ["logic", "strategy", "complex plots"] },
];

function safeId(value: string) {
  return /^[a-zA-Z0-9._-]{1,100}$/.test(value);
}

export function openRouterEnabled() {
  return process.env.ENABLE_OPENROUTER === "true" && Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

function modelProviderEnabled(model: InternalModelDefinition) {
  return model.providerId !== "openrouter" || openRouterEnabled();
}

function publicModel(model: InternalModelDefinition): ModelDefinition {
  return {
    id:model.id,
    providerId:model.providerId,
    label:model.label,
    description:model.description,
    supportsThinking:model.supportsThinking,
  };
}

export function allowedModels() {
  const configured = (process.env.ALLOWED_MODELS || "").split(",").map((item) => item.trim()).filter(safeId);
  const deploymentModels = knownModels.filter(modelProviderEnabled).map((item) => item.id);
  return configured.length ? configured.filter((id) => {
    const known = knownModels.find((item) => item.id === id);
    return !known || modelProviderEnabled(known);
  }) : deploymentModels;
}

export function availableModels(): ModelDefinition[] {
  return allowedModels().map((id) => {
    const known = knownModels.find((item) => item.id === id);
    return known ? publicModel(known) : {
    id,
    providerId: "deepseek",
    label: id,
    description: "Deployment-configured DeepSeek-compatible model.",
    supportsThinking: true,
    };
  });
}

export function availableCatalog(): ModelCatalog {
  const models = availableModels();
  return {
    providers: providers.filter((provider) => models.some((model) => model.providerId === provider.id)),
    models,
    engines,
  };
}

export function defaultProvider() {
  const configured = process.env.DEFAULT_LLM_PROVIDER?.trim();
  if (configured && availableModels().some((model) => model.providerId === configured)) return configured;
  return availableModels()[0]?.providerId ?? "deepseek";
}

export function defaultModel() {
  const providerId = defaultProvider();
  const configured = process.env.DEFAULT_LLM_MODEL?.trim() || (providerId === "deepseek" ? process.env.DEEPSEEK_MODEL?.trim() : "");
  if (configured && resolveModel(providerId, configured)) return configured;
  return availableModels().find((model) => model.providerId === providerId)?.id ?? allowedModels()[0];
}

export function defaultEngine(): RoleplayEngineId {
  const configured = process.env.DEFAULT_RP_ENGINE?.trim();
  return engines.some((engine) => engine.id === configured) ? configured as RoleplayEngineId : "immersive";
}

export function resolveModel(providerId: string, modelId: string) {
  return availableModels().find((model) => model.id === modelId && model.providerId === providerId) ?? null;
}

/** Resolve the private upstream slug without exposing it in the browser catalog. */
export function providerModelId(providerId: string, modelId: string) {
  const available = resolveModel(providerId, modelId);
  if (!available) return null;
  return knownModels.find((model) => model.providerId === providerId && model.id === modelId)?.providerModelId ?? modelId;
}

const taskRouteEnvironment: Record<Exclude<InferenceTask,"rp_generation">, string> = {
  memory_consolidation: "MEMORY_CONSOLIDATION_MODEL_ROUTE",
  memory_curation: "MEMORY_CURATION_MODEL_ROUTE",
  scene_state: "SCENE_STATE_MODEL_ROUTE",
  character_import: "CHARACTER_IMPORT_MODEL_ROUTE",
};

function parseRoute(value: string): InferenceSelection | null {
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  const providerId = value.slice(0, separator).trim();
  const modelId = value.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : null;
}

/**
 * Background work has its own writer selection. This prevents a conversation's
 * experimental RP writer from silently becoming the JSON/consolidation model.
 */
export function taskModelSelection(task: InferenceTask, conversation?: InferenceSelection): InferenceSelection {
  if (task === "rp_generation") {
    const configured = process.env.RP_MODEL_ROUTE?.trim() || "conversation";
    const selection = configured === "conversation" ? conversation : parseRoute(configured);
    if (!selection || !resolveModel(selection.providerId,selection.modelId)) throw new Error("RP_MODEL_ROUTE does not name an enabled provider/model or conversation");
    return selection;
  }
  const configured = process.env[taskRouteEnvironment[task]]?.trim();
  const selection = configured ? parseRoute(configured) : { providerId: "deepseek", modelId: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash" };
  if (!selection || !resolveModel(selection.providerId, selection.modelId)) {
    throw new Error(`${taskRouteEnvironment[task]} does not name an enabled provider/model`);
  }
  return selection;
}

export function resolveEngine(engineId: string) {
  return engines.find((engine) => engine.id === engineId) ?? null;
}

export function enginePrompt(engineId: RoleplayEngineId) {
  const prompts: Record<RoleplayEngineId, string> = {
    immersive: "IMMERSIVE: Adapt fluidly between plot, emotion, humor, tenderness, conflict, and adult intimacy. Favor specific character-driven choices over a fixed prose formula.",
    raw: "RAW ADULT: When Adult mode is enabled and the scene becomes sexual, use direct, concrete, uninhibited language rather than euphemisms, coy summaries, or fade-to-black. Keep desire messy and character-specific. Explicitness must emerge from the characters and context, never from automatic compliance.",
    kink_aware: "KINK-AWARE: When Adult mode is enabled, portray kink and power exchange with specific, character-consistent desires, roles, rituals, limits, negotiation, aftercare preferences, and evolving trust. Preserve the difference between fantasy, consent, reluctance, refusal, and a hard stop. Do not flatten every dynamic into generic dominance or generic sex.",
    multi_clarity: "MULTI-CLARITY: Treat every recurring character as a separate mind. Maintain distinct names, voices, bodies, locations, knowledge, motives, relationships, boundaries, and reactions. In group and adult scenes, make speaker/action ownership unambiguous and never blend identities, anatomy, or perspective. Give the cast room to react without turning the reply into a roll call.",
    slow_burn: "SLOW BURN: Build attraction and intimacy through earned tension, subtext, hesitation, small choices, changing trust, and cumulative relationship development. Do not rush emotional milestones or turn every charged moment immediately sexual; when escalation finally happens, let it feel consequential and specific.",
    cinematic: "CINEMATIC: Build atmosphere through selective sensory detail, setting, subtext, body language, and dramatic pacing. Make the scene feel larger than the immediate exchange without burying dialogue beneath description.",
    deliberate: "DELIBERATE: Track causality, plans, spatial details, competing motives, and long-running consequences carefully. Let characters think strategically while remaining emotionally alive and fully in character.",
  };
  return prompts[engineId];
}
