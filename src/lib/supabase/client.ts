"use client";

import { createBrowserClient } from "@supabase/ssr";

let cached: ReturnType<typeof createBrowserClient> | null = null;

/**
 * Browser Supabase client. Only ever sees the publishable anon key, which is
 * safe to ship: every table it can reach is behind row level security. The
 * service-role key and the DeepSeek credentials never leave the server.
 */
export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase is not configured for this deployment");
  cached ??= createBrowserClient(url, key);
  return cached;
}
