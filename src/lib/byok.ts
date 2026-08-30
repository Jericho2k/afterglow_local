import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { query, transaction } from "./db";
import type { ModelSelection } from "./llm";
import type { InferenceTask } from "./provider";

export const byokProvider = "openrouter" as const;
export const currentByokKeyVersion = 1;

export type WriterFundingPreference = "afterglow" | "byok";
export type ByokMetadata = {
  available: boolean;
  connected: boolean;
  enabled: boolean;
  provider: typeof byokProvider;
  suffix: string;
  validatedAt: string | null;
  writerFunding: WriterFundingPreference;
};

/** Authentication/funding for exactly one foreground writer request. */
export type InferenceFunding =
  | { type: "afterglow" }
  | { type: "byok"; provider: typeof byokProvider; credential: string };

export type ByokErrorCode =
  | "feature_disabled"
  | "no_credential"
  | "non_openrouter_model"
  | "server_configuration"
  | "credential_unreadable";

const byokMessages: Record<ByokErrorCode, string> = {
  feature_disabled: "Personal OpenRouter funding is not available right now.",
  no_credential: "Connect your OpenRouter key in Settings.",
  non_openrouter_model: "This model can't use your OpenRouter key. Choose an OpenRouter model or switch writer funding to Afterglow.",
  server_configuration: "Personal OpenRouter funding is not configured correctly on this deployment.",
  credential_unreadable: "Your OpenRouter key could not be read. Reconnect it in Settings.",
};

export class ByokError extends Error {
  readonly code: ByokErrorCode;
  constructor(code: ByokErrorCode) {
    super(byokMessages[code]);
    this.name = "ByokError";
    this.code = code;
  }
}

export function byokFeatureEnabled() {
  return process.env.ENABLE_BYOK === "true";
}

/** Central entitlement hook. Subscription/plan checks can be added here. */
export function canUseByok(account: { id: string }) {
  void account.id;
  return byokFeatureEnabled();
}

function decodeVersionOneKey() {
  const encoded = process.env.BYOK_ENCRYPTION_KEY?.trim();
  if (!encoded) throw new Error("BYOK_ENCRYPTION_KEY is not configured");
  // Buffer.from(base64) is intentionally permissive; reject anything that is
  // not an explicit base64 encoding before decoding it.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error("BYOK_ENCRYPTION_KEY must be a base64-encoded 32-byte secret");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("BYOK_ENCRYPTION_KEY must be a base64-encoded 32-byte secret");
  }
  return key;
}

/** One resolver is the future rotation seam; rows already carry key_version. */
function encryptionKeyForVersion(version: number) {
  if (version === 1) return decodeVersionOneKey();
  throw new Error(`Unsupported BYOK encryption key version: ${version}`);
}

export function validateByokEncryptionConfiguration() {
  encryptionKeyForVersion(currentByokKeyVersion);
}

function associatedData(userId: string, provider: string) {
  return Buffer.from(`afterglow:provider-credential:v1\0${userId}\0${provider}`, "utf8");
}

export type EncryptedProviderKey = {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
};

export function encryptProviderKey(userId: string, provider: typeof byokProvider, plaintext: string): EncryptedProviderKey {
  const keyVersion = currentByokKeyVersion;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKeyForVersion(keyVersion), nonce);
  cipher.setAAD(associatedData(userId, provider));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion };
}

export function decryptProviderKey(userId: string, provider: typeof byokProvider, encrypted: {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
}) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKeyForVersion(encrypted.keyVersion), encrypted.nonce);
  decipher.setAAD(associatedData(userId, provider));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
}

function storedBytes(value: unknown) {
  let encoded: Buffer;
  if (Buffer.isBuffer(value)) encoded = value;
  else if (value instanceof Uint8Array) encoded = Buffer.from(value);
  else if (typeof value === "string") {
    encoded = value.startsWith("\\x") ? Buffer.from(value.slice(2), "hex") : Buffer.from(value, "binary");
  } else {
    throw new Error("Stored credential material has an invalid database encoding");
  }
  const text = encoded.toString("utf8");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("Stored credential material is not base64");
  return Buffer.from(text, "base64");
}

function bytesForStorage(value: Buffer) {
  // Store an explicit base64 representation inside bytea. node-postgres and
  // pg-mem otherwise disagree on arbitrary binary bytea round-trips; this is
  // still ciphertext, merely with a portable database encoding.
  return Buffer.from(value.toString("base64"), "utf8");
}

export async function byokMetadata(userId: string): Promise<ByokMetadata> {
  const [credential, settings] = await Promise.all([
    query("SELECT key_suffix,validated_at FROM user_provider_credentials WHERE user_id=$1 AND provider=$2", [userId, byokProvider]),
    query("SELECT writer_funding FROM user_settings WHERE user_id=$1", [userId]),
  ]);
  const row = credential.rows[0];
  const available = canUseByok({ id: userId });
  const storedFunding: WriterFundingPreference = settings.rows[0]?.writer_funding === "byok" ? "byok" : "afterglow";
  const writerFunding: WriterFundingPreference = available && row && storedFunding === "byok" ? "byok" : "afterglow";
  return {
    available,
    connected: Boolean(row),
    enabled: writerFunding === "byok",
    provider: byokProvider,
    suffix: row ? String(row.key_suffix) : "",
    validatedAt: row ? new Date(String(row.validated_at)).toISOString() : null,
    writerFunding,
  };
}

/** Validate first; only then atomically replace the known-good row. */
export async function storeValidatedProviderKey(userId: string, plaintext: string) {
  const encrypted = encryptProviderKey(userId, byokProvider, plaintext);
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO user_provider_credentials
         (user_id,provider,ciphertext,nonce,auth_tag,key_version,key_suffix,validated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (user_id,provider) DO UPDATE SET
         ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,
         key_version=EXCLUDED.key_version,key_suffix=EXCLUDED.key_suffix,
         validated_at=EXCLUDED.validated_at,updated_at=now()`,
      [userId, byokProvider, bytesForStorage(encrypted.ciphertext), bytesForStorage(encrypted.nonce), bytesForStorage(encrypted.authTag), encrypted.keyVersion, plaintext.slice(-4)],
    );
    await client.query(
      `INSERT INTO user_settings (user_id,writer_funding) VALUES ($1,'byok')
       ON CONFLICT (user_id) DO UPDATE SET writer_funding='byok',updated_at=now()`,
      [userId],
    );
  });
}

export async function setWriterFunding(userId: string, preference: WriterFundingPreference) {
  if (preference === "byok") {
    if (!canUseByok({ id: userId })) throw new ByokError("feature_disabled");
    const credential = await query(
      "SELECT 1 FROM user_provider_credentials WHERE user_id=$1 AND provider=$2",
      [userId, byokProvider],
    );
    if (!credential.rowCount) throw new ByokError("no_credential");
  }
  await query(
    `INSERT INTO user_settings (user_id,writer_funding) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET writer_funding=EXCLUDED.writer_funding,updated_at=now()`,
    [userId, preference],
  );
}

export async function removeProviderKey(userId: string) {
  await transaction(async (client) => {
    await client.query("DELETE FROM user_provider_credentials WHERE user_id=$1 AND provider=$2", [userId, byokProvider]);
    await client.query(
      `INSERT INTO user_settings (user_id,writer_funding) VALUES ($1,'afterglow')
       ON CONFLICT (user_id) DO UPDATE SET writer_funding='afterglow',updated_at=now()`,
      [userId],
    );
  });
}

export type KeyValidation = { ok: true } | { ok: false; kind: "invalid" | "temporary" };

/** Uses OpenRouter's non-inference current-key endpoint; no completion spend. */
export async function validateOpenRouterKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation> {
  try {
    const timeout = AbortSignal.timeout(8_000);
    const validationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const response = await fetch(`${base}/key`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: validationSignal,
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) return { ok: false, kind: "invalid" };
    return { ok: false, kind: "temporary" };
  } catch {
    return { ok: false, kind: "temporary" };
  }
}

/**
 * The sole credential resolver. Its task parameter is deliberately the literal
 * writer task: background task call sites cannot pass their task and receive a
 * user secret accidentally.
 */
export async function resolveWriterFunding(userId: string, task: Extract<InferenceTask, "rp_generation">, selection: ModelSelection): Promise<InferenceFunding> {
  const intent = await preflightWriterFunding(userId, task, selection);
  if (intent.type === "afterglow") return intent;
  const result = await query(
    `SELECT ciphertext,nonce,auth_tag,key_version
     FROM user_provider_credentials WHERE user_id=$1 AND provider=$2`,
    [userId, byokProvider],
  );
  const row = result.rows[0];
  if (!row) throw new ByokError("no_credential");
  try {
    validateByokEncryptionConfiguration();
  } catch {
    throw new ByokError("server_configuration");
  }
  try {
    const credential = decryptProviderKey(userId, byokProvider, {
      ciphertext: storedBytes(row.ciphertext),
      nonce: storedBytes(row.nonce),
      authTag: storedBytes(row.auth_tag),
      keyVersion: Number(row.key_version),
    });
    return { type: "byok", provider: byokProvider, credential };
  } catch {
    throw new ByokError("credential_unreadable");
  }
}

export type WriterFundingIntent = { type: "afterglow" } | { type: "byok"; provider: typeof byokProvider };

/**
 * Checks actionable funding errors before the chat route persists a new user
 * turn, but deliberately does not read or decrypt secret columns.
 */
export async function preflightWriterFunding(userId: string, task: Extract<InferenceTask, "rp_generation">, selection: ModelSelection): Promise<WriterFundingIntent> {
  if (task !== "rp_generation" || !canUseByok({ id: userId })) return { type: "afterglow" };
  const preference = await query("SELECT writer_funding FROM user_settings WHERE user_id=$1", [userId]);
  if (preference.rows[0]?.writer_funding !== "byok") return { type: "afterglow" };
  if (selection.providerId !== byokProvider) throw new ByokError("non_openrouter_model");
  const credential = await query(
    "SELECT 1 FROM user_provider_credentials WHERE user_id=$1 AND provider=$2",
    [userId, byokProvider],
  );
  if (!credential.rowCount) throw new ByokError("no_credential");
  return { type: "byok", provider: byokProvider };
}
