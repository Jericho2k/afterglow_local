import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The discovery feed's data contract.
 *
 * The feed is the one surface that shows other people's work to everybody, so
 * these assert what it must never do — expose a draft, an unlisted creation or
 * a hidden AI definition — alongside what it must: rank by real aggregates,
 * keep the platform taxonomy and creator hashtags apart, and answer a page in
 * a single statement.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
let account: { id: string; email: string | null } | null = null;

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({
  streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, pool, query, setPoolForTesting } = await import("@/lib/db");
const discovery = await import("@/app/api/discovery/route");
const saves = await import("@/app/api/saves/route");

const seraphine = "aaaaaaaa-0000-4000-8000-000000000001";
const finalWar = "aaaaaaaa-0000-4000-8000-000000000002";
const roommates = "aaaaaaaa-0000-4000-8000-000000000003";
const draft = "aaaaaaaa-0000-4000-8000-000000000004";
const unlisted = "aaaaaaaa-0000-4000-8000-000000000005";

type Summary = {
  id: string; title: string; name: string; creationType: string; tagline: string;
  tags: string[]; hashtags: string[]; contentMode: string; nsfwEnabled: boolean;
  messageCount: number; chatCount: number; saveCount: number; savedByViewer: boolean;
  ownedByViewer: boolean; creator: { username: string } | null;
};

/** The route exactly as a caller writes it, with no opt-in added. */
async function rawFeed(search = "") {
  const response = await discovery.GET(new Request(`http://test/api/discovery${search}`));
  const body = await response.json() as {
    creations: Summary[]; hasMore: boolean; nextOffset: number; followingCreators: number | null;
  };
  return { status: response.status, ...body };
}

/**
 * A page of the feed with adult content opted in.
 *
 * Adult content is opt-in, so a feed that did not ask for it would leave The
 * Final War out and every assertion below about ordering, search, paging and
 * card contents would quietly be describing a two-row corpus instead of a
 * three-row one. The opt-in itself is the subject of its own block, which
 * calls `rawFeed` so it can observe the default.
 */
function feed(search = "") {
  return rawFeed(search ? `${search}&adult=include` : "?adult=include");
}
const ids = (creations: Summary[]) => creations.map((creation) => creation.id);

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  memoryDb.public.registerFunction({
    name: "date_trunc", args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz,
    implementation: (unit: string, value: Date) => { const out = new Date(value); if (unit === "day") out.setHours(0, 0, 0, 0); return out; },
  });
  memoryDb.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: bob, email: null };

  await query("INSERT INTO profiles (id,username,display_name) VALUES ($1,'nova','Nova Vale')", [alice]);

  // One of each authoring structure, published, plus a draft and an unlisted one.
  await query(
    `INSERT INTO characters (id,user_id,name,title,creation_type,profile_type,tagline,description,visibility,published_at,
       tags,hashtags,content_mode,nsfw_enabled,message_count,chat_count,like_count,greeting,personality,response_directive,boundaries,source_material,cast_members)
     VALUES ($1,$2,'Seraphine','Seraphine','character','single','The girl who writes your name in the margins of her poetry.',
       'A poet who keeps her drafts hidden.','public',now(),$3::text[],$4::text[],'clean',false,2100,180,48,
       'You find her notebook.','Guarded, sharp.','Always answer in second person.','No violence.','pasted card dump','[]'::jsonb)`,
    [seraphine, alice, ["Poetic", "Drama", "Enemies to Lovers"], ["darkacademia", "poetry"]],
  );
  await query(
    `INSERT INTO characters (id,user_id,name,title,creation_type,profile_type,tagline,description,visibility,published_at,
       tags,hashtags,content_mode,nsfw_enabled,message_count,chat_count,like_count)
     VALUES ($1,$2,'The Final War','The Final War','scenario','ensemble','The heroes are running out of options.',
       'A siege that never ends.','public',now(),$3::text[],$4::text[],'adult_focused',true,3600,900,96)`,
    [finalWar, alice, ["Action", "Superhero", "AnyPOV"], ["mha", "villainau"]],
  );
  await query(
    `INSERT INTO characters (id,user_id,name,title,creation_type,profile_type,tagline,visibility,published_at,
       tags,hashtags,content_mode,nsfw_enabled,message_count,chat_count,like_count)
     VALUES ($1,$2,'Roommates From Hell','Roommates From Hell','cast','ensemble','Three roommates. One apartment. Absolutely no peace.',
       'public',now(),$3::text[],$4::text[],'clean',false,120,60,4)`,
    [roommates, alice, ["Comedy", "Slice of Life"], ["chaos"]],
  );
  await query(
    "INSERT INTO characters (id,user_id,name,title,visibility,tagline) VALUES ($1,$2,'Unfinished','Unfinished','private','A private draft')",
    [draft, alice],
  );
  await query(
    "INSERT INTO characters (id,user_id,name,title,visibility,tagline) VALUES ($1,$2,'Link Only','Link Only','unlisted','Shared by link')",
    [unlisted, alice],
  );
});

describe("visibility", () => {
  it("lists only public creations", async () => {
    const { creations } = await feed();
    expect(ids(creations).sort()).toEqual([seraphine, finalWar, roommates].sort());
  });

  it("never lists a private draft or an unlisted creation", async () => {
    const { creations } = await feed();
    expect(ids(creations)).not.toContain(draft);
    expect(ids(creations)).not.toContain(unlisted);
  });

  it("does not surface a creation the moment its creator unpublishes it", async () => {
    await query("UPDATE characters SET visibility='private' WHERE id=$1", [finalWar]);
    expect(ids((await feed()).creations)).not.toContain(finalWar);
  });

  it("shows the caller their own published creations rather than hiding them", async () => {
    // A creator who marks something public must be able to find it in the
    // feed. Excluding owned rows made publishing unverifiable from the one
    // surface that is supposed to confirm it.
    account = { id: alice, email: null };
    const { creations } = await feed();
    expect(ids(creations).sort()).toEqual([seraphine, finalWar, roommates].sort());
    expect(creations.every((creation) => creation.ownedByViewer)).toBe(true);
  });

  it("still keeps the owner's own private and unlisted creations out of the feed", async () => {
    account = { id: alice, email: null };
    const listed = ids((await feed()).creations);
    expect(listed).not.toContain(draft);
    expect(listed).not.toContain(unlisted);
  });

  it("requires an account", async () => {
    account = null;
    expect((await discovery.GET(new Request("http://test/api/discovery"))).status).toBe(401);
  });
});

describe("what a card receives", () => {
  it("carries the creation's own title, tagline, tags, hashtags and rating", async () => {
    const { creations } = await feed();
    const card = creations.find((creation) => creation.id === seraphine)!;
    expect(card.title).toBe("Seraphine");
    expect(card.tags).toEqual(["Poetic", "Drama", "Enemies to Lovers"]);
    expect(card.hashtags).toEqual(["darkacademia", "poetry"]);
    expect(card.nsfwEnabled).toBe(false);
    expect(creations.find((creation) => creation.id === finalWar)!.nsfwEnabled).toBe(true);
  });

  it("never sends the hidden definition to the browser", async () => {
    const payload = JSON.stringify((await feed()).creations);
    for (const secret of ["You find her notebook.", "Guarded, sharp.", "Always answer in second person.", "No violence.", "pasted card dump"]) {
      expect(payload).not.toContain(secret);
    }
    // Not merely blanked: those fields are not part of the summary at all.
    const card = (await feed()).creations[0] as unknown as Record<string, unknown>;
    for (const field of ["greeting", "personality", "responseDirective", "boundaries", "sourceMaterial", "cast", "backstory", "description"]) {
      expect(card).not.toHaveProperty(field);
    }
  });

  it("reports global totals rather than the viewer's own activity", async () => {
    const card = (await feed()).creations.find((creation) => creation.id === finalWar)!;
    expect(card.messageCount).toBe(3600);
    expect(card.chatCount).toBe(900);
    expect(card.saveCount).toBe(96);
  });

  it("resolves the authoring structure for every creation, including a scenario", async () => {
    const byId = new Map((await feed()).creations.map((creation) => [creation.id, creation]));
    expect(byId.get(seraphine)!.creationType).toBe("character");
    expect(byId.get(finalWar)!.creationType).toBe("scenario");
    expect(byId.get(roommates)!.creationType).toBe("cast");
  });

  it("infers the structure of a creation written before creations existed", async () => {
    await query("UPDATE characters SET creation_type='', profile_type='ensemble' WHERE id=$1", [roommates]);
    const card = (await feed()).creations.find((creation) => creation.id === roommates)!;
    expect(card.creationType).toBe("cast");
  });

  it("attributes a creation to its creator only where they published a username", async () => {
    expect((await feed()).creations[0].creator?.username).toBe("nova");
    await query("UPDATE profiles SET username=NULL WHERE id=$1", [alice]);
    expect((await feed()).creations[0].creator).toBeNull();
  });
});

describe("ordering", () => {
  it("ranks Popular by saves, not by likes of any other kind", async () => {
    expect(ids((await feed("?sort=popular")).creations)).toEqual([finalWar, seraphine, roommates]);
  });

  it("ranks Most chatted by stories started", async () => {
    expect(ids((await feed("?sort=chatted")).creations)).toEqual([finalWar, seraphine, roommates]);
  });

  it("ranks New by publication time", async () => {
    await query("UPDATE characters SET published_at=now() - interval '3 days' WHERE id=$1", [finalWar]);
    await query("UPDATE characters SET published_at=now() - interval '1 days' WHERE id=$1", [roommates]);
    expect(ids((await feed("?sort=new")).creations)).toEqual([seraphine, roommates, finalWar]);
  });

  it("falls back to the default ordering rather than trusting an unknown sort", async () => {
    expect(ids((await feed("?sort=for-you")).creations)).toEqual(ids((await feed("?sort=popular")).creations));
  });
});

describe("search", () => {
  it("finds a creation by its title", async () => {
    expect(ids((await feed("?q=final")).creations)).toEqual([finalWar]);
  });

  it("finds a creation by its tagline", async () => {
    expect(ids((await feed("?q=absolutely+no+peace")).creations)).toEqual([roommates]);
  });

  it("finds a creation by a platform tag", async () => {
    expect(ids((await feed("?q=superhero")).creations)).toEqual([finalWar]);
  });

  it("finds a creation by its creator", async () => {
    expect(ids((await feed("?q=nova")).creations).sort()).toEqual([seraphine, finalWar, roommates].sort());
  });

  it("looks a hashtag up as a hashtag rather than as letters in a title", async () => {
    expect(ids((await feed("?q=%23mha")).creations)).toEqual([finalWar]);
    // A hashtag search matches hashtags exactly, so a near miss finds nothing.
    expect((await feed("?q=%23mh")).creations).toHaveLength(0);
  });

  it("does not let a search term act as a pattern", async () => {
    expect((await feed("?q=%25")).creations).toHaveLength(0);
  });

  it("says nothing matched rather than falling back to everything", async () => {
    const { creations, hasMore } = await feed("?q=nothingmatchesthis");
    expect(creations).toHaveLength(0);
    expect(hasMore).toBe(false);
  });
});

describe("filtering", () => {
  it("filters by authoring structure", async () => {
    expect(ids((await feed("?type=scenario")).creations)).toEqual([finalWar]);
    expect(ids((await feed("?type=cast,character")).creations).sort()).toEqual([seraphine, roommates].sort());
  });

  it("narrows rather than widens when several platform tags are chosen", async () => {
    expect(ids((await feed("?tags=Action")).creations)).toEqual([finalWar]);
    expect(ids((await feed("?tags=Action,Superhero")).creations)).toEqual([finalWar]);
    // Two tags means both, so a creation carrying only one of them drops out.
    expect((await feed("?tags=Action,Comedy")).creations).toHaveLength(0);
  });

  it("keeps the tag taxonomy and creator hashtags as separate filters", async () => {
    // "mha" is a hashtag on The Final War and not a platform tag on anything.
    expect((await feed("?tags=mha")).creations).toHaveLength(0);
    expect(ids((await feed("?q=%23mha")).creations)).toEqual([finalWar]);
  });

});

/**
 * Adult content is opt-in.
 *
 * The default — a fresh session, a shared link, a URL nobody edited — leaves
 * adult creations out, and asking for them widens the feed rather than
 * narrowing it to only adult work.
 */
describe("18+ inclusion", () => {
  it("excludes adult creations by default", async () => {
    const { creations } = await rawFeed();
    expect(ids(creations)).not.toContain(finalWar);
    expect(ids(creations).sort()).toEqual([seraphine, roommates].sort());
  });

  it("keeps an adult-capable creation in the ordinary feed", async () => {
    /*
     * The behaviour change this release exists for.
     *
     * The feed's 18+ filter is about how a creation PRESENTS itself, not about
     * what its writer could be asked to do. A story that stays clean unless
     * its reader steers otherwise belongs in front of readers who have not
     * opted into anything — it simply writes cleanly for them, which is
     * `explicitRoleplayAllowed`'s job rather than the feed's. Excluding it, as
     * `nsfw_enabled=false` did, hid most of a catalogue from most of its
     * audience.
     */
    await query("UPDATE characters SET content_mode='adult_capable' WHERE id=$1", [finalWar]);
    const { creations } = await rawFeed();
    expect(ids(creations)).toContain(finalWar);
    // And it is still capable: the mode says so even while the feed shows it.
    expect(creations.find((creation) => creation.id === finalWar)?.contentMode).toBe("adult_capable");
    await query("UPDATE characters SET content_mode='adult_focused' WHERE id=$1", [finalWar]);
  });

  it("excludes adult creations for every filter, ordering and search that did not opt in", async () => {
    expect(ids((await rawFeed("?sort=popular")).creations)).not.toContain(finalWar);
    expect(ids((await rawFeed("?sort=new")).creations)).not.toContain(finalWar);
    expect((await rawFeed("?q=final")).creations).toHaveLength(0);
    expect((await rawFeed("?tags=Superhero")).creations).toHaveLength(0);
    expect((await rawFeed("?q=%23mha")).creations).toHaveLength(0);
    expect((await rawFeed("?type=scenario")).creations).toHaveLength(0);
  });

  it("lets adult creations appear alongside everything else once included", async () => {
    const { creations } = await rawFeed("?adult=include");
    expect(ids(creations)).toContain(finalWar);
    // Included, not exclusive: opting in must not turn the feed adult-only.
    expect(ids(creations).sort()).toEqual([seraphine, finalWar, roommates].sort());
  });

  it("treats anything other than the opt-in keyword as not opting in", async () => {
    // Links written while the filter was an opt-out carried "adult=hide"; they
    // excluded adult content then and they still exclude it now.
    for (const value of ["hide", "", "1", "true", "exclude", "yes"]) {
      expect(ids((await rawFeed(`?adult=${value}`)).creations)).not.toContain(finalWar);
    }
  });

  it("does not persist the opt-in anywhere on the account", async () => {
    await rawFeed("?adult=include");
    // The next request without the opt-in is adult-free again, so browsing
    // never quietly rewrites an account-level preference.
    expect(ids((await rawFeed()).creations)).not.toContain(finalWar);
  });
});

describe("paging", () => {
  it("returns a page at a time and reports whether more exist", async () => {
    const first = await feed("?sort=popular&limit=2");
    expect(ids(first.creations)).toEqual([finalWar, seraphine]);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(2);

    const second = await feed(`?sort=popular&limit=2&offset=${first.nextOffset}`);
    expect(ids(second.creations)).toEqual([roommates]);
    expect(second.hasMore).toBe(false);
  });

  it("clamps a page size a caller tried to exaggerate", async () => {
    expect((await feed("?limit=100000")).creations.length).toBeLessThanOrEqual(48);
  });

  it("answers a page in one statement, so a card never costs a query", async () => {
    const statements: string[] = [];
    const client = pool();
    const original = client.query.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).query = (text: any, ...rest: any[]) => {
      if (typeof text === "string" && /FROM characters/i.test(text)) statements.push(text);
      return original(text, ...rest);
    };
    try {
      await feed("?sort=popular");
      expect(statements).toHaveLength(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = original;
    }
  });
});

/**
 * Public discovery eligibility.
 *
 * The feed's membership rule is deliberately narrow: published, public, and
 * permitted by the viewer's adult setting and their active filters. Nothing
 * optional may act as a hidden requirement, because every one of these is a
 * legitimate shape for a finished creation — a scenario with no characters, a
 * creation nobody has saved yet, one with no hashtags, one with no world. A
 * feed that silently required any of them would return an empty page and
 * blame the creator for it.
 */
describe("public eligibility", () => {
  const barren = "aaaaaaaa-0000-4000-8000-000000000009";

  /** Public, and carrying no optional related data whatsoever. */
  async function publishBarren(creationType: string, profileType = "single") {
    await query(
      `INSERT INTO characters (id,user_id,name,title,creation_type,profile_type,visibility,published_at,
         tags,hashtags,cast_members,nsfw_enabled,message_count,chat_count,like_count)
       VALUES ($1,$2,'Nothing Attached','Nothing Attached',$3,$4,'public',now(),
         '{}'::text[],'{}'::text[],'[]'::jsonb,false,0,0,0)`,
      [barren, alice, creationType, profileType],
    );
  }

  it("lists a public character", async () => {
    expect(ids((await feed()).creations)).toContain(seraphine);
  });

  it("lists a public cast", async () => {
    expect(ids((await feed()).creations)).toContain(roommates);
  });

  it("lists a public scenario that defines no primary character at all", async () => {
    await publishBarren("scenario", "ensemble");
    const card = (await feed()).creations.find((creation) => creation.id === barren);
    expect(card).toBeDefined();
    expect(card!.creationType).toBe("scenario");
  });

  it("lists a public creation with zero saves", async () => {
    await publishBarren("character");
    const card = (await feed()).creations.find((creation) => creation.id === barren)!;
    expect(card.saveCount).toBe(0);
  });

  it("lists a public creation with zero hashtags", async () => {
    await publishBarren("character");
    const card = (await feed()).creations.find((creation) => creation.id === barren)!;
    expect(card.hashtags).toEqual([]);
  });

  it("lists a public creation with no tags", async () => {
    await publishBarren("character");
    expect((await feed()).creations.find((creation) => creation.id === barren)!.tags).toEqual([]);
  });

  it("lists a public creation with no world attached", async () => {
    await publishBarren("character");
    // No character_worlds row is ever written for it, and it appears anyway:
    // world attachment is optional data, never a membership condition.
    const links = await query("SELECT COUNT(*)::int count FROM character_worlds WHERE character_id=$1", [barren]);
    expect(Number(links.rows[0].count)).toBe(0);
    expect(ids((await feed()).creations)).toContain(barren);
  });

  it("lists a public creation whose creator has no published username", async () => {
    await query("UPDATE profiles SET username=NULL WHERE id=$1", [alice]);
    expect(ids((await feed()).creations).sort()).toEqual([seraphine, finalWar, roommates].sort());
  });

  it("lists the current user's own public creation", async () => {
    account = { id: alice, email: null };
    expect(ids((await feed()).creations)).toContain(seraphine);
  });

  it("does not list a private creation", async () => {
    expect(ids((await feed()).creations)).not.toContain(draft);
  });

  it("does not list an unlisted creation, which is reachable only by link", async () => {
    expect(ids((await feed()).creations)).not.toContain(unlisted);
  });

  it("hides an adult creation with 18+ off and lists it with 18+ on", async () => {
    expect(ids((await rawFeed()).creations)).not.toContain(finalWar);
    expect(ids((await rawFeed("?adult=include")).creations)).toContain(finalWar);
  });

  it("keeps listing a public creation after it is edited and saved again", async () => {
    await query("UPDATE characters SET tagline='Edited tagline', updated_at=now() WHERE id=$1", [seraphine]);
    expect(ids((await feed()).creations)).toContain(seraphine);
  });

  it("keeps listing a public creation that was unpublished and published again", async () => {
    await query("UPDATE characters SET visibility='private', published_at=NULL WHERE id=$1", [seraphine]);
    expect(ids((await feed()).creations)).not.toContain(seraphine);
    await query("UPDATE characters SET visibility='public', published_at=now() WHERE id=$1", [seraphine]);
    expect(ids((await feed()).creations)).toContain(seraphine);
  });

  it("does not lose a public creation whose published_at was never stamped", async () => {
    // An ordering that reads published_at must not become a filter on it.
    await query("UPDATE characters SET published_at=NULL WHERE id=$1", [roommates]);
    expect(ids((await feed()).creations)).toContain(roommates);
    expect(ids((await feed("?sort=new")).creations)).toContain(roommates);
  });

  it("never returns zero rows because of an optional stats or tag join", async () => {
    await query("DELETE FROM character_likes");
    await query("UPDATE characters SET like_count=0, chat_count=0, message_count=0, tags='{}'::text[], hashtags='{}'::text[]");
    for (const sort of ["popular", "chatted", "new"]) {
      expect((await feed(`?sort=${sort}`)).creations).toHaveLength(3);
    }
  });
});

describe("saving from the feed", () => {
  /*
   * The aggregate itself is maintained by the SECURITY DEFINER trigger in
   * supabase/migrations/0004, which the in-memory engine these tests run
   * against does not implement. What is asserted here is everything the
   * application owns: the one relation is written, the viewer's state follows
   * it, and the reported total is read back from the maintained column rather
   * than counted or invented in the route.
   */
  it("writes through the one canonical save relation", async () => {
    const created = await saves.POST(new Request("http://test/api/saves", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: seraphine }),
    }));
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ saved: true });

    const rows = await query("SELECT COUNT(*)::int count FROM character_likes WHERE user_id=$1 AND character_id=$2", [bob, seraphine]);
    expect(Number(rows.rows[0].count)).toBe(1);

    const card = (await feed()).creations.find((creation) => creation.id === seraphine)!;
    expect(card.savedByViewer).toBe(true);
  });

  it("reports the stored aggregate rather than a number of its own", async () => {
    await query("UPDATE characters SET like_count=1234 WHERE id=$1", [seraphine]);
    const response = await saves.POST(new Request("http://test/api/saves", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: seraphine }),
    }));
    expect(await response.json()).toMatchObject({ saveCount: 1234 });
    expect((await feed()).creations.find((creation) => creation.id === seraphine)!.saveCount).toBe(1234);
  });

  it("unsaves through the same relation", async () => {
    await saves.POST(new Request("http://test/api/saves", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: seraphine }),
    }));
    const removed = await saves.DELETE(new Request(`http://test/api/saves?characterId=${seraphine}`, { method: "DELETE" }));
    expect(await removed.json()).toMatchObject({ saved: false });
    const rows = await query("SELECT COUNT(*)::int count FROM character_likes WHERE user_id=$1 AND character_id=$2", [bob, seraphine]);
    expect(Number(rows.rows[0].count)).toBe(0);
    expect((await feed()).creations.find((creation) => creation.id === seraphine)!.savedByViewer).toBe(false);
  });

  it("refuses to save a creation that is private to somebody else", async () => {
    const response = await saves.POST(new Request("http://test/api/saves", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: draft }),
    }));
    expect(response.status).toBe(404);
  });

  it("reports one account's save state without exposing anybody else's", async () => {
    await saves.POST(new Request("http://test/api/saves", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: seraphine }),
    }));
    // A different reader sees the same public total and their own state — never
    // that somebody else saved it.
    account = { id: "33333333-3333-4333-8333-333333333333", email: null };
    const card = (await feed()).creations.find((creation) => creation.id === seraphine)!;
    expect(card.saveCount).toBe(48);
    expect(card.savedByViewer).toBe(false);
    expect(JSON.stringify(card)).not.toContain(bob);
  });

  it("lists the saved library from the same relation", async () => {
    await saves.POST(new Request("http://test/api/saves", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: finalWar }),
    }));
    const library = await (await saves.GET()).json() as { creations: Summary[] };
    expect(ids(library.creations)).toEqual([finalWar]);
    expect(library.creations[0].savedByViewer).toBe(true);
    // The library is made of the same lean summaries, not full definitions.
    expect(library.creations[0]).not.toHaveProperty("greeting");
  });
});

/**
 * The Following feed.
 *
 * Following is worth nothing unless it changes what somebody sees, so this is
 * the surface that gives it meaning. Three properties matter and each of them
 * is a way the feature is usually got wrong:
 *
 *   IT IS EXACTLY WHO YOU FOLLOW. Not "creators like the ones you follow", and
 *   not your follows blended with recommendations.
 *
 *   IT IS STRICTLY CHRONOLOGICAL. A reader asked for these creators; deciding
 *   which of their releases they really meant is not the platform's to do.
 *
 *   IT IS FILTERED IN SQL. The alternative — read follows into the browser,
 *   fetch creations, narrow them there — downloads work in order to discard it
 *   and pages incorrectly the moment it does.
 */
describe("the following feed", () => {
  const carol = "33333333-3333-4333-8333-333333333333";
  const carolCreation = "aaaaaaaa-0000-4000-8000-000000000011";
  const carolDraft = "aaaaaaaa-0000-4000-8000-000000000012";

  beforeEach(async () => {
    await query("INSERT INTO profiles (id,username,display_name) VALUES ($1,'carol','Carol')", [carol]);
    // Published later than everything Alice has, so recency is observable.
    await query(
      `INSERT INTO characters (id,user_id,name,title,creation_type,visibility,published_at,tags,hashtags)
       VALUES ($1,$2,'Elysia','Elysia','character','public',now() + interval '1 hour',$3::text[],$4::text[])`,
      [carolCreation, carol, ["Drama"], []],
    );
    await query(
      "INSERT INTO characters (id,user_id,name,title,visibility) VALUES ($1,$2,'Carol Draft','Carol Draft','private')",
      [carolDraft, carol],
    );
  });

  const following = () => rawFeed("?sort=following&adult=include");

  it("is empty, and says which kind of empty, before anybody is followed", async () => {
    const page = await following();
    expect(page.creations).toEqual([]);
    expect(page.followingCreators).toBe(0);
  });

  it("shows only the creators the reader actually follows", async () => {
    await query("INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2)", [bob, carol]);
    const page = await following();
    expect(ids(page.creations)).toEqual([carolCreation]);
    expect(page.followingCreators).toBe(1);
    // Alice publishes plenty, and Bob does not follow her.
    expect(ids(page.creations)).not.toContain(seraphine);
  });

  it("orders strictly by publication recency, newest first", async () => {
    await query("INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2),($1,$3)", [bob, carol, alice]);
    // Alice's most-saved creation is deliberately NOT the newest, so a feed
    // that reranked by popularity would put it first.
    await query("UPDATE characters SET published_at=now() - interval '2 hours' WHERE id=$1", [finalWar]);
    await query("UPDATE characters SET published_at=now() - interval '1 hour' WHERE id=$1", [seraphine]);
    await query("UPDATE characters SET published_at=now() - interval '3 hours' WHERE id=$1", [roommates]);
    const page = await following();
    expect(ids(page.creations)).toEqual([carolCreation, seraphine, finalWar, roommates]);
  });

  it("never includes a draft or an unlisted creation by a followed creator", async () => {
    await query("INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2),($1,$3)", [bob, carol, alice]);
    const listed = ids((await following()).creations);
    expect(listed).not.toContain(carolDraft);
    expect(listed).not.toContain(draft);
    expect(listed).not.toContain(unlisted);
  });

  it("shows a newly published creation at the top", async () => {
    await query("INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2)", [bob, alice]);
    const fresh = "aaaaaaaa-0000-4000-8000-000000000013";
    await query(
      "INSERT INTO characters (id,user_id,name,title,visibility,published_at) VALUES ($1,$2,'Newest','Newest','public',now() + interval '2 hours')",
      [fresh, alice],
    );
    expect(ids((await following()).creations)[0]).toBe(fresh);
  });

  it("stops showing a creator's work the moment they are unfollowed", async () => {
    await query("INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2)", [bob, carol]);
    expect(ids((await following()).creations)).toEqual([carolCreation]);
    await query("DELETE FROM profile_follows WHERE follower_user_id=$1 AND creator_user_id=$2", [bob, carol]);
    const page = await following();
    expect(page.creations).toEqual([]);
    expect(page.followingCreators).toBe(0);
  });

  it("pages in a stable order", async () => {
    await query("INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2),($1,$3)", [bob, carol, alice]);
    const first = await rawFeed("?sort=following&adult=include&limit=2");
    expect(first.creations).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await rawFeed(`?sort=following&adult=include&limit=2&offset=${first.nextOffset}`);
    // No creation appears on both pages.
    expect(ids(second.creations).filter((id) => ids(first.creations).includes(id))).toEqual([]);
  });

  it("does not count follows on the feeds that are not scoped to them", async () => {
    await query("INSERT INTO profile_follows (follower_user_id,creator_user_id) VALUES ($1,$2)", [bob, carol]);
    expect((await feed()).followingCreators).toBe(null);
  });
});
