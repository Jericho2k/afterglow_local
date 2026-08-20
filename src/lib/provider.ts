import type { ModelCatalog, ModelDefinition, ProviderDefinition, RoleplayEngineDefinition, RoleplayEngineId } from "./types";

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
];

const knownModels: ModelDefinition[] = [
  {
    id: "deepseek-v4-flash",
    providerId: "deepseek",
    label: "DeepSeek V4 Flash",
    description: "Fast, economical roleplay for everyday conversations.",
    supportsThinking: true,
  },
  {
    id: "deepseek-v4-pro",
    providerId: "deepseek",
    label: "DeepSeek V4 Pro",
    description: "Higher-detail writing and stronger handling of complex scenes.",
    supportsThinking: true,
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

export function allowedModels() {
  const configured = (process.env.ALLOWED_MODELS || "").split(",").map((item) => item.trim()).filter(safeId);
  return configured.length ? configured : knownModels.map((item) => item.id);
}

export function availableModels(): ModelDefinition[] {
  return allowedModels().map((id) => knownModels.find((item) => item.id === id) ?? {
    id,
    providerId: "deepseek",
    label: id,
    description: "Deployment-configured DeepSeek-compatible model.",
    supportsThinking: true,
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
  const configured = process.env.DEEPSEEK_MODEL?.trim();
  if (configured && allowedModels().includes(configured)) return configured;
  return allowedModels()[0];
}

export function defaultEngine(): RoleplayEngineId {
  const configured = process.env.DEFAULT_RP_ENGINE?.trim();
  return engines.some((engine) => engine.id === configured) ? configured as RoleplayEngineId : "immersive";
}

export function resolveModel(providerId: string, modelId: string) {
  return availableModels().find((model) => model.id === modelId && model.providerId === providerId) ?? null;
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
