import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureSchema, query, setPoolForTesting, transaction } from "@/lib/db";
import { generationFor, recordGeneration, resolveVersion, versionKey, type VersionRef } from "@/lib/provenance";

/**
 * PROVENANCE MUST NOT CONFIDENTLY LIE.
 *
 * Three ways it did.
 *
 *   Regenerate keeps every attempt as a variant of ONE message row, and the
 *   provenance columns on that row were overwritten by each new attempt. Ask
 *   about option 1 of 3 and you were shown option 3's memories.
 *
 *   A reader who rewords a memory changed what every past reply claimed to have
 *   read, because the reply stored an id and the id resolved to today's text.
 *
 *   The same for transcript turns, which the inline editor rewrites in place.
 */

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

let characterId = "";
let conversationId = "";
let messageId = "";

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();

  characterId = randomUUID(); conversationId = randomUUID(); messageId = randomUUID();
  await query("INSERT INTO characters (id,name,user_id) VALUES ($1,'Mara',$2)",[characterId,ownerId]);
  await query("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Story')",[conversationId,characterId,ownerId]);
  await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','Reply')",[messageId,conversationId,ownerId]);
});

function record(variantIndex: number, over: Partial<Parameters<typeof recordGeneration>[1]> = {}) {
  return {
    messageId, conversationId, userId: ownerId, variantIndex,
    action: "regenerate" as const,
    memoryVersions: [] as VersionRef[], transcriptVersions: [] as VersionRef[],
    arcIds: [], canonIds: [], sceneStateId: null, retrievalRunId: null,
    transcriptMessages: 0, transcriptTokens: 0, transcriptTrimmed: 0,
    summaryUsed: false, summaryCharacters: 0, continuityPlacement: "system",
    ...over,
  };
}

describe("one immutable row per generation", () => {
  it("keeps each regeneration's context instead of overwriting it", async () => {
    const first = randomUUID(); const second = randomUUID(); const third = randomUUID();
    await transaction((client) => recordGeneration(client, record(0, { memoryVersions: [{ id: first, v: 1 }], transcriptMessages: 10 })));
    await transaction((client) => recordGeneration(client, record(1, { memoryVersions: [{ id: second, v: 1 }], transcriptMessages: 12 })));
    await transaction((client) => recordGeneration(client, record(2, { memoryVersions: [{ id: third, v: 1 }], transcriptMessages: 14 })));

    const one = await transaction((client) => generationFor(client, ownerId, messageId, 0));
    const three = await transaction((client) => generationFor(client, ownerId, messageId, 2));
    expect(one?.memoryVersions).toEqual([{ id: first, v: 1 }]);
    expect(one?.transcriptMessages).toBe(10);
    expect(three?.memoryVersions).toEqual([{ id: third, v: 1 }]);
    expect(three?.transcriptMessages).toBe(14);
  });

  it("refuses to revise a generation that already happened", async () => {
    await transaction((client) => recordGeneration(client, record(0, { transcriptMessages: 10 })));
    await transaction((client) => recordGeneration(client, record(0, { transcriptMessages: 999 })));
    const stored = await transaction((client) => generationFor(client, ownerId, messageId, 0));
    expect(stored?.transcriptMessages).toBe(10);
  });

  it("reports a legacy generation as absent rather than inventing one", async () => {
    expect(await transaction((client) => generationFor(client, ownerId, messageId, 0))).toBe(null);
  });

  it("is owner-scoped: another account reads nothing", async () => {
    await transaction((client) => recordGeneration(client, record(0)));
    expect(await transaction((client) => generationFor(client, otherId, messageId, 0))).toBe(null);
  });
});

describe("resolving a recorded version against the rows as they stand now", () => {
  const reference: VersionRef = { id: "m1", v: 1 };

  it("reads the row itself when nothing has changed", () => {
    const resolved = resolveVersion(reference, { contentVersion: 1, content: "As written" }, new Map());
    expect(resolved).toEqual({ content: "As written", state: "as_supplied" });
  });

  it("reads the archive when the text has been edited since", () => {
    const archived = new Map([[versionKey(reference), { content: "The original wording" }]]);
    const resolved = resolveVersion(reference, { contentVersion: 2, content: "Reworded today" }, archived);
    expect(resolved).toEqual({ content: "The original wording", state: "edited_since" });
  });

  it("says removed rather than showing the current text when the archive is gone", () => {
    const resolved = resolveVersion(reference, { contentVersion: 3, content: "Reworded today" }, new Map());
    expect(resolved.state).toBe("removed_since");
    expect(resolved.content).toBe(null);
  });

  it("marks a superseded row as removed while still showing what was supplied", () => {
    const resolved = resolveVersion(reference, { contentVersion: 1, content: "Still here", removed: true }, new Map());
    expect(resolved).toEqual({ content: "Still here", state: "removed_since" });
  });

  it("reports a purged row honestly", () => {
    const resolved = resolveVersion(reference, undefined, new Map());
    expect(resolved).toEqual({ content: null, state: "removed_since" });
  });
});

describe("editing archives the version it replaced", () => {
  it("keeps a memory's original text where an old generation can still find it", async () => {
    const memoryId = randomUUID();
    await query(
      "INSERT INTO memories (id,character_id,conversation_id,user_id,content,kind,importance) VALUES ($1,$2,$3,$4,'She promised to return by Friday','promise',4)",
      [memoryId,characterId,conversationId,ownerId],
    );
    // What the PATCH handler does: archive the replaced version, bump the counter.
    await query(
      "INSERT INTO memory_versions (id,memory_id,user_id,version,content,kind,importance,keywords) SELECT $1,id,user_id,content_version,content,kind,importance,keywords FROM memories WHERE id=$2",
      [randomUUID(),memoryId],
    );
    await query("UPDATE memories SET content=$1,content_version=content_version+1 WHERE id=$2",["She promised to return by Sunday",memoryId]);

    const current = (await query<{content:string;content_version:number}>("SELECT content,content_version FROM memories WHERE id=$1",[memoryId])).rows[0];
    expect(current.content).toBe("She promised to return by Sunday");
    expect(Number(current.content_version)).toBe(2);

    const archived = (await query<{content:string}>("SELECT content FROM memory_versions WHERE memory_id=$1 AND version=1",[memoryId])).rows[0];
    expect(archived.content).toBe("She promised to return by Friday");

    // A generation that recorded version 1 still resolves to Friday.
    const resolved = resolveVersion({ id: memoryId, v: 1 }, { contentVersion: 2, content: current.content }, new Map([[`${memoryId}:1`, { content: archived.content }]]));
    expect(resolved).toEqual({ content: "She promised to return by Friday", state: "edited_since" });
  });

  it("keeps a transcript turn's original text the same way", async () => {
    const turnId = randomUUID();
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user','I will meet you at the pier')",[turnId,conversationId,ownerId]);
    await query(
      "INSERT INTO message_versions (id,message_id,user_id,version,role,content) SELECT $1,id,user_id,content_version,role,content FROM messages WHERE id=$2",
      [randomUUID(),turnId],
    );
    await query("UPDATE messages SET content=$1,content_version=content_version+1 WHERE id=$2",["I will meet you at the lighthouse",turnId]);

    const archived = (await query<{content:string}>("SELECT content FROM message_versions WHERE message_id=$1 AND version=1",[turnId])).rows[0];
    expect(archived.content).toBe("I will meet you at the pier");
    const resolved = resolveVersion({ id: turnId, v: 1 }, { contentVersion: 2, content: "I will meet you at the lighthouse" }, new Map([[`${turnId}:1`, { content: archived.content }]]));
    expect(resolved.state).toBe("edited_since");
    expect(resolved.content).toBe("I will meet you at the pier");
  });
});

describe("continuity layers that need no versioning, and why", () => {
  /*
   * These three are NOT versioned, and that is a claim about the code rather
   * than about the schema: canon supersedes by writing a new row and flipping a
   * status, scene state is append-only, and an arc is never touched after it is
   * created. Ids therefore resolve truthfully on their own.
   *
   * The claim is only true while it stays true, so it is checked rather than
   * asserted in a comment. If a future change starts mutating any of their
   * content, this fails and the fix is to version that layer, not to delete
   * this test.
   */
  const source = readFileSync;

  function sourceFiles() {
    const roots = ["src/lib", "src/app/api"];
    const found: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full);
      }
    };
    for (const root of roots) walk(root);
    return found;
  }

  const statements = sourceFiles()
    .flatMap((file) => (source(file, "utf8").match(/UPDATE\s+(core_canon_entries|conversation_scene_states|memory_arcs)\s+SET[^`"']*/gi) ?? []));

  it("never rewrites core canon content", () => {
    const canon = statements.filter((statement) => /UPDATE\s+core_canon_entries/i.test(statement));
    expect(canon.length).toBeGreaterThan(0);
    for (const statement of canon) expect(statement).not.toMatch(/\bcontent\s*=/i);
  });

  it("never rewrites a scene state or an arc after it is written", () => {
    for (const statement of statements) {
      if (/UPDATE\s+conversation_scene_states/i.test(statement)) expect(statement).not.toMatch(/\bcontent\s*=|\blocation\s*=|\bstory_day\s*=/i);
      if (/UPDATE\s+memory_arcs/i.test(statement)) expect(statement).not.toMatch(/\bsummary\s*=/i);
    }
  });
});
