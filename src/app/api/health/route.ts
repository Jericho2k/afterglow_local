import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const missing = ["DATABASE_URL", "DEEPSEEK_API_KEY", "APP_PASSWORD", "SESSION_SECRET"].filter((name) => !process.env[name]);
    if (process.env.NODE_ENV === "production" && (missing.length || (process.env.SESSION_SECRET?.length ?? 0) < 32 || (process.env.APP_PASSWORD?.length ?? 0) < 12)) {
      return Response.json({ ok: false, configured: false, missing }, { status: 503 });
    }
    if (process.env.DATABASE_URL) await pool().query("SELECT 1");
    return Response.json({ ok: true, configured: true, database: Boolean(process.env.DATABASE_URL), timestamp: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false, database: false }, { status: 503 });
  }
}
