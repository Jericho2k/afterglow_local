import { createClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./server";

/**
 * Service-role client. Bypasses row level security completely, so it is
 * deliberately kept out of every ordinary CRUD path — those run as the calling
 * account through `userQuery`/`userTransaction` and are policed by RLS.
 *
 * Reserved for operations that have no authenticated caller by definition, such
 * as the legacy-owner migration script. Never import this from a route that
 * serves a browser request.
 */
export function supabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return createClient(supabaseUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
