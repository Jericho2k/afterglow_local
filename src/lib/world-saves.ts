import { api } from "./api-client";

/**
 * Saving a world.
 *
 * The same optimistic dance saving a creation uses, over the world relation:
 * flip immediately so a tap feels instant, settle on the server's own total
 * once it answers, and put the original state back if the write failed —
 * because a count that never happened must never stay on screen.
 *
 * Deliberately a sibling of `toggleCreationSave` rather than a generalisation
 * of it. The two write different tables with different visibility rules; what
 * they share is a contract, and duplicating twenty lines is cheaper than a
 * polymorphic save layer that has to branch on entity type at every step.
 */

export type WorldSaveState = { savedByViewer: boolean; saveCount: number };

export async function toggleWorldSave(
  world: { id: string; savedByViewer: boolean; saveCount: number },
  apply: (state: WorldSaveState) => void,
): Promise<string> {
  const next = !world.savedByViewer;
  apply({ savedByViewer: next, saveCount: Math.max(0, world.saveCount + (next ? 1 : -1)) });
  try {
    const result = next
      ? await api<{ saved: boolean; saveCount: number | null }>("/api/world-saves", { method: "POST", body: JSON.stringify({ worldId: world.id }) })
      : await api<{ saved: boolean; saveCount: number | null }>(`/api/world-saves?worldId=${encodeURIComponent(world.id)}`, { method: "DELETE" });
    // Null means the world is no longer readable, which the caller renders as
    // "keep the number you already worked out".
    if (result.saveCount !== null) apply({ savedByViewer: result.saved, saveCount: result.saveCount });
    return "";
  } catch (reason) {
    apply({ savedByViewer: world.savedByViewer, saveCount: world.saveCount });
    return reason instanceof Error ? reason.message : "Could not save that world";
  }
}
