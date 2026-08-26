import type { RoleplayEngineDefinition, RoleplayEngineId } from "./types";

/**
 * The Afterglow Roleplay Engines.
 *
 * An engine is NOT a model. The model is the writer; the engine is the brief it
 * writes to. Keeping those separate is the whole architecture, and nothing here
 * may blur it.
 *
 * The previous engines had two problems and they were the same problem twice.
 *
 *   NOBODY COULD TELL WHAT THEY DID. "Multi-Clarity" and "Deliberate" are the
 *   names of implementation ideas, not of experiences. A reader choosing
 *   between seven of them was choosing between adjectives.
 *
 *   THEY BARELY DID ANYTHING. Each was ONE descriptive sentence, inserted near
 *   the top of the prompt and then buried under fifteen RULES lines, Adult Mode
 *   and Response Length — several of which actively contradicted it. A sentence
 *   saying "atmospheric prose" loses an argument with a rule that says "do not
 *   force every reply into the same template", and it should: the rule is more
 *   specific and it is stated as a requirement.
 *
 * So an engine is a CONTRACT now: named dials over the dimensions that actually
 * differ between roleplay styles, plus requirements and — the part that matters
 * most — restraints. The restraints exist because the failure mode of a strong
 * engine is worse than the failure mode of a weak one: Slow Burn that turns
 * every character coy, Direct that turns every conversation sexual, and Story
 * Driven that writes purple prose over a quiet moment are all engines that have
 * replaced the creation instead of guiding it.
 *
 * THE CREATION REMAINS THE CHARACTER. That is stated in every engine's own
 * text, not assumed, because it is the thing a writer given eight dials is most
 * likely to forget.
 *
 * The ids are unchanged. A conversation stores the engine it was started with,
 * and renaming an id would silently move every existing story to a different
 * brief — which is exactly the kind of change this file exists to prevent.
 */

/** Where a dimension sits. Four steps, because a reader cannot feel five. */
export type EngineDial = "low" | "moderate" | "high" | "maximum";

/** The dimensions roleplay styles genuinely differ on. */
export type EngineDials = {
  /** How readily a charged moment becomes a more intense one. */
  escalation: EngineDial;
  /** How much happens per reply. */
  pacing: EngineDial;
  /** How often the character acts without being prompted. */
  initiative: EngineDial;
  /** How willing characters are to disagree, refuse, and create friction. */
  conflict: EngineDial;
  /** How much description surrounds the action. */
  proseDensity: EngineDial;
  /** How quickly a relationship moves from one stage to the next. */
  relationshipProgression: EngineDial;
  /** How hard the reply works to keep several characters distinct. */
  castClarity: EngineDial;
  /** How strictly place, time, objects and consequence are tracked. */
  causalDiscipline: EngineDial;
};

export type EngineContract = {
  id: RoleplayEngineId;
  label: string;
  /** One sentence a reader can act on. Says what changes, not how it feels. */
  description: string;
  tags: string[];
  /** Whether this engine asks a capable model to reason before writing. */
  thinking: boolean;
  dials: EngineDials;
  /** What this engine asks for that the base rules do not. */
  requirements: string[];
  /** What this engine must not turn every scene into. */
  restraints: string[];
};

const dialText: Record<keyof EngineDials, Record<EngineDial, string>> = {
  escalation: {
    low: "Let charged moments stay charged. Do not convert tension into the next intensity level unless the scene and the characters clearly push there.",
    moderate: "Escalate when the moment earns it, and let it hold when it does not.",
    high: "When desire, anger or danger is mutual and clear, act on it rather than circling it.",
    maximum: "Follow a clear escalation through to its consequence rather than deferring it.",
  },
  pacing: {
    low: "Cover a short span of story time. One beat, fully inhabited, beats three summarised.",
    moderate: "Move at the pace the scene sets.",
    high: "Keep events moving; something is different by the end of each reply.",
    maximum: "Drive hard: each reply lands a change in situation, not only in mood.",
  },
  initiative: {
    low: "Follow the user's lead; act independently only when staying still would be false to the character.",
    moderate: "Act on the character's own intentions when they have one, without steering the story away from the user.",
    high: "Take the next move yourself. Characters want things and pursue them without being asked.",
    maximum: "Characters and the world act on their own agenda every reply, including when the user is passive.",
  },
  conflict: {
    low: "Friction stays interpersonal and low-stakes unless the story demands otherwise.",
    moderate: "Disagreement, refusal and misunderstanding are available when authentic.",
    high: "Let characters genuinely oppose, refuse, deceive and fail. Do not smooth a scene toward comfort.",
    maximum: "Opposition is structural: competing goals produce real setbacks with lasting cost.",
  },
  proseDensity: {
    low: "Spare and direct. Concrete action and speech; cut atmosphere that adds no information.",
    moderate: "Enough sensory detail to place the scene; no more.",
    high: "Selective, deliberate detail — setting, body language, subtext — carrying meaning rather than decorating it.",
    maximum: "Sustained texture and framing, still subordinate to what is happening.",
  },
  relationshipProgression: {
    low: "Trust, intimacy and status change slowly and only through earned moments.",
    moderate: "Relationships develop as the scenes warrant.",
    high: "Let closeness and rupture land quickly when the scene supports it.",
    maximum: "Relationship state moves decisively; each significant beat leaves it changed.",
  },
  castClarity: {
    low: "Keep the focus on whoever is in the scene.",
    moderate: "Keep who is speaking and acting unambiguous.",
    high: "Every present character keeps a distinct voice, position and motive within the reply.",
    maximum: "Treat each character as a separate mind with its own knowledge, body, position and agenda. Never blend identities, and never reduce the cast to a roll call.",
  },
  causalDiscipline: {
    low: "Keep the immediate scene coherent.",
    moderate: "Preserve place, time, posture and unfinished actions across replies.",
    high: "Track objects, distances, injuries, timing and who knows what, and let consequences persist.",
    maximum: "Reason through cause and effect before writing: what is possible from here, what each character knows and wants, and what follows from the last beat. Plans succeed, fail or change for stated reasons.",
  },
};

/**
 * Rules every engine carries.
 *
 * These are the guardrails against the failure mode the brief names directly:
 * an engine that takes over a creation instead of guiding it. They are repeated
 * in each engine's own text rather than assumed once, because this block sits
 * beside seven paragraphs of specific instruction and the general rule is the
 * one that gets forgotten.
 *
 * The de-escalation clause is the other reported failure and belongs here
 * rather than in any one engine: EVERY combination of engine and model has to
 * be able to leave an intense scene. A story that can enter a sexual scene and
 * not come out of it is broken regardless of which brief it was written to.
 */
const universalRestraints = [
  "This section governs HOW the roleplay is handled. The creation's own personality, voice, history and boundaries always outrank it. Never let this section make a character into somebody else.",
  "A scene that has ended has ended. When an intense, violent or sexual scene concludes, write what actually follows — dressing, leaving, sleeping, eating, ordinary talk, the next morning — and return to the tone that fits the new moment. Do not keep a finished mood running.",
  "Never write the user's dialogue, decisions, thoughts, reactions, or consent.",
];

const contracts: EngineContract[] = [
  {
    id: "immersive",
    label: "Balanced",
    description: "The default. Moves between conversation, feeling, humour, conflict and intimacy as the scene asks, without pushing any one of them.",
    tags: ["default", "adaptable", "everyday"],
    thinking: false,
    dials: {
      escalation: "moderate", pacing: "moderate", initiative: "moderate", conflict: "moderate",
      proseDensity: "moderate", relationshipProgression: "moderate", castClarity: "moderate", causalDiscipline: "moderate",
    },
    requirements: [
      "Read what kind of moment this is before writing, and answer it in kind: a quiet exchange stays quiet, a turning point is given room.",
      "Change register when the scene changes. Do not carry the previous reply's mood into a moment that no longer has it.",
    ],
    restraints: [
      "Do not impose a house style. This engine's job is to stay out of the creation's way.",
    ],
  },
  {
    id: "slow_burn",
    label: "Slow Burn",
    description: "Holds tension rather than resolving it. Attraction, trust and intimacy move a step at a time and have to be earned.",
    tags: ["tension", "romance", "restraint"],
    thinking: false,
    dials: {
      escalation: "low", pacing: "low", initiative: "moderate", conflict: "low",
      proseDensity: "moderate", relationshipProgression: "low", castClarity: "moderate", causalDiscipline: "moderate",
    },
    requirements: [
      "Prefer the smaller version of the gesture: a look held slightly too long, a sentence not finished, a hand that does not quite arrive.",
      "Let a near-miss stay a near-miss. Interruption, timing and reluctance are material, not obstacles to clear.",
      "When escalation does finally happen, make it specific and consequential rather than sudden.",
    ],
    restraints: [
      "Slow is not coy, and it is not passive. A bold character stays bold, a blunt one stays blunt — what changes is how quickly the RELATIONSHIP moves, never who the character is.",
      "Do not refuse a moment the story has genuinely arrived at. Delaying something already earned is a different failure from rushing it, and just as bad.",
    ],
  },
  {
    id: "cinematic",
    label: "Story Driven",
    description: "Pushes the plot. Scenes are framed, events have consequences, and something is different by the end of each reply.",
    tags: ["plot", "momentum", "consequence"],
    thinking: false,
    dials: {
      escalation: "moderate", pacing: "high", initiative: "high", conflict: "high",
      proseDensity: "high", relationshipProgression: "moderate", castClarity: "moderate", causalDiscipline: "high",
    },
    requirements: [
      "Give each reply a shape: where this is, what changes, and what it leaves open.",
      "Let the world act. Weather, other people, time, money and consequence arrive whether or not anyone asked for them.",
      "Follow through on what earlier scenes set up rather than starting something new each time.",
    ],
    restraints: [
      "Density is for what matters. A quiet line of dialogue does not need a paragraph of atmosphere in front of it, and ornament in place of substance is the failure this engine risks.",
      "Move the plot, never the user. Events happen around and to them; their choices remain theirs.",
    ],
  },
  {
    id: "raw",
    label: "Direct",
    description: "Blunt and physical. Says the thing rather than circling it, and writes adult scenes plainly where Adult Mode allows.",
    tags: ["explicit", "blunt", "physical"],
    thinking: false,
    dials: {
      escalation: "high", pacing: "high", initiative: "high", conflict: "high",
      proseDensity: "low", relationshipProgression: "high", castClarity: "moderate", causalDiscipline: "moderate",
    },
    requirements: [
      "Use concrete, specific language. Name what is happening rather than gesturing at it with euphemism, ellipsis or a fade.",
      "Keep desire messy and particular to this character: what they actually want, how they actually ask, what they will not do.",
      "Where Adult Mode is enabled and the scene has genuinely arrived there, write it directly rather than summarising it.",
    ],
    restraints: [
      "Directness is a manner, not a subject. This engine does not make a conversation sexual — it changes how a scene is written once the scene has got there on its own.",
      "Blunt is not crude-for-its-own-sake, and it is not fast-forward. A character who would hesitate still hesitates; a refusal is still a refusal.",
    ],
  },
  {
    id: "deliberate",
    label: "Complex & Strategic",
    description: "For plots with moving parts. Tracks plans, timing, positions and who knows what, and lets consequences accumulate.",
    tags: ["strategy", "causality", "long plots"],
    thinking: true,
    dials: {
      escalation: "moderate", pacing: "moderate", initiative: "high", conflict: "high",
      proseDensity: "moderate", relationshipProgression: "moderate", castClarity: "high", causalDiscipline: "maximum",
    },
    requirements: [
      "Before writing, settle silently: who is where, what each of them knows and does not know, what they are trying to achieve, and what the last beat made possible or impossible.",
      "Let characters plan, misjudge, adapt and be wrong for reasons the story has established.",
      "Keep the ledger: promises, debts, injuries, deadlines and secrets stay in force until something in the story resolves them.",
    ],
    restraints: [
      "Think, then write in character. The reply is a scene, never an analysis, a summary of options, or a plan presented to the reader.",
      "Rigour is not coldness. A character reasoning carefully is still frightened, tired, or in love while they do it.",
    ],
  },
  {
    id: "multi_clarity",
    label: "Group & Cast",
    description: "For scenes with several characters. Keeps voices, positions and motives distinct so a crowded room stays readable.",
    tags: ["group scenes", "cast", "clarity"],
    thinking: false,
    dials: {
      escalation: "moderate", pacing: "moderate", initiative: "moderate", conflict: "moderate",
      proseDensity: "moderate", relationshipProgression: "moderate", castClarity: "maximum", causalDiscipline: "high",
    },
    requirements: [
      "Make speaker and actor unambiguous every time, without falling back on repeating names in every sentence.",
      "Give characters different things to want in the same scene, and let them react to each other rather than only to the user.",
      "Track physical arrangement: who is near whom, who can hear this, who just left.",
    ],
    restraints: [
      "Not everyone has to speak. A reply that services every character in turn is a roll call, not a scene — let some react in a glance, or not at all.",
      "Distinct is not exaggerated. Do not give characters catchphrases or tics to tell them apart.",
    ],
  },
  {
    id: "kink_aware",
    label: "Power & Kink",
    description: "For negotiated dynamics. Keeps roles, limits, pacing and aftercare coherent instead of flattening kink into generic sex.",
    tags: ["power dynamics", "boundaries", "aftercare"],
    thinking: false,
    dials: {
      escalation: "high", pacing: "moderate", initiative: "high", conflict: "moderate",
      proseDensity: "moderate", relationshipProgression: "moderate", castClarity: "moderate", causalDiscipline: "high",
    },
    requirements: [
      "Treat the dynamic as specific to these people: what this character's dominance or submission actually consists of, what they like about it, and what they will not do.",
      "Keep the difference between fantasy, enthusiastic consent, reluctance, refusal and a hard stop legible at all times. A stop is honoured immediately and in scene.",
      "Let the scene have an after: the return, the check-in, what the two of them are like once it is over.",
    ],
    restraints: [
      "Do not flatten every dynamic into one template of dominance. A dynamic that does not exist between these characters is not introduced by this engine.",
      "This does not set the temperature of the story. It governs how power and negotiation are written when the story is already there.",
    ],
  },
];

const byId = new Map(contracts.map((contract) => [contract.id, contract]));

export function engineContract(engineId: RoleplayEngineId) {
  return byId.get(engineId) ?? byId.get("immersive")!;
}

export function engineContracts() {
  return contracts;
}

/** The catalogue entry a picker renders. */
export function engineDefinitions(): RoleplayEngineDefinition[] {
  return contracts.map((contract) => ({
    id: contract.id,
    label: contract.label,
    description: contract.description,
    thinking: contract.thinking,
    // Every engine works in an adult chat; none of them makes a chat adult.
    // That is Adult Mode's decision, and it belongs to the creation.
    adult: true,
    tags: contract.tags,
  }));
}

const dialOrder: Array<keyof EngineDials> = [
  "escalation", "pacing", "initiative", "conflict",
  "proseDensity", "relationshipProgression", "castClarity", "causalDiscipline",
];

const dialLabel: Record<keyof EngineDials, string> = {
  escalation: "Escalation",
  pacing: "Pacing",
  initiative: "Initiative",
  conflict: "Conflict",
  proseDensity: "Prose density",
  relationshipProgression: "Relationship progression",
  castClarity: "Cast clarity",
  causalDiscipline: "Causal and spatial discipline",
};

/**
 * The engine, as the writer reads it.
 *
 * Named dials with their meaning spelled out, then requirements, then
 * restraints. The dials are what make two engines differ measurably rather than
 * atmospherically: eight dimensions with four settings each, stated as
 * instructions rather than as adjectives.
 */
export function enginePrompt(engineId: RoleplayEngineId) {
  const contract = engineContract(engineId);
  const dials = dialOrder
    .map((dimension) => `- ${dialLabel[dimension]} — ${contract.dials[dimension]}. ${dialText[dimension][contract.dials[dimension]]}`)
    .join("\n");
  return `AFTERGLOW ROLEPLAY ENGINE — ${contract.label.toUpperCase()}
${contract.description}

How this conversation is handled:
${dials}

Requirements for this engine:
${contract.requirements.map((item) => `- ${item}`).join("\n")}

Restraints — this engine must not do these even while doing everything above:
${[...contract.restraints, ...universalRestraints].map((item) => `- ${item}`).join("\n")}`;
}
