import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAccount, createAccount, migratedPool, tenancyDatabaseUrl } from "./helpers/tenancy";

/**
 * Notifications and rankings, against the real schema.
 *
 * These need an actual PostgreSQL: the whole of the notification design is a
 * trigger, a SECURITY DEFINER fanout and a unique index, and pg-mem implements
 * none of the three. So the properties that matter — that a draft notifies
 * nobody, that publishing twice notifies once, that an unfollowed creator's
 * next release is silent, and that no account can write another account's
 * notifications — are checked where they are actually enforced.
 *
 * Skipped when TEST_DATABASE_URL is absent so `npm test` still runs anywhere;
 * CI provides a PostgreSQL service so these do run there.
 */
const describeSocial = tenancyDatabaseUrl ? describe : describe.skip;

const creator = "a1a1a1a1-1111-4111-8111-111111111111";
const reader = "b2b2b2b2-2222-4222-8222-222222222222";
const bystander = "c3c3c3c3-3333-4333-8333-333333333333";

describeSocial("social discovery", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await migratedPool({ database: "social" });
  });

  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    // Every test starts from nothing, because notifications are about WHEN
    // things happened relative to each other.
    await pool.query("DELETE FROM notifications");
    await pool.query("DELETE FROM profile_follows");
    await pool.query("DELETE FROM creation_rankings");
    await pool.query("DELETE FROM characters");
    await pool.query("DELETE FROM auth.users");
    await createAccount(pool, creator, "creator@example.com");
    await createAccount(pool, reader, "reader@example.com");
    await createAccount(pool, bystander, "bystander@example.com");
    await pool.query("UPDATE profiles SET username='noctis', display_name='Noctis' WHERE id=$1", [creator]);
  });

  async function follow() {
    await asAccount(pool, reader, (run) => run(
      "INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2)", [reader, creator]));
  }

  async function publish(id: string, name = "Elysia", tags: string[] = ["Drama"]) {
    await asAccount(pool, creator, (run) => run(
      `INSERT INTO characters (id,user_id,name,title,creation_type,visibility,published_at,tags)
       VALUES ($1,$2,$3,$3,'character','public',now(),$4::text[])`,
      [id, creator, name, tags],
    ));
  }

  async function notificationsFor(userId: string) {
    return asAccount(pool, userId, async (run) => {
      const result = await run("SELECT id,type,character_id,actor_user_id,read_at FROM notifications ORDER BY created_at");
      return result.rows;
    });
  }

  const creation = (suffix: string) => `dddddddd-0000-4000-8000-0000000000${suffix}`;

  // -------------------------------------------------------------- generation

  it("tells a follower when a creator publishes a public character", async () => {
    await follow();
    await publish(creation("01"));
    const rows = await notificationsFor(reader);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("creation_published");
    expect(String(rows[0].character_id)).toBe(creation("01"));
    expect(String(rows[0].actor_user_id)).toBe(creator);
    expect(rows[0].read_at).toBe(null);
  });

  it("tells a follower about a cast and a scenario too", async () => {
    await follow();
    await asAccount(pool, creator, (run) => run(
      `INSERT INTO characters (id,user_id,name,title,creation_type,visibility,published_at)
       VALUES ($1,$2,'Roommates','Roommates','cast','public',now()),
              ($3,$2,'The Last Dance','The Last Dance','scenario','public',now())`,
      [creation("02"), creator, creation("03")],
    ));
    expect(await notificationsFor(reader)).toHaveLength(2);
  });

  it("says nothing about a draft", async () => {
    await follow();
    await asAccount(pool, creator, (run) => run(
      "INSERT INTO characters (id,user_id,name,visibility) VALUES ($1,$2,'Unfinished','private')", [creation("04"), creator]));
    expect(await notificationsFor(reader)).toHaveLength(0);
  });

  it("says nothing about an unlisted creation", async () => {
    await follow();
    await asAccount(pool, creator, (run) => run(
      "INSERT INTO characters (id,user_id,name,visibility) VALUES ($1,$2,'Link Only','unlisted')", [creation("05"), creator]));
    expect(await notificationsFor(reader)).toHaveLength(0);
  });

  it("tells nobody who does not follow the creator", async () => {
    await follow();
    await publish(creation("06"));
    expect(await notificationsFor(bystander)).toHaveLength(0);
  });

  it("does not tell the creator about their own release", async () => {
    await follow();
    await publish(creation("07"));
    expect(await notificationsFor(creator)).toHaveLength(0);
  });

  /*
   * Idempotency, which is a property of the unique index rather than of
   * whoever writes the row. A creation that goes public, private and public
   * again is one release.
   */
  it("does not notify twice for the same creation", async () => {
    await follow();
    await publish(creation("08"));
    await asAccount(pool, creator, (run) => run(
      "UPDATE characters SET visibility='private',published_at=NULL WHERE id=$1", [creation("08")]));
    await asAccount(pool, creator, (run) => run(
      "UPDATE characters SET visibility='public',published_at=now() WHERE id=$1", [creation("08")]));
    // And directly, the way a retried job would.
    await pool.query("SELECT public.fanout_creation_notifications($1)", [creation("08")]);
    expect(await notificationsFor(reader)).toHaveLength(1);
  });

  it("does not notify when an already-public creation is merely edited", async () => {
    await follow();
    await publish(creation("09"));
    await asAccount(pool, creator, (run) => run(
      "UPDATE characters SET name='Elysia Revised',updated_at=now() WHERE id=$1", [creation("09")]));
    expect(await notificationsFor(reader)).toHaveLength(1);
  });

  it("stops notifying once the reader unfollows", async () => {
    await follow();
    await publish(creation("10"));
    await asAccount(pool, reader, (run) => run(
      "DELETE FROM profile_follows WHERE follower_user_id=$1 AND creator_user_id=$2", [reader, creator]));
    await publish(creation("11"), "Kaelen");
    expect(await notificationsFor(reader)).toHaveLength(1);
  });

  /*
   * No retroactive history. Following somebody does not deliver the back
   * catalogue of releases nobody was told about at the time.
   */
  it("does not invent notifications for releases that predate the follow", async () => {
    await publish(creation("12"));
    await follow();
    expect(await notificationsFor(reader)).toHaveLength(0);
  });

  it("takes the notification with the creation when it is deleted", async () => {
    await follow();
    await publish(creation("13"));
    expect(await notificationsFor(reader)).toHaveLength(1);
    await asAccount(pool, creator, (run) => run("DELETE FROM characters WHERE id=$1", [creation("13")]));
    expect(await notificationsFor(reader)).toHaveLength(0);
  });

  // ------------------------------------------------------------------ access

  it("lets an account read only its own notifications", async () => {
    await follow();
    await publish(creation("14"));
    expect(await notificationsFor(reader)).toHaveLength(1);
    expect(await notificationsFor(bystander)).toHaveLength(0);
    const asBystander = await asAccount(pool, bystander, (run) => run("SELECT count(*)::int count FROM notifications"));
    expect(Number(asBystander.rows[0].count)).toBe(0);
  });

  it("lets an account mark only its own notifications read", async () => {
    await follow();
    await publish(creation("15"));
    const id = String((await notificationsFor(reader))[0].id);

    await asAccount(pool, bystander, async (run) => {
      const updated = await run("UPDATE notifications SET read_at=now() WHERE id=$1", [id]);
      expect(updated.rowCount).toBe(0);
    });
    expect((await notificationsFor(reader))[0].read_at).toBe(null);

    await asAccount(pool, reader, (run) => run("UPDATE notifications SET read_at=now() WHERE id=$1", [id]));
    expect((await notificationsFor(reader))[0].read_at).not.toBe(null);
  });

  /*
   * No account can create a notification at all — not for somebody else, and
   * not for itself. There is no insert policy, which is what makes "a creator
   * cannot spam their followers" a property of the schema.
   */
  it("refuses to let any account write a notification", async () => {
    await expect(asAccount(pool, creator, (run) => run(
      `INSERT INTO notifications (id,user_id,type,actor_user_id,dedupe_key)
       VALUES (gen_random_uuid(),$1,'creation_published',$2,'spam')`, [reader, creator],
    ))).rejects.toThrow(/permission denied|row-level security/i);

    await expect(asAccount(pool, reader, (run) => run(
      `INSERT INTO notifications (id,user_id,type,actor_user_id,dedupe_key)
       VALUES (gen_random_uuid(),$1,'creation_published',$1,'self')`, [reader],
    ))).rejects.toThrow(/permission denied|row-level security/i);
  });

  /*
   * Marking one read, against a real PostgreSQL.
   *
   * The route's own suite runs on pg-mem, which cannot evaluate
   * `id = ANY($2::uuid[])` at all, so the by-id path is verified here instead
   * of being rewritten into a shape a fake database can manage.
   */
  it("marks exactly the notifications it was given, once", async () => {
    await follow();
    await publish(creation("16"));
    await publish(creation("17"), "Kaelen");
    const rows = await notificationsFor(reader);
    expect(rows).toHaveLength(2);
    const target = String(rows[0].id);

    const { markNotificationsRead, unreadNotificationCount } = await import("@/lib/notifications");
    const first = await asAccount(pool, reader, async () => {
      const client = await pool.connect();
      try {
        await client.query("SET LOCAL ROLE authenticated");
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: reader, role: "authenticated" })]);
        const marked = await markNotificationsRead(client, reader, [target]);
        const unread = await unreadNotificationCount(client, reader);
        return { marked, unread };
      } finally { client.release(); }
    });
    expect(first.marked).toBe(1);
    expect(first.unread).toBe(1);

    const after = await notificationsFor(reader);
    expect(after.find((row) => String(row.id) === target)?.read_at).not.toBe(null);
    expect(after.filter((row) => row.read_at === null)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- rankings

  async function ranked(category: string) {
    return asAccount(pool, reader, async (run) => {
      const result = await run(
        "SELECT character_id,rank,rank_total,user_messages FROM creation_rankings WHERE category=$1 ORDER BY rank",
        [category],
      );
      return result.rows;
    });
  }

  async function seedBoard() {
    await asAccount(pool, creator, (run) => run(
      `INSERT INTO characters (id,user_id,name,title,visibility,published_at,tags,user_message_count,like_count)
       VALUES ($1,$5,'Top','Top','public',now() - interval '3 days',ARRAY['Drama','Romance'],500,10),
              ($2,$5,'Middle','Middle','public',now() - interval '2 days',ARRAY['Drama'],200,4),
              ($3,$5,'Quiet','Quiet','public',now() - interval '1 day',ARRAY['Romance'],10,1),
              ($4,$5,'Hidden','Hidden','private',NULL,ARRAY['Drama'],9000,99)`,
      [creation("20"), creation("21"), creation("22"), creation("23"), creator],
    ));
    await pool.query("SELECT public.refresh_creation_rankings($1::text[])", [["Drama", "Romance", "Fantasy"]]);
  }

  it("orders the overall board by user messages", async () => {
    await seedBoard();
    const board = await ranked("");
    expect(board.map((row) => String(row.character_id))).toEqual([creation("20"), creation("21"), creation("22")]);
    expect(Number(board[0].user_messages)).toBe(500);
    expect(Number(board[0].rank_total)).toBe(3);
  });

  it("puts a creation only in the categories it actually carries", async () => {
    await seedBoard();
    expect((await ranked("Drama")).map((row) => String(row.character_id)))
      .toEqual([creation("20"), creation("21")]);
    expect((await ranked("Romance")).map((row) => String(row.character_id)))
      .toEqual([creation("20"), creation("22")]);
    expect(await ranked("Fantasy")).toHaveLength(0);
  });

  it("ranks within the category, not the platform", async () => {
    await seedBoard();
    const romance = await ranked("Romance");
    // Quiet is third overall and second in Romance.
    expect(Number(romance[1].rank)).toBe(2);
    expect(Number(romance[1].rank_total)).toBe(2);
  });

  it("never ranks a private creation, however busy it is", async () => {
    await seedBoard();
    const everything = await asAccount(pool, reader, (run) => run(
      "SELECT count(*)::int count FROM creation_rankings WHERE character_id=$1", [creation("23")]));
    expect(Number(everything.rows[0].count)).toBe(0);
  });

  it("drops a creation from every board the moment it is unpublished", async () => {
    await seedBoard();
    expect(await ranked("Drama")).toHaveLength(2);
    await asAccount(pool, creator, (run) => run(
      "UPDATE characters SET visibility='private' WHERE id=$1", [creation("21")]));
    await pool.query("SELECT public.refresh_creation_rankings($1::text[])", [["Drama", "Romance"]]);
    expect((await ranked("Drama")).map((row) => String(row.character_id))).toEqual([creation("20")]);
  });

  it("drops a category the moment its tag is removed", async () => {
    await seedBoard();
    await asAccount(pool, creator, (run) => run(
      "UPDATE characters SET tags=ARRAY['Drama'] WHERE id=$1", [creation("20")]));
    await pool.query("SELECT public.refresh_creation_rankings($1::text[])", [["Drama", "Romance"]]);
    expect((await ranked("Romance")).map((row) => String(row.character_id))).toEqual([creation("22")]);
  });

  it("is a total order, so no two creations share a position", async () => {
    await asAccount(pool, creator, (run) => run(
      `INSERT INTO characters (id,user_id,name,title,visibility,published_at,tags,user_message_count,like_count)
       VALUES ($1,$3,'Tied A','Tied A','public',now(),ARRAY['Drama'],100,5),
              ($2,$3,'Tied B','Tied B','public',now(),ARRAY['Drama'],100,5)`,
      [creation("30"), creation("31"), creator],
    ));
    await pool.query("SELECT public.refresh_creation_rankings($1::text[])", [["Drama"]]);
    const board = await ranked("Drama");
    expect(board.map((row) => Number(row.rank))).toEqual([1, 2]);
    // And the same order every time it is rebuilt.
    await pool.query("SELECT public.refresh_creation_rankings($1::text[])", [["Drama"]]);
    expect((await ranked("Drama")).map((row) => String(row.character_id)))
      .toEqual(board.map((row) => String(row.character_id)));
  });

  // ---------------------------------------------------------- creators board

  /**
   * The creators board, through the same function the route runs.
   *
   * pg-mem cannot evaluate its LATERAL — a correlated reference to an outer
   * alias — so this is where the query is actually exercised rather than a
   * second copy of it in a route test.
   */
  async function creatorsBoard(viewerId: string) {
    const { rankedCreators } = await import("@/lib/ranking-store");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: viewerId, role: "authenticated" })]);
      const rows = await rankedCreators(client, viewerId, { limit: 25, offset: 0 });
      await client.query("COMMIT");
      return rows;
    } finally { client.release(); }
  }

  it("lists ranked creators with their real totals and their best work", async () => {
    await seedBoard();
    await pool.query("SELECT public.refresh_creator_stats()");
    const [top] = await creatorsBoard(reader);
    expect(top.rank).toBe(1);
    expect(top.username).toBe("noctis");
    expect(top.displayName).toBe("Noctis");
    // 500 + 200 + 10 across the three public creations; the private one's
    // nine thousand is not a creator's public standing.
    expect(top.messages).toBe(710);
    expect(top.creations).toBe(3);
    expect(top.topCreation?.id).toBe(creation("20"));
    expect(top.topCreation?.messages).toBe(500);
  });

  it("reports the viewer's own follow state and nobody else's", async () => {
    await seedBoard();
    await pool.query("SELECT public.refresh_creator_stats()");
    expect((await creatorsBoard(reader))[0].viewerFollows).toBe(false);
    await follow();
    expect((await creatorsBoard(reader))[0].viewerFollows).toBe(true);
    // Bob follows; the bystander's board says nothing about that.
    const other = await creatorsBoard(bystander);
    expect(other[0].viewerFollows).toBe(false);
    expect(JSON.stringify(other)).not.toContain(reader);
  });

  it("never lists a creator who has not opted into a public profile", async () => {
    await seedBoard();
    await pool.query("SELECT public.refresh_creator_stats()");
    expect(await creatorsBoard(reader)).toHaveLength(1);
    await pool.query("UPDATE profiles SET username=NULL WHERE id=$1", [creator]);
    expect(await creatorsBoard(reader)).toEqual([]);
  });

  /*
   * The boards are stored to a depth, and the depth does not change what any
   * number means. `rank_total` is the size of the whole field, not the size of
   * what was kept, so "#5 of 12,480" stays true however deep the board is.
   */
  it("stores only the top of a board, and still reports the true field size", async () => {
    const values: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      values.push(`(gen_random_uuid(),'${creator}','Bulk ${index}','Bulk ${index}','public',now(),ARRAY['Drama'],${1000 - index * 10})`);
    }
    await asAccount(pool, creator, (run) => run(
      `INSERT INTO characters (id,user_id,name,title,visibility,published_at,tags,user_message_count) VALUES ${values.join(",")}`));
    await pool.query("SELECT public.refresh_creation_rankings($1::text[],$2)", [["Drama"], 5]);
    const board = await ranked("Drama");
    expect(board).toHaveLength(5);
    expect(board.map((row) => Number(row.rank))).toEqual([1, 2, 3, 4, 5]);
    // Twelve were eligible; five were kept; the field is still twelve.
    expect(Number(board[0].rank_total)).toBe(12);
  });

  it("publishes the boards and lets nobody write them", async () => {
    await seedBoard();
    await expect(asAccount(pool, reader, (run) => run(
      "UPDATE creation_rankings SET rank=1 WHERE character_id=$1", [creation("22")],
    ))).rejects.toThrow(/permission denied|row-level security/i);
    await expect(asAccount(pool, reader, (run) => run(
      "INSERT INTO creation_rankings (character_id,category,rank) VALUES ($1,'',1)", [creation("22")],
    ))).rejects.toThrow(/permission denied|row-level security/i);
  });
});
