import { asUser, profileFromRow } from "@/lib/db";
import { currentAccount } from "@/lib/session";
import { supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Who the browser is signed in as. Sign-in, sign-up and sign-out are handled by
 * Supabase Auth directly from the client; this only reports the resolved
 * account plus the application profile that belongs to it.
 */
export async function GET() {
  if (!supabaseConfigured()) {
    return Response.json({ authenticated: false, configured: false, account: null, profile: null });
  }
  const account = await currentAccount();
  if (!account) return Response.json({ authenticated: false, configured: true, account: null, profile: null });

  const profile = await asUser(account.id, async (client) => {
    const existing = await client.query("SELECT * FROM profiles WHERE id=$1", [account.id]);
    if (existing.rowCount) return profileFromRow(existing.rows[0]);
    // Safety net for an account created before the trigger existed.
    const created = await client.query(
      "INSERT INTO profiles (id,display_name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING *",
      [account.id, account.email?.split("@")[0] ?? "Traveller"],
    );
    return profileFromRow(created.rows[0]);
  });

  return Response.json({ authenticated: true, configured: true, account, profile });
}
