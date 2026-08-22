import { supabaseServer } from "./supabase/server";

export type Account = { id: string; email: string | null };

/**
 * Resolves the caller from the Supabase auth cookies.
 *
 * `getUser()` revalidates the token against the auth server rather than
 * trusting whatever the cookie claims, so a forged or expired session cannot
 * name an account here.
 */
export async function currentAccount(): Promise<Account | null> {
  const supabase = await supabaseServer();
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
