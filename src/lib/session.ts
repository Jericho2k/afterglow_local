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
