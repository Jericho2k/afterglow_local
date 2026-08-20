import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const required = ["DATABASE_URL", "DEEPSEEK_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
    const missing = required.filter((name) => !process.env[name]);
    if (process.env.NODE_ENV === "production" && missing.length) {
      return Response.json({ ok: false, configured: false, missing }, { status: 503 });
    }
    if (process.env.DATABASE_URL) await pool().query("SELECT 1");
    return Response.json({ ok: true, configured: true, database: Boolean(process.env.DATABASE_URL), timestamp: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false, database: false }, { status: 503 });
  }
}
