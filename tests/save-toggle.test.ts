import { afterEach, describe, expect, it, vi } from "vitest";
import { toggleCreationSave, type SaveState } from "@/lib/saves";

/**
 * Optimistic saving.
 *
 * One helper backs the feed card, the saved library and the creation page, so
 * these assert the contract all three depend on: the state flips immediately,
 * settles on the server's own total, and is put back exactly as it was when
 * the write fails. A count that never happened must never survive on screen.
 */

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function stubFetch(reply: { ok: boolean; body: unknown }) {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return { ok: reply.ok, status: reply.ok ? 200 : 500, json: async () => reply.body } as Response;
  }) as typeof fetch;
  return calls;
}

const creation = { id: "aaaaaaaa-0000-4000-8000-000000000001", savedByViewer: false, saveCount: 41 };

describe("saving", () => {
  it("flips immediately and then settles on the server's own total", async () => {
    const calls = stubFetch({ ok: true, body: { saved: true, saveCount: 42 } });
    const states: SaveState[] = [];
    expect(await toggleCreationSave(creation, (state) => states.push(state))).toBe("");
    expect(states[0]).toEqual({ savedByViewer: true, saveCount: 42 });
    expect(states.at(-1)).toEqual({ savedByViewer: true, saveCount: 42 });
    // The canonical save endpoint, not a second bookmark store.
    expect(calls[0]).toEqual({ url: "/api/saves", method: "POST" });
  });

  it("corrects an optimistic guess when other accounts moved the total meanwhile", async () => {
    stubFetch({ ok: true, body: { saved: true, saveCount: 108 } });
    const states: SaveState[] = [];
    await toggleCreationSave(creation, (state) => states.push(state));
    expect(states[0].saveCount).toBe(42);
    expect(states.at(-1)).toEqual({ savedByViewer: true, saveCount: 108 });
  });

  it("unsaves through the same relation and lowers the total", async () => {
    const calls = stubFetch({ ok: true, body: { saved: false, saveCount: 40 } });
    const states: SaveState[] = [];
    await toggleCreationSave({ ...creation, savedByViewer: true }, (state) => states.push(state));
    expect(states[0]).toEqual({ savedByViewer: false, saveCount: 40 });
    expect(states.at(-1)).toEqual({ savedByViewer: false, saveCount: 40 });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain(`characterId=${creation.id}`);
  });

  it("puts the original state back when the write fails, and says why", async () => {
    stubFetch({ ok: false, body: { error: "Sign in to continue" } });
    const states: SaveState[] = [];
    const failure = await toggleCreationSave(creation, (state) => states.push(state));
    expect(states[0]).toEqual({ savedByViewer: true, saveCount: 42 });
    expect(states.at(-1)).toEqual({ savedByViewer: false, saveCount: 41 });
    expect(failure).toBe("Sign in to continue");
  });

  it("never shows a negative total", async () => {
    stubFetch({ ok: true, body: { saved: false, saveCount: null } });
    const states: SaveState[] = [];
    await toggleCreationSave({ ...creation, savedByViewer: true, saveCount: 0 }, (state) => states.push(state));
    expect(states.every((state) => state.saveCount >= 0)).toBe(true);
  });
});
