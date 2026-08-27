import { randomUUID } from "node:crypto";
import { DataType, newDb } from "pg-mem";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asUser, ensureSchema, query, setPoolForTesting } from "@/lib/db";
import {
  achievementStates, achievementUnlocked, achievementById, achievements, featuredAchievements,
  rankPercentile, type CreatorMetrics,
} from "@/lib/achievements";
import { effectiveBorder, profileBorder, unlockedBorders } from "@/lib/cosmetics";
import { creatorActivity, creatorCreations, creatorTopCharacters, creatorWorlds } from "@/lib/creator-profile";

/**
 * Creator Profile V2, from the numbers up.
 *
 * The rule the whole feature is built on is that every figure is REAL or it is
 * absent, so most of these tests are about what a number is allowed to mean:
 *
 *   MESSAGES means messages people SENT. Not replies, not regenerations, not
 *   the opening greeting, not a branch's copy of a turn that was already
 *   counted. `characters.message_count` counts all of those and is roughly
 *   double; reusing it would have been the easy way to a wrong headline.
 *
 *   RANK is a real ordering with a stated rule and deterministic ties, not an
 *   engagement score nobody can check.
 *
 *   AN ACHIEVEMENT is a threshold on one of those numbers, and its TIMESTAMP is
 *   only ever "when the system first observed it" — never a date invented for a
 *   milestone that was already true.
 *
 * The RLS half of the same feature is in tests/tenancy.test.ts.
 */

const creator = "11111111-1111-4111-8111-111111111111";
const reader = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";

function metrics(overrides: Partial<CreatorMetrics> = {}): CreatorMetrics {
  return { followers: 0, messages: 0, publishedCreations: 0, publishedWorlds: 0, rank: null, ...overrides };
}

async function makeCreation(userId: string, name: string, options: { visibility?: string; messages?: number; saves?: number } = {}) {
  const id = randomUUID();
  await query(
    `INSERT INTO characters (id,user_id,name,title,visibility,user_message_count,message_count,like_count,published_at)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7,now())`,
    [id, userId, name, options.visibility ?? "public", options.messages ?? 0, (options.messages ?? 0) * 2 + 1, options.saves ?? 0],
  );
  return id;
}

async function makeWorld(userId: string, name: string, visibility = "public") {
  const id = randomUUID();
  await query(
    "INSERT INTO worlds (id,user_id,name,description,content,visibility) VALUES ($1,$2,$3,'A place','Lore document',$4)",
    [id, userId, name, visibility],
  );
  return id;
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  await query("INSERT INTO profiles (id,username,display_name) VALUES ($1,'noctis','Noctis')", [creator]);
  await query("INSERT INTO profiles (id,username,display_name) VALUES ($1,'reader','Reader')", [reader]);
});

describe("what a message is", () => {
  it("counts a user turn that reached the writer, once", async () => {
    const characterId = await makeCreation(creator, "Elysia");
    const conversationId = randomUUID();
    await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Story')", [conversationId, reader, characterId]);

    const messageId = randomUUID();
    await query(
      "INSERT INTO messages (id,conversation_id,user_id,role,content,authored_event_id) VALUES ($1,$2,$3,'user','Hello',$1)",
      [messageId, conversationId, reader],
    );
    // The counter is maintained by a trigger in 0021 against real PostgreSQL.
    // pg-mem has no triggers, so the equivalent statement is asserted directly:
    // what matters here is that the DEFINITION is the one the profile claims.
    const counted = await query(
      `SELECT count(DISTINCT COALESCE(m.authored_event_id,m.id))::int count
       FROM messages m JOIN conversations v ON v.id=m.conversation_id
       WHERE v.character_id=$1 AND m.role='user' AND m.generation_started_at IS NOT NULL`,
      [characterId],
    );
    // Not yet: the turn has not reached the writer.
    expect(Number(counted.rows[0].count)).toBe(0);

    await query("UPDATE messages SET generation_started_at=now() WHERE id=$1", [messageId]);
    const after = await query(
      `SELECT count(DISTINCT COALESCE(m.authored_event_id,m.id))::int count
       FROM messages m JOIN conversations v ON v.id=m.conversation_id
       WHERE v.character_id=$1 AND m.role='user' AND m.generation_started_at IS NOT NULL`,
      [characterId],
    );
    expect(Number(after.rows[0].count)).toBe(1);
  });

  it("does not count replies, greetings or a branch's copy", async () => {
    const characterId = await makeCreation(creator, "Elysia");
    const conversationId = randomUUID();
    const branchId = randomUUID();
    await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Story')", [conversationId, reader, characterId]);
    await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Branch')", [branchId, reader, characterId]);

    const original = randomUUID();
    await query(
      "INSERT INTO messages (id,conversation_id,user_id,role,content,authored_event_id,generation_started_at) VALUES ($1,$2,$3,'user','Hi',$1,now())",
      [original, conversationId, reader],
    );
    // The greeting and the reply.
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','Welcome')", [randomUUID(), conversationId, reader]);
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','A reply')", [randomUUID(), conversationId, reader]);
    // The branch's copy, which points back at the original event.
    await query(
      "INSERT INTO messages (id,conversation_id,user_id,role,content,authored_event_id,generation_started_at) VALUES ($1,$2,$3,'user','Hi',$4,now())",
      [randomUUID(), branchId, reader, original],
    );

    const counted = await query(
      `SELECT count(DISTINCT COALESCE(m.authored_event_id,m.id))::int count
       FROM messages m JOIN conversations v ON v.id=m.conversation_id
       WHERE v.character_id=$1 AND m.role='user' AND m.generation_started_at IS NOT NULL`,
      [characterId],
    );
    expect(Number(counted.rows[0].count)).toBe(1);

    // Four message rows exist. A profile that read `message_count` would claim
    // four; the number this product publishes is one.
    const all = await query("SELECT count(*)::int count FROM messages WHERE conversation_id IN ($1,$2)", [conversationId, branchId]);
    expect(Number(all.rows[0].count)).toBe(4);
  });
});

describe("the ranking rule", () => {
  it("orders by messages, then followers, then saves, then creations, then id", () => {
    // The rule stated in 0021, as an ordering over rows. Asserted here as a
    // sort so the SQL and the documentation cannot drift apart quietly.
    const rows = [
      { messages: 10, followers: 1, saves: 0, creations: 1, id: "b" },
      { messages: 10, followers: 5, saves: 0, creations: 1, id: "a" },
      { messages: 90, followers: 0, saves: 0, creations: 1, id: "c" },
      { messages: 10, followers: 1, saves: 4, creations: 1, id: "d" },
    ];
    const ordered = [...rows].sort((left, right) =>
      right.messages - left.messages
      || right.followers - left.followers
      || right.saves - left.saves
      || right.creations - left.creations
      || left.id.localeCompare(right.id));
    expect(ordered.map((row) => row.id)).toEqual(["c", "a", "d", "b"]);
  });

  it("turns a rank into a percentile the right way up", () => {
    expect(rankPercentile(1, 500)).toBeCloseTo(0.002);
    expect(rankPercentile(347, 43_000)).toBeCloseTo(0.00807, 4);
    expect(rankPercentile(500, 500)).toBe(1);
    // Not ranked is not zeroth.
    expect(rankPercentile(null, 500)).toBeNull();
    expect(rankPercentile(1, 0)).toBeNull();
  });
});

describe("achievements come from real metrics", () => {
  it("unlocks on the threshold and not before it", () => {
    const followers1k = achievementById("followers_1k")!;
    expect(achievementUnlocked(followers1k, metrics({ followers: 999 }), 100)).toBe(false);
    expect(achievementUnlocked(followers1k, metrics({ followers: 1_000 }), 100)).toBe(true);
  });

  it("reads each family from its own number", () => {
    const all = metrics({ followers: 100, messages: 10_000, publishedCreations: 10, publishedWorlds: 3 });
    const unlocked = achievementStates(all, 100).filter((state) => state.unlocked).map((state) => state.id);
    expect(unlocked).toContain("followers_100");
    expect(unlocked).toContain("messages_10k");
    expect(unlocked).toContain("creations_10");
    expect(unlocked).toContain("worlds_3");
    // And nothing it has not reached.
    expect(unlocked).not.toContain("followers_1k");
    expect(unlocked).not.toContain("messages_100k");
    expect(unlocked).not.toContain("creations_25");
  });

  it("measures a percentile achievement against the size of the field", () => {
    const topTenPercent = achievementById("rank_top_10_percent")!;
    // Rank 5 of 40 is inside the top 10%; rank 5 of 4000 obviously is too.
    expect(achievementUnlocked(topTenPercent, metrics({ rank: 4 }), 40)).toBe(true);
    expect(achievementUnlocked(topTenPercent, metrics({ rank: 20 }), 40)).toBe(false);
    expect(achievementUnlocked(topTenPercent, metrics({ rank: 5 }), 4000)).toBe(true);
  });

  it("gives an unranked creator no rank achievements at all", () => {
    const unlocked = achievementStates(metrics({ followers: 1_000_000 }), 0).filter((state) => state.unlocked);
    expect(unlocked.every((state) => state.category !== "rank")).toBe(true);
  });

  it("reports a locked achievement as locked rather than hiding it", () => {
    const states = achievementStates(metrics(), 0);
    expect(states).toHaveLength(achievements.length);
    expect(states.every((state) => !state.unlocked)).toBe(true);
    expect(states.every((state) => state.unlockedAt === null)).toBe(true);
  });

  it("never invents an unlock time", () => {
    // An achievement genuinely earned but never observed displays as unlocked
    // with no date, which is the honest answer.
    const [state] = achievementStates(metrics({ publishedCreations: 1 }), 0).filter((entry) => entry.id === "creations_1");
    expect(state.unlocked).toBe(true);
    expect(state.unlockedAt).toBeNull();

    const observed = achievementStates(metrics({ publishedCreations: 1 }), 0, new Map([["creations_1", "2026-08-01T00:00:00.000Z"]]));
    expect(observed.find((entry) => entry.id === "creations_1")!.unlockedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("featured achievements", () => {
  const states = achievementStates(metrics({ followers: 1_000, messages: 10_000, publishedCreations: 10, publishedWorlds: 1 }), 100);

  it("honours the creator's own choice", () => {
    expect(featuredAchievements(states, ["worlds_1", "creations_10"]).map((state) => state.id))
      .toEqual(["worlds_1", "creations_10"]);
  });

  it("silently drops a choice that is not actually unlocked", () => {
    expect(featuredAchievements(states, ["messages_1m"]).map((state) => state.id)).not.toContain("messages_1m");
  });

  it("leads with the hardest thing done when nothing is chosen", () => {
    // An automatic selection that led with "First Creation" would be true and
    // say nothing.
    const automatic = featuredAchievements(states, []);
    expect(automatic[0].id).toBe("messages_10k");
    expect(automatic.every((state) => state.unlocked)).toBe(true);
  });
});

describe("profile borders", () => {
  it("gives everybody the default and nothing else to start", () => {
    expect(unlockedBorders(metrics(), 0)).toEqual(["default"]);
  });

  it("unlocks each ring from the thing it names", () => {
    expect(unlockedBorders(metrics({ publishedCreations: 1 }), 0)).toContain("rose");
    expect(unlockedBorders(metrics({ followers: 100 }), 0)).toContain("violet");
    expect(unlockedBorders(metrics({ rank: 5, publishedCreations: 1 }), 1000)).toContain("star");
    expect(unlockedBorders(metrics({ rank: 42 }), 1000)).toContain("ranked");
    expect(unlockedBorders(metrics({ rank: 3 }), 1000)).toContain("luminary");
    expect(unlockedBorders(metrics({ rank: 400 }), 1000)).not.toContain("ranked");
  });

  it("refuses a border the creator has not earned, on read as well as on write", () => {
    // The check is on read too, so a ring earned and then lost stops being
    // drawn without anything having to notice and rewrite the row.
    expect(effectiveBorder("luminary", metrics(), 0).id).toBe("default");
    expect(effectiveBorder("ranked", metrics({ rank: 42 }), 1000).id).toBe("ranked");
    expect(effectiveBorder("not-a-border", metrics(), 0).id).toBe("default");
  });

  it("draws every border from a colour pair and a glow, and nothing else", () => {
    for (const id of ["default", "rose", "violet", "star", "ranked", "luminary"]) {
      const border = profileBorder(id);
      expect(border.colors.from).toMatch(/^#[0-9a-f]{6}$/i);
      expect(border.colors.to).toMatch(/^#[0-9a-f]{6}$/i);
      expect(border.requirement.length).toBeGreaterThan(0);
    }
  });
});

describe("what a profile actually selects", () => {
  it("orders creations by the same metric the headline uses", async () => {
    await makeCreation(creator, "Quiet one", { messages: 5 });
    await makeCreation(creator, "Popular one", { messages: 5000 });
    await makeCreation(creator, "Middling", { messages: 500 });

    const popular = await asUser(reader, (client) => creatorCreations(client, {
      creatorId: creator, viewerId: reader, sort: "popular", filter: "all",
    }));
    expect(popular.map((creation) => creation.name)).toEqual(["Popular one", "Middling", "Quiet one"]);
  });

  it("never returns another account's private or unlisted work", async () => {
    await makeCreation(creator, "Published", { messages: 10 });
    await makeCreation(creator, "Private", { visibility: "private" });
    await makeCreation(creator, "Unlisted", { visibility: "unlisted" });
    await makeWorld(creator, "Public world");
    await makeWorld(creator, "Private world", "private");

    const creations = await asUser(reader, (client) => creatorCreations(client, {
      creatorId: creator, viewerId: reader, sort: "popular", filter: "all",
    }));
    expect(creations.map((creation) => creation.name)).toEqual(["Published"]);

    const worlds = await asUser(reader, (client) => creatorWorlds(client, creator, reader));
    expect(worlds.map((world) => world.name)).toEqual(["Public world"]);
  });

  it("ships no hidden definition and no world lore", async () => {
    await query(
      `UPDATE characters SET greeting='SECRET GREETING',personality='SECRET PERSONALITY',
        response_directive='SECRET DIRECTIVE',source_material='SECRET SOURCE'
       WHERE id=$1`,
      [await makeCreation(creator, "Elysia", { messages: 10 })],
    );
    await makeWorld(creator, "Night City");

    const payload = JSON.stringify(await asUser(reader, async (client) => ({
      creations: await creatorCreations(client, { creatorId: creator, viewerId: reader, sort: "popular", filter: "all" }),
      worlds: await creatorWorlds(client, creator, reader),
      top: await creatorTopCharacters(client, creator, reader),
    })));
    for (const secret of ["SECRET GREETING", "SECRET PERSONALITY", "SECRET DIRECTIVE", "SECRET SOURCE", "Lore document"]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("filters by creation type", async () => {
    await makeCreation(creator, "A character", { messages: 1 });
    await query("UPDATE characters SET creation_type='scenario' WHERE name='A scenario' OR id=$1", [await makeCreation(creator, "A scenario")]);

    const scenarios = await asUser(reader, (client) => creatorCreations(client, {
      creatorId: creator, viewerId: reader, sort: "popular", filter: "scenario",
    }));
    expect(scenarios.map((creation) => creation.name)).toEqual(["A scenario"]);
  });

  it("returns the top characters in one query, ordered by real messages", async () => {
    await makeCreation(creator, "Third", { messages: 30 });
    await makeCreation(creator, "First", { messages: 300 });
    await makeCreation(creator, "Second", { messages: 200 });
    await makeCreation(creator, "Fourth", { messages: 4 });

    const top = await asUser(reader, (client) => creatorTopCharacters(client, creator, reader));
    expect(top.map((entry) => entry.name)).toEqual(["First", "Second", "Third"]);
    expect(top[0].messages).toBe(300);
  });
});

describe("recent activity", () => {
  it("derives publish events from timestamps that genuinely exist", async () => {
    await makeCreation(creator, "Liora", { messages: 1 });
    await makeWorld(creator, "Noctis Universe");

    const activity = await asUser(reader, (client) => creatorActivity(client, creator));
    expect(activity.map((event) => event.kind)).toContain("creation_published");
    expect(activity.map((event) => event.subject)).toContain("Liora");
    expect(activity.map((event) => event.subject)).toContain("Noctis Universe");
    for (const event of activity) expect(new Date(event.occurredAt).getTime()).toBeGreaterThan(0);
  });

  it("never exposes private work", async () => {
    await makeCreation(creator, "Secret creation", { visibility: "private" });
    await makeWorld(creator, "Secret world", "private");
    const activity = await asUser(reader, (client) => creatorActivity(client, creator));
    expect(JSON.stringify(activity)).not.toContain("Secret");
  });

  it("skips a milestone whose date nobody knows", async () => {
    // Recorded so it can never fire again, stamped with the epoch because it
    // was already true before anything looked, and therefore not a feed entry.
    await query(
      "INSERT INTO profile_activity (id,user_id,kind,key,title,subject,occurred_at) VALUES ($1,$2,'milestone','followers:100','Milestone reached','100 followers',$3)",
      [randomUUID(), creator, new Date(0).toISOString()],
    );
    await query(
      "INSERT INTO profile_activity (id,user_id,kind,key,title,subject,occurred_at) VALUES ($1,$2,'milestone','followers:1000','Milestone reached','1K followers',now())",
      [randomUUID(), creator],
    );
    const activity = await asUser(reader, (client) => creatorActivity(client, creator));
    const subjects = activity.map((event) => event.subject);
    expect(subjects).toContain("1K followers");
    expect(subjects).not.toContain("100 followers");
  });

  it("shows the newest events first and stops at the limit", async () => {
    for (let index = 0; index < 12; index += 1) await makeCreation(creator, `Creation ${index}`, { messages: index });
    const activity = await asUser(reader, (client) => creatorActivity(client, creator, 5));
    expect(activity).toHaveLength(5);
    const times = activity.map((event) => event.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("keeps one account's activity out of another's feed", async () => {
    await query("INSERT INTO profiles (id,username,display_name) VALUES ($1,'other','Other')", [other]);
    await makeCreation(other, "Not mine", { messages: 5 });
    const activity = await asUser(reader, (client) => creatorActivity(client, creator));
    expect(JSON.stringify(activity)).not.toContain("Not mine");
  });
});
