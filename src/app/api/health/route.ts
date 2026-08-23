import { ensureSchema, pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const required = ["DATABASE_URL", "DEEPSEEK_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  const missing = required.filter((name) => !process.env[name]);
  if (process.env.NODE_ENV === "production" && missing.length) {
    console.error("health_check_misconfigured", { missing });
    return Response.json({ ok: false, configured: false, missing }, { status: 503 });
  }

  try {
    if (process.env.DATABASE_URL) {
      // A database socket alone is not enough to serve the application. Run
      // the same cached schema/bootstrap path used by authenticated routes so
      // ownership-constraint or migration mismatches fail health checks before
      // users discover them during sign-in.
      await ensureSchema();
      await pool().query("SELECT 1");
    }
    return Response.json({ ok: true, configured: true, database: Boolean(process.env.DATABASE_URL), timestamp: new Date().toISOString() });
  } catch (error) {
    // Liveness, not readiness. The platform restarts the container when this
    // fails, so failing on an unreachable database turns a dependency outage
    // into a restart loop and the app never comes up to explain itself. The
    // failure is reported instead — in the body and in the platform log — so
    // a wrong host, rejected credentials and an unapplied migration stay
    // distinguishable. Missing configuration above still fails, because that
    // never self-heals and should block a rollout.
    const reason = error instanceof Error ? error.message : String(error);
    console.error("health_check_database_unreachable", { reason });
    return Response.json({ ok: true, configured: true, database: false, databaseError: reason, timestamp: new Date().toISOString() });
  }
}
