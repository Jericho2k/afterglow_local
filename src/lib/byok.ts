import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { query } from "./db";
import type { ModelSelection } from "./llm";

export const byokProvider = "openrouter" as const;
export type ByokMetadata = { connected: boolean; enabled: boolean; provider: typeof byokProvider; suffix: string; validatedAt: string | null };
export type WriterCredential = { fundingSource: "afterglow" | "byok"; apiKey?: string };

export function byokEnabled() {
  if(process.env.ENABLE_BYOK!=="true")return false;
  try{encryptionKey();return true;}catch{return false;}
}

function encryptionKey() {
  const raw = process.env.BYOK_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("BYOK_ENCRYPTION_KEY is not configured");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("BYOK_ENCRYPTION_KEY must encode exactly 32 bytes");
  return key;
}

function aad(userId: string, provider = byokProvider) {
  return Buffer.from(`${userId}:${provider}`, "utf8");
}

export function encryptProviderKey(userId: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(aad(userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: 1 };
}

export function decryptProviderKey(userId: string, value: { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), value.iv);
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(value.auth_tag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8");
}

function encodedForStorage(value:Buffer){return Buffer.from(value.toString("base64"),"utf8");}
function decodedFromStorage(value:Buffer|string){return Buffer.from(Buffer.isBuffer(value)?value.toString("utf8"):value,"base64");}

export async function byokMetadata(userId: string): Promise<ByokMetadata> {
  const result = await query(
    "SELECT key_suffix,enabled,validated_at FROM user_provider_credentials WHERE user_id=$1 AND provider=$2",
    [userId,byokProvider],
  );
  const row = result.rows[0];
  return row ? {
    connected:true, enabled:Boolean(row.enabled), provider:byokProvider,
    suffix:String(row.key_suffix), validatedAt:new Date(String(row.validated_at)).toISOString(),
  } : { connected:false,enabled:false,provider:byokProvider,suffix:"",validatedAt:null };
}

export async function storeProviderKey(userId: string, plaintext: string, enabled = true) {
  const encrypted = encryptProviderKey(userId,plaintext);
  await query(
    `INSERT INTO user_provider_credentials
       (user_id,provider,ciphertext,iv,auth_tag,key_version,key_suffix,enabled,validated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (user_id,provider) DO UPDATE SET
       ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,
       key_version=EXCLUDED.key_version,key_suffix=EXCLUDED.key_suffix,enabled=EXCLUDED.enabled,
       validated_at=now(),updated_at=now()`,
    [userId,byokProvider,encodedForStorage(encrypted.ciphertext),encodedForStorage(encrypted.iv),encodedForStorage(encrypted.authTag),encrypted.keyVersion,plaintext.slice(-4),enabled],
  );
}

export async function setByokEnabled(userId: string, enabled: boolean) {
  const result = await query(
    "UPDATE user_provider_credentials SET enabled=$3,updated_at=now() WHERE user_id=$1 AND provider=$2 RETURNING user_id",
    [userId,byokProvider,enabled],
  );
  return Boolean(result.rowCount);
}

export async function deleteProviderKey(userId: string) {
  await query("DELETE FROM user_provider_credentials WHERE user_id=$1 AND provider=$2",[userId,byokProvider]);
}

export type KeyValidation = { ok:true } | { ok:false; kind:"invalid"|"temporary" };

export async function validateOpenRouterKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation> {
  let response: Response;
  try {
    const timeout=AbortSignal.timeout(8_000);
    const validationSignal=signal?AbortSignal.any([signal,timeout]):timeout;
    response = await fetch(`${(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/,"")}/key`, {
      headers:{ Authorization:`Bearer ${apiKey}` }, signal:validationSignal,
    });
  } catch {
    return { ok:false,kind:"temporary" };
  }
  if (response.ok) return { ok:true };
  if (response.status === 401) return { ok:false,kind:"invalid" };
  return { ok:false,kind:"temporary" };
}

/** Resolve funding once, before a foreground writer request reaches an adapter. */
export async function canUseByok(userId: string, task: string, selection: ModelSelection): Promise<WriterCredential> {
  if (!byokEnabled() || task !== "rp_generation") return { fundingSource:"afterglow" };
  const result = await query(
    "SELECT ciphertext,iv,auth_tag,key_version FROM user_provider_credentials WHERE user_id=$1 AND provider=$2 AND enabled=true",
    [userId,byokProvider],
  );
  const row = result.rows[0];
  if (!row) {
    if(selection.providerId===byokProvider&&!process.env.OPENROUTER_API_KEY?.trim())throw new Error("Connect and enable an OpenRouter key in Settings before using this writer.");
    return { fundingSource:"afterglow" };
  }
  if (selection.providerId !== byokProvider) {
    throw new Error("Your connected OpenRouter key can fund only an OpenRouter model. Choose an OpenRouter model or turn BYOK off in Settings.");
  }
  if (Number(row.key_version) !== 1) throw new Error("Your OpenRouter credential must be reconnected before it can be used.");
  return { fundingSource:"byok", apiKey:decryptProviderKey(userId,{ciphertext:decodedFromStorage(row.ciphertext),iv:decodedFromStorage(row.iv),auth_tag:decodedFromStorage(row.auth_tag)}) };
}
