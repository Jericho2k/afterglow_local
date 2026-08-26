import { supabaseServer } from "./supabase/server";

export type Account = { id: string; email: string | null };

/**
 * Resolves the caller from the Supabase auth cookies.
 *
 * The identity is always VERIFIED, never merely decoded — a forged or expired
 * cookie cannot name an account here. What changed is the cost of verifying
 * it.
 *
 * `getUser()` asks the auth server on every single call, which put a full
 * network round trip in front of every authenticated request in the product.
 * `getClaims()` verifies the token's signature instead, locally, against the
 * project's cached JWKS. It is not a weaker check: on a project still signing
 * with a symmetric secret — where a signature cannot be verified without the
 * secret — it sends exactly the request `getUser()` would, and it refreshes an
 * about-to-expire session first either way. So this is the same guarantee for
 * less latency on modern projects, and identical behaviour on old ones.
 *
 * `getUser()` remains the fallback for any environment where claim
 * verification is unavailable (an older auth-js, or a runtime without
 * WebCrypto). Failing closed is the rule: anything that does not produce a
 * verified subject resolves to null.
 */
export async function currentAccount(): Promise<Account | null> {
  const supabase = await supabaseServer();
  const auth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{ data: { claims?: { sub?: unknown; email?: unknown } } | null; error: unknown }>;
  };
  if (typeof auth.getClaims === "function") {
    try {
      const { data, error } = await auth.getClaims();
      const subject = data?.claims?.sub;
      if (!error && typeof subject === "string" && subject) {
        const email = data?.claims?.email;
        return { id: subject, email: typeof email === "string" ? email : null };
      }
      // A present-but-unverifiable token is a refusal, not a reason to ask a
      // second time with a weaker question.
      if (!error) return null;
    } catch { /* Fall through to the auth server. */ }
  }
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

export function unauthorized() {
  return Response.json({ error: "Sign in to continue" }, { status: 401 });
}

export function forbidden(message = "You do not have access to that") {
  return Response.json({ error: message }, { status: 403 });
}

function configuredAdminIds() {
  // MEMORY_RETRIEVAL_V2_USER_IDS is retained as a transition fallback so the
  // existing owner/test account does not lose its tools during the first
  // deployment. AFTERGLOW_ADMIN_USER_IDS is the explicit long-term setting.
  const configured = process.env.AFTERGLOW_ADMIN_USER_IDS?.trim() || process.env.MEMORY_RETRIEVAL_V2_USER_IDS?.trim() || "";
  return new Set(configured.split(",").map((value)=>value.trim().toLowerCase()).filter(Boolean));
}

export function isAdminAccount(account: Account) {
  return configuredAdminIds().has(account.id.toLowerCase());
}

export function adminRequired(account: Account) {
  return isAdminAccount(account) ? null : forbidden("Memory diagnostics are available only to an Afterglow administrator");
}
