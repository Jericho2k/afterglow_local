function boolEnv(name:string,fallback=false) {
  const value=process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value==="1"||value==="true"||value==="yes"||value==="on";
}

/** Fail-closed owner/test rollout. Broad enablement needs its own explicit flag. */
export function memoryRetrievalV2Enabled(userId:string) {
  if (!boolEnv("MEMORY_RETRIEVAL_V2_ENABLED")) return false;
  const allow=(process.env.MEMORY_RETRIEVAL_V2_USER_IDS || "").split(",").map((value)=>value.trim()).filter(Boolean);
  return allow.includes(userId)||(allow.length===0&&boolEnv("MEMORY_RETRIEVAL_V2_ALL_USERS"));
}

export function memorySemanticEnabled() { return boolEnv("MEMORY_SEMANTIC_ENABLED",true); }

/**
 * Scene State (temporal/spatial grounding) rollout.
 *
 * Deliberately independent of Memory Retrieval V2 so a conversation can be
 * compared with the layer on and off without changing which memories are
 * retrieved. Fail-closed on the same owner/test allowlist shape.
 */
export function sceneStateEnabled(userId:string) {
  if (!boolEnv("SCENE_STATE_ENABLED")) return false;
  const allow=(process.env.SCENE_STATE_USER_IDS || "").split(",").map((value)=>value.trim()).filter(Boolean);
  return allow.includes(userId)||(allow.length===0&&boolEnv("SCENE_STATE_ALL_USERS"));
}

/**
 * Whether current-scene entities may join the retrieval query.
 *
 * Off by default: Scene State exists to interpret retrieved memories, not to
 * select them, and any ranking effect has to be measured on its own.
 */
export function sceneStateRetrievalHintEnabled() { return boolEnv("SCENE_STATE_RETRIEVAL_HINT_ENABLED",false); }
