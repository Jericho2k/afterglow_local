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
