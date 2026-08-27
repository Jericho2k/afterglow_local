#!/usr/bin/env node
/**
 * Do the social surfaces hold up at platform scale?
 *
 * The sprint that added rankings, notifications and the Following feed set one
 * rule for all three: no page may aggregate raw data on view, and no list may
 * fan out into a query per row. That is a claim about QUERY PLANS, and reading
 * the SQL cannot settle it — a predicate that looks indexed is only indexed if
 * the planner agrees, and it only agrees once the table is big enough to have
 * an opinion.
 *
 * So this builds a throwaway database at a size the product does not have yet,
 * seeds it with a realistic distribution, and prints the plan and the measured
 * time for every statement the new surfaces run. It reports what it finds,
 * including when the answer is unflattering: the first run of this script is
 * what turned up a 14.8-second ranking rebuild sitting inside a reader's
 * request, which is why `refresh_creation_rankings` now stores only the top of
 * each board and expands tags instead of testing categories.
 *
 * Usage:
 *   node scripts/social-scale-benchmark.mjs                 plans and timings
 *   npx vite-node scripts/social-scale-benchmark.mjs        …and page payloads
 *   … --creations 250000 --creators 5000                    a larger platform
 *
 * Plain `node` runs the SQL half. The payload half imports the application's
 * own TypeScript, so it needs a loader that can read it; without one the script
 * prints the plans and skips the byte counts rather than failing.
 *
 * Requires a local PostgreSQL with pgvector, reachable as the `postgres`
 * superuser: it creates and drops a database of its own.
 */

import { Pool } from "pg";
import { readFileSync } from "node:fs";
const root = new URL("../", import.meta.url).pathname;
const files = ["0000_baseline.sql","0001_multi_tenant_foundation.sql","0003_conversation_inference.sql","0004_product_social.sql","0005_openrouter_usage.sql","0006_memory_retrieval_v2.sql","0007_productization_sprint_1.sql","0008_canonical_generated_user_messages.sql","0009_public_character_profile.sql","0011_creation_model.sql","0012_discovery_feed.sql","0013_scene_state.sql","0014_worlds_v2.sql","0015_rich_content.sql","0016_discovery_preferences.sql","0017_linked_world_previews.sql","0018_memory_feedback.sql","0019_conversation_worlds.sql","0020_scene_physical_state.sql","0021_creator_profile_v2.sql","0022_social_discovery.sql"];
const admin = new Pool({ connectionString: process.env.BENCH_ADMIN_URL || "postgresql://postgres@localhost:5432/postgres", ssl:false, max:1 });
await admin.query("DROP DATABASE IF EXISTS afterglow_perf").catch(()=>{});
await admin.query("CREATE DATABASE afterglow_perf"); await admin.end();
const perfUrl = (process.env.BENCH_ADMIN_URL || "postgresql://postgres@localhost:5432/postgres").replace(/\/[^/]*$/, "/afterglow_perf");
const pool = new Pool({ connectionString: perfUrl, ssl:false, max: 3 });
const c = await pool.connect();
await c.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE;");
await c.query(readFileSync(root+"supabase/testing/auth-shim.sql","utf8"));
// The publish trigger is not what is being measured; a bulk seed would fan out
// millions of notifications. Seed with it detached, then put it back.
for (const f of files) await c.query(readFileSync(root+"supabase/migrations/"+f,"utf8"));
await c.query("ALTER TABLE characters DISABLE TRIGGER character_published_trigger");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? Number(process.argv[index + 1]) || fallback : fallback;
}
const CREATORS = arg("creators", 2000);
const CREATIONS = arg("creations", 120000);
const FOLLOWS = arg("follows", 40000);
const NOTIFICATIONS = arg("notifications", 200000);
console.log(`seeding ${CREATORS} creators, ${CREATIONS} creations, ${FOLLOWS} follows, ${NOTIFICATIONS} notifications…`);
await c.query(`
  INSERT INTO auth.users (id,email)
  SELECT gen_random_uuid(), 'c'||g||'@example.com' FROM generate_series(1,${CREATORS}) g`);
await c.query(`
  UPDATE profiles SET username='creator_'||substr(replace(id::text,'-',''),1,10), display_name='Creator'`);
const genres = ["Romance","Drama","Fantasy","Sci-Fi","Adventure","Horror","Mystery","Comedy","Slice of Life","Historical","Thriller","Supernatural","Post-Apocalyptic","Cyberpunk","Isekai"];
await c.query(`
  INSERT INTO characters (id,user_id,name,title,creation_type,visibility,published_at,tags,user_message_count,message_count,chat_count,like_count)
  SELECT gen_random_uuid(),
         u.id,
         'Creation '||g,'Creation '||g,'character',
         CASE WHEN g % 20 = 0 THEN 'private' ELSE 'public' END,
         now() - (g || ' minutes')::interval,
         ARRAY[($1::text[])[1+floor(random()*15)::int], ($1::text[])[1+floor(random()*15)::int]],
         floor(random()*50000)::int, floor(random()*100000)::int, floor(random()*4000)::int, floor(random()*9000)::int
  FROM generate_series(1,${CREATIONS}) g
  JOIN LATERAL (SELECT id FROM profiles ORDER BY md5(g::text || id::text) LIMIT 1) u ON true`, [genres]);
await c.query(`
  INSERT INTO profile_follows (follower_user_id,creator_user_id)
  SELECT a.id, b.id FROM
    (SELECT id, row_number() OVER () r FROM profiles) a,
    (SELECT id, row_number() OVER () r FROM profiles) b
  WHERE a.id <> b.id AND (a.r * 7919 + b.r) % ${Math.floor(CREATORS*CREATORS/FOLLOWS)} = 0
  ON CONFLICT DO NOTHING`);
const viewer = (await c.query("SELECT follower_user_id FROM profile_follows GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")).rows[0].follower_user_id;
console.log('viewer follows', (await c.query('SELECT count(*)::int c FROM profile_follows WHERE follower_user_id=$1',[viewer])).rows[0].c, 'creators');
await c.query(`
  INSERT INTO notifications (id,user_id,type,actor_user_id,character_id,dedupe_key,created_at,read_at)
  SELECT gen_random_uuid(), f.follower_user_id, 'creation_published', ch.user_id, ch.id,
         'creation_published:'||ch.id, ch.published_at,
         CASE WHEN random() < 0.9 THEN now() ELSE NULL END
  FROM (SELECT id,user_id,published_at FROM characters WHERE visibility='public' LIMIT 40000) ch
  JOIN profile_follows f ON f.creator_user_id = ch.user_id
  ON CONFLICT DO NOTHING`);
await c.query("SELECT public.refresh_creator_stats()");
const t0 = Date.now();
await c.query("SELECT public.refresh_creation_rankings($1::text[],1000)", [genres]);
console.log(`refresh_creation_rankings over ${CREATIONS} creations: ${Date.now()-t0}ms`);
await c.query("ANALYZE");
console.log("rows:", (await c.query("SELECT (SELECT count(*) FROM characters) creations,(SELECT count(*) FROM creation_rankings) ranked,(SELECT count(*) FROM notifications) notifs,(SELECT count(*) FROM profile_follows) follows,(SELECT count(*) FROM creator_stats) creators")).rows[0]);
console.log("unread for viewer:", (await c.query("SELECT count(*)::int c FROM notifications WHERE user_id=$1 AND read_at IS NULL",[viewer])).rows[0].c, "of", (await c.query("SELECT count(*)::int c FROM notifications WHERE user_id=$1",[viewer])).rows[0].c);

async function plan(label, sql, params) {
  const r = await c.query("EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) " + sql, params);
  const text = r.rows.map((x) => x["QUERY PLAN"]).join("\n");
  const time = text.match(/Execution Time: ([\d.]+) ms/)?.[1];
  const scans = [...text.matchAll(/(Seq Scan on \w+|Index Scan using \w+|Index Only Scan using \w+|Bitmap Heap Scan on \w+)/g)].map((m)=>m[1]);
  console.log(`\n--- ${label}: ${time}ms`);
  for (const s of [...new Set(scans)]) console.log("     " + s);
  if (/Seq Scan/.test(text)) console.log("     ⚠ sequential scan present");
}

await plan("Rankings · overall board, first page",
  `SELECT r.rank,r.rank_total,r.user_messages,c.id,c.title,c.like_count,p.username
   FROM creation_rankings r
   JOIN characters c ON c.id=r.character_id AND c.visibility='public'
   LEFT JOIN profiles p ON p.id=c.user_id AND p.username IS NOT NULL
   LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$1
   WHERE r.category='' ORDER BY r.rank ASC LIMIT 26 OFFSET 0`, [viewer]);

await plan("Rankings · Drama board, first page",
  `SELECT r.rank,r.rank_total,r.user_messages,c.id,c.title,c.like_count,p.username
   FROM creation_rankings r
   JOIN characters c ON c.id=r.character_id AND c.visibility='public'
   LEFT JOIN profiles p ON p.id=c.user_id AND p.username IS NOT NULL
   LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$1
   WHERE r.category='Drama' ORDER BY r.rank ASC LIMIT 26 OFFSET 0`, [viewer]);

await plan("Rankings · creators board, first page",
  `SELECT cs.rank,cs.rank_total,cs.user_messages,p.username,top.id
   FROM creator_stats cs
   JOIN profiles p ON p.id=cs.user_id AND p.username IS NOT NULL
   LEFT JOIN profile_follows f ON f.creator_user_id=cs.user_id AND f.follower_user_id=$1
   LEFT JOIN LATERAL (SELECT id FROM characters WHERE user_id=cs.user_id AND visibility='public'
                      ORDER BY user_message_count DESC, like_count DESC, id LIMIT 1) top ON true
   WHERE cs.rank IS NOT NULL ORDER BY cs.rank ASC LIMIT 26 OFFSET 0`, [viewer]);

const rankedCreation = (await c.query("SELECT character_id FROM creation_rankings WHERE category='' ORDER BY rank LIMIT 1")).rows[0].character_id;
await plan("Creation detail · this creation's ranks",
  "SELECT category,rank,rank_total FROM creation_rankings WHERE character_id=$1 ORDER BY rank ASC", [rankedCreation]);

await plan("Following feed · first page",
  `SELECT c.id,c.title FROM characters c
   JOIN profile_follows fw ON fw.creator_user_id=c.user_id AND fw.follower_user_id=$1
   WHERE c.visibility='public' AND c.nsfw_enabled=false
   ORDER BY c.published_at DESC NULLS LAST, c.id DESC LIMIT 25 OFFSET 0`, [viewer]);

await plan("Notifications · unread count (the bell)",
  `SELECT count(*)::int FROM (
     SELECT 1 FROM notifications n
     LEFT JOIN profiles p ON p.id=n.actor_user_id
     JOIN characters c ON c.id=n.character_id AND c.visibility='public'
     WHERE n.user_id=$1 AND n.read_at IS NULL LIMIT 100) x`, [viewer]);

await plan("Notifications · first page",
  `SELECT n.id,n.created_at,c.title FROM notifications n
   LEFT JOIN profiles p ON p.id=n.actor_user_id
   JOIN characters c ON c.id=n.character_id AND c.visibility='public'
   WHERE n.user_id=$1 ORDER BY n.created_at DESC, n.id DESC LIMIT 21`, [viewer]);

/*
 * And what a page actually WEIGHS.
 *
 * A plan that is fast and a payload that is enormous are the same defect from
 * the reader's side, so the rich surfaces are also measured in queries and in
 * bytes. The creator profile is the one to watch: it is the page that could
 * most easily start shipping greetings, world lore and creation definitions to
 * a browser that draws none of them.
 */
process.env.DATABASE_URL = perfUrl;
const { pool: appPool } = await import("../src/lib/db.ts").catch(() => ({ pool: null }));
if (appPool) {
  const { creatorProfilePayload } = await import("../src/lib/creator-profile.ts");
  const { listNotifications, unreadNotificationCount } = await import("../src/lib/notifications.ts");
  const { rankedCreators, creationRanks } = await import("../src/lib/ranking-store.ts");
  const app = await appPool().connect();
  async function counted(fn) {
    const original = app.query.bind(app);
    let queries = 0;
    app.query = (...args) => { queries += 1; return original(...args); };
    const started = Date.now();
    const value = await fn(app);
    const ms = Date.now() - started;
    app.query = original;
    return { queries, ms, bytes: Buffer.byteLength(JSON.stringify(value ?? null)) };
  }
  const creatorRow = (await app.query("SELECT p.* FROM creator_stats cs JOIN profiles p ON p.id=cs.user_id ORDER BY cs.rank LIMIT 1")).rows[0];
  const topCreation = (await app.query("SELECT id FROM characters WHERE visibility='public' ORDER BY user_message_count DESC LIMIT 1")).rows[0].id;
  const measured = [
    ["Creator profile (whole page)", await counted((cl) => creatorProfilePayload(cl, { row: creatorRow, viewerId: viewer, sort: "popular", filter: "all" }))],
    ["Notifications first page", await counted((cl) => listNotifications(cl, viewer, { limit: 20 }))],
    ["Notifications unread count", await counted((cl) => unreadNotificationCount(cl, viewer))],
    ["Rankings creators first page", await counted((cl) => rankedCreators(cl, viewer, { limit: 25, offset: 0 }))],
    ["Creation detail rank lookup", await counted((cl) => creationRanks(cl, topCreation))],
  ];
  console.log("\n" + "surface".padEnd(32) + "queries".padStart(8) + "ms".padStart(7) + "payload".padStart(11));
  for (const [label, r] of measured) {
    console.log(label.padEnd(32) + String(r.queries).padStart(8) + String(r.ms).padStart(7) + `${(r.bytes / 1024).toFixed(1)} KB`.padStart(11));
  }
  app.release();
  await appPool().end();
}

c.release(); await pool.end();
