import { createHash } from "node:crypto";
import type { LLMMessage } from "./llm";
import { estimateTokens } from "./context";

export type WriterCacheProbeState = {
  version: 1;
  modelId: string;
  upstreamOverride: string | null;
  messages: Array<{ role: LLMMessage["role"]; hash: string; tokens: number }>;
  totalTokens: number;
  firstTranscriptHash: string | null;
};

export type WriterCacheProbeComparison = {
  structuralPrefixTokens: number;
  structuralRatio: number;
  sharedMessages: number;
  totalMessages: number;
  previousAvailable: boolean;
  sameModel: boolean;
  sameUpstreamOverride: boolean;
  anchorMoved: boolean | null;
  divergenceRole: LLMMessage["role"] | null;
};

function fingerprint(role: LLMMessage["role"], content: string) {
  return createHash("sha256").update(role).update("\0").update(content).digest("hex");
}

/**
 * Stores hashes and token counts only — never prompt text.
 *
 * The point is to compare what Afterglow COULD have reused with what the
 * provider actually reported as cached, without persisting a private roleplay
 * prompt for diagnostics.
 */
export function buildWriterCacheProbe(
  messages: LLMMessage[],
  modelId: string,
  upstreamOverride?: string | null,
): WriterCacheProbeState {
  const rows = messages.map((message) => ({
    role: message.role,
    hash: fingerprint(message.role, message.content),
    tokens: estimateTokens(`<${message.role}>${message.content}\n`),
  }));
  const firstTranscript = rows.slice(1).find((row) => row.role === "user" || row.role === "assistant") ?? null;
  return {
    version: 1,
    modelId,
    upstreamOverride: upstreamOverride?.trim() || null,
    messages: rows,
    totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    firstTranscriptHash: firstTranscript?.hash ?? null,
  };
}

export function parseWriterCacheProbe(value: unknown): WriterCacheProbeState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<WriterCacheProbeState>;
  if (row.version !== 1 || typeof row.modelId !== "string" || !Array.isArray(row.messages)) return null;
  const messages = row.messages.filter((item): item is WriterCacheProbeState["messages"][number] =>
    Boolean(item) && typeof item === "object"
    && ["system", "user", "assistant"].includes(String((item as { role?: unknown }).role))
    && typeof (item as { hash?: unknown }).hash === "string"
    && Number.isFinite(Number((item as { tokens?: unknown }).tokens))
  ).map((item) => ({ role: item.role, hash: item.hash, tokens: Math.max(0, Number(item.tokens) || 0) }));
  return {
    version: 1,
    modelId: row.modelId,
    upstreamOverride: typeof row.upstreamOverride === "string" && row.upstreamOverride ? row.upstreamOverride : null,
    messages,
    totalTokens: Math.max(0, Number(row.totalTokens) || messages.reduce((sum, item) => sum + item.tokens, 0)),
    firstTranscriptHash: typeof row.firstTranscriptHash === "string" ? row.firstTranscriptHash : null,
  };
}

/**
 * Conservative lower bound: only complete messages that are byte-identical are
 * credited. If a provider can reuse a prefix inside the first changed message,
 * actual caching can legitimately exceed this number.
 */
export function compareWriterCacheProbe(
  previous: WriterCacheProbeState | null,
  current: WriterCacheProbeState,
): WriterCacheProbeComparison {
  const sameModel = previous?.modelId === current.modelId;
  const sameUpstreamOverride = (previous?.upstreamOverride ?? null) === current.upstreamOverride;
  if (!previous || !sameModel || !sameUpstreamOverride) {
    return {
      structuralPrefixTokens: 0,
      structuralRatio: 0,
      sharedMessages: 0,
      totalMessages: current.messages.length,
      previousAvailable: Boolean(previous),
      sameModel,
      sameUpstreamOverride,
      anchorMoved: previous ? previous.firstTranscriptHash !== current.firstTranscriptHash : null,
      divergenceRole: current.messages[0]?.role ?? null,
    };
  }

  let sharedMessages = 0;
  let structuralPrefixTokens = 0;
  while (
    sharedMessages < previous.messages.length
    && sharedMessages < current.messages.length
    && previous.messages[sharedMessages].role === current.messages[sharedMessages].role
    && previous.messages[sharedMessages].hash === current.messages[sharedMessages].hash
  ) {
    structuralPrefixTokens += current.messages[sharedMessages].tokens;
    sharedMessages += 1;
  }

  return {
    structuralPrefixTokens,
    structuralRatio: current.totalTokens > 0 ? structuralPrefixTokens / current.totalTokens : 0,
    sharedMessages,
    totalMessages: current.messages.length,
    previousAvailable: true,
    sameModel: true,
    sameUpstreamOverride: true,
    anchorMoved: previous.firstTranscriptHash !== current.firstTranscriptHash,
    divergenceRole: current.messages[sharedMessages]?.role ?? null,
  };
}
