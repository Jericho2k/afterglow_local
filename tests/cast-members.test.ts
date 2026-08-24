import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { castMemberKey, findCastMember, slugifyName, withCastMemberIds } from "@/lib/cast";
import type { CharacterCastMember } from "@/lib/types";

/**
 * Cast members.
 *
 * A cast member has a portrait and a page of its own, which means it needs an
 * address that survives the creator reordering the cast — the thing an array
 * index would not do. And because the page is a subresource rather than a
 * creation, it inherits its parent's visibility and shows only the half of a
 * member that was ever meant for readers.
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

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const castRoute = await import("@/app/api/characters/[id]/cast/[memberId]/route");

const publicCreation = "aaaaaaaa-0000-4000-8000-000000000001";
const privateCreation = "aaaaaaaa-0000-4000-8000-000000000002";

const member = (changes: Partial<CharacterCastMember> = {}): CharacterCastMember => ({
  name: "Maya", role: "Night-shift nurse", description: "Dry, tired, and secretly the one holding it together.",
  tagline: "Pays the bills and pretends not to care.", avatarPath: "", avatarUrl: "", ...changes,
});

const cast = [
  member(),
  member({ name: "Sophie", role: "Art student", description: "Chaos incarnate.", tagline: "Talks to the toaster." }),
  member({ name: "Alex", role: "Works from home", description: "Allergic to sincerity.", tagline: "Knows everyone's business." }),
];

async function open(creationId: string, memberId: string) {
  const response = await castRoute.GET(
    new Request(`http://test/api/characters/${creationId}/cast/${memberId}`),
    { params: Promise.resolve({ id: creationId, memberId }) },
  );
  return { status: response.status, body: await response.json() };
}

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
  setPoolForTesting(new (memoryDb.adapters.createPg()).Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: bob, email: null };

  await query(
    `INSERT INTO characters (id,user_id,name,title,creation_type,profile_type,visibility,published_at,cast_members,accent,response_directive,boundaries)
     VALUES ($1,$2,'Roommates From Hell','Roommates From Hell','cast','ensemble','public',now(),$3::jsonb,'#b892f0','Never write for the reader.','No violence.')`,
    [publicCreation, alice, JSON.stringify(cast)],
  );
  await query(
    "INSERT INTO characters (id,user_id,name,title,visibility,cast_members) VALUES ($1,$2,'Unfinished','Unfinished','private',$3::jsonb)",
    [privateCreation, alice, JSON.stringify(cast)],
  );
});

describe("a member's address survives reordering", () => {
  it("prefers a stored id over anything derived", () => {
    expect(castMemberKey({ id: "abc123", name: "Maya" })).toBe("abc123");
  });

  it("falls back to a slug of the name for a member written before ids existed", () => {
    expect(castMemberKey({ name: "Maya" })).toBe("maya");
    expect(castMemberKey({ name: "Détective Marchand" })).toBe("detective-marchand");
    expect(slugifyName("  The Winter Queen!  ")).toBe("the-winter-queen");
  });

  it("resolves the same member after the cast is reordered", () => {
    const key = castMemberKey(cast[2]);
    const reordered = [cast[2], cast[0], cast[1]];
    expect(findCastMember(reordered, key)?.name).toBe("Alex");
  });

  it("resolves by id and by name, so an old link keeps working", () => {
    const withIds = withCastMemberIds(cast);
    expect(findCastMember(withIds, withIds[1].id!)?.name).toBe("Sophie");
    expect(findCastMember(withIds, "sophie")?.name).toBe("Sophie");
  });

  it("gives a member an id on save without disturbing one that has it", () => {
    const seeded = withCastMemberIds([member({ id: "keepme" }), member({ name: "Sophie" })]);
    expect(seeded[0].id).toBe("keepme");
    expect(seeded[1].id).toMatch(/^[a-f0-9]{24}$/);
  });

  it("does not invent an id for a nameless placeholder row", () => {
    expect(withCastMemberIds([member({ name: "" })])[0].id).toBeUndefined();
  });

  it("has no address for a member whose name cannot be slugged", () => {
    // Better to render such a member without a link than to link to a page
    // that cannot resolve it.
    expect(castMemberKey({ name: "＊＊＊" })).toBe("");
    expect(findCastMember(cast, "")).toBeNull();
  });
});

describe("a member's page", () => {
  it("requires an account", async () => {
    account = null;
    expect((await open(publicCreation, "maya")).status).toBe(401);
  });

  it("opens for a member of a published creation", async () => {
    const { status, body } = await open(publicCreation, "maya");
    expect(status).toBe(200);
    expect(body.member.name).toBe("Maya");
    expect(body.member.role).toBe("Night-shift nurse");
    expect(body.member.tagline).toContain("Pays the bills");
    expect(body.creation).toMatchObject({ id: publicCreation, title: "Roommates From Hell", accent: "#b892f0" });
  });

  it("never exposes the member's AI definition", async () => {
    const { body } = await open(publicCreation, "maya");
    expect(body.member).not.toHaveProperty("description");
    expect(JSON.stringify(body)).not.toContain("secretly the one holding it together");
  });

  it("never exposes the parent creation's hidden instructions", async () => {
    const payload = JSON.stringify((await open(publicCreation, "maya")).body);
    expect(payload).not.toContain("Never write for the reader.");
    expect(payload).not.toContain("No violence.");
  });

  it("inherits its parent's visibility rather than deciding its own", async () => {
    // The same member, in a creation nobody published.
    expect((await open(privateCreation, "maya")).status).toBe(404);
    account = { id: alice, email: null };
    expect((await open(privateCreation, "maya")).status).toBe(200);
  });

  it("answers 404 for a member the creation does not have", async () => {
    expect((await open(publicCreation, "nobody")).status).toBe(404);
  });

  it("keeps working for a member with no portrait", async () => {
    const { body } = await open(publicCreation, "alex");
    expect(body.member.avatarPath).toBe("");
    expect(body.member.avatarUrl).toBe("");
    expect(body.member.name).toBe("Alex");
  });

  it("serves a member by its stored id once one exists", async () => {
    const seeded = withCastMemberIds(cast);
    await query("UPDATE characters SET cast_members=$1::jsonb WHERE id=$2", [JSON.stringify(seeded), publicCreation]);
    const { status, body } = await open(publicCreation, seeded[0].id!);
    expect(status).toBe(200);
    expect(body.member.name).toBe("Maya");
  });
});

describe("portraits", () => {
  it("carries a portrait through to the page when one was uploaded", async () => {
    const withPortrait = [{ ...cast[0], avatarPath: "users/a/avatars/maya.png" }, ...cast.slice(1)];
    await query("UPDATE characters SET cast_members=$1::jsonb WHERE id=$2", [JSON.stringify(withPortrait), publicCreation]);
    const { body } = await open(publicCreation, "maya");
    expect(body.member.avatarPath).toBe("users/a/avatars/maya.png");
  });

  it("keeps a member written before portraits existed working", async () => {
    await query(
      "UPDATE characters SET cast_members=$1::jsonb WHERE id=$2",
      [JSON.stringify([{ name: "Maya", role: "Roommate", description: "Old record." }]), publicCreation],
    );
    const { status, body } = await open(publicCreation, "maya");
    expect(status).toBe(200);
    expect(body.member).toMatchObject({ name: "Maya", role: "Roommate", avatarPath: "", avatarUrl: "", tagline: "" });
  });
});
