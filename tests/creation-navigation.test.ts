import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  editorOriginKey, forgetEditorOrigin, markEditorOpenedFromCreation,
  savedEditDestination, takeEditorOrigin,
} from "@/lib/editor-navigation";
import { chatCta, chatCtaDescription, newStoryLabel } from "@/lib/creation-actions";

/**
 * Three navigation complaints, and the decisions behind them.
 *
 *   BACK RETURNED INTO THE EDITOR after saving, because the save pushed a
 *   second creation entry on top of the editor's.
 *
 *   THE CHAT BUTTON CREATED A STORY EVERY TIME it was pressed, so a reader
 *   with an ongoing story collected another empty one whenever they wanted to
 *   return to it.
 *
 *   THE STUDIO FLASHED on the way into a chat, because the shell rendered the
 *   "create your first character" empty state whenever a chat's creation had
 *   not arrived yet.
 *
 * The first two are pure decisions and are asserted as such. The third is a
 * rendering condition and is asserted against the shell's own source, which is
 * exactly where it lived.
 */

const creationId = "aaaaaaaa-0000-4000-8000-000000000001";
const otherId = "bbbbbbbb-0000-4000-8000-000000000002";

/** A sessionStorage that behaves, and one that refuses everything. */
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    size: () => values.size,
  };
}
const blockedStorage = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
  removeItem() { throw new Error("blocked"); },
};

describe("saving an edit does not stack a duplicate creation entry", () => {
  it("walks back to the creation when that is the entry underneath", () => {
    const storage = memoryStorage();
    markEditorOpenedFromCreation(storage, creationId);
    expect(savedEditDestination(creationId, takeEditorOrigin(storage))).toEqual({ type: "back" });
  });

  it("replaces the editor's entry when it was reached from anywhere else", () => {
    // The sidebar, a `?editCharacter=` link, a typed URL: nothing to go back
    // to, so the completed form is replaced rather than left in the stack.
    expect(savedEditDestination(creationId, null)).toEqual({ type: "replace", href: `/characters/${creationId}` });
  });

  it("ignores a marker left behind by a different creation", () => {
    const storage = memoryStorage();
    markEditorOpenedFromCreation(storage, otherId);
    expect(savedEditDestination(creationId, takeEditorOrigin(storage))).toEqual({ type: "replace", href: `/characters/${creationId}` });
  });

  it("spends the marker, so a second save cannot reuse it", () => {
    const storage = memoryStorage();
    markEditorOpenedFromCreation(storage, creationId);
    expect(takeEditorOrigin(storage)).toBe(creationId);
    expect(takeEditorOrigin(storage)).toBeNull();
    expect(storage.size()).toBe(0);
  });

  it("clears the marker when the editor is abandoned", () => {
    const storage = memoryStorage();
    markEditorOpenedFromCreation(storage, creationId);
    forgetEditorOrigin(storage);
    expect(takeEditorOrigin(storage)).toBeNull();
  });

  it("survives a storage that refuses to answer", () => {
    // A blocked store costs the optimisation, never the navigation.
    expect(() => markEditorOpenedFromCreation(blockedStorage, creationId)).not.toThrow();
    expect(takeEditorOrigin(blockedStorage)).toBeNull();
    expect(() => forgetEditorOrigin(blockedStorage)).not.toThrow();
    expect(savedEditDestination(creationId, null).type).toBe("replace");
  });

  it("keeps the key namespaced to Afterglow's navigation state", () => {
    expect(editorOriginKey).toBe("afterglow:nav:editorOrigin");
  });
});

describe("the editor route and the creation page agree about the marker", () => {
  const editor = readFileSync(new URL("../src/app/characters/[id]/edit/editor.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/characters/[id]/profile.tsx", import.meta.url), "utf8");

  it("writes the marker where Edit is actually pressed", () => {
    expect(page).toContain("markEditorOpenedFromCreation(window.sessionStorage, character.id)");
  });

  it("never pushes the creation page after a save", () => {
    // The one line the whole bug was.
    expect(editor).not.toContain("router.push(`/characters/${saved.id}`)");
    expect(editor).toContain("onSaved={(saved) => finish(saved.id)}");
  });

  it("clears the marker when the editor is closed or its creation deleted", () => {
    expect(editor.split("const leave")[1]).toContain("forgetEditorOrigin");
    expect(editor).toContain("onDeleted={() => { forgetEditorOrigin(");
  });
});

describe("the chat button resumes rather than creating", () => {
  const character = { name: "Elysia", title: "", creationType: "character" as const, profileType: "single" as const, cast: [] };
  const scenario = { name: "", title: "The Final War", creationType: "scenario" as const, profileType: "single" as const, cast: [] };
  const storyId = "cccccccc-0000-4000-8000-000000000003";

  it("starts the first story when there is none", () => {
    expect(chatCta(character, null)).toEqual({ kind: "start", label: "Start chat", conversationId: null });
    expect(chatCta(scenario, null)).toEqual({ kind: "start", label: "Enter story", conversationId: null });
  });

  it("opens the existing story when there is one", () => {
    expect(chatCta(character, storyId)).toEqual({ kind: "resume", label: "Continue chat", conversationId: storyId });
    expect(chatCta(scenario, storyId)).toEqual({ kind: "resume", label: "Continue story", conversationId: storyId });
  });

  it("names the story in the accessible label either way", () => {
    expect(chatCtaDescription(character, chatCta(character, null))).toBe("Start a chat with Elysia");
    expect(chatCtaDescription(character, chatCta(character, storyId))).toBe("Continue your most recent chat with Elysia");
    expect(chatCtaDescription(scenario, chatCta(scenario, storyId))).toBe("Continue your most recent story in The Final War");
  });

  it("keeps beginning again as its own action", () => {
    expect(newStoryLabel).toBe("New story");
    expect(chatCta(character, storyId).kind).not.toBe("start");
  });
});

describe("the creation page acts on that decision", () => {
  const page = readFileSync(new URL("../src/app/characters/[id]/profile.tsx", import.meta.url), "utf8");

  it("resumes by navigating, with no write at all", () => {
    const open = page.slice(page.indexOf("const openChat = useCallback"), page.indexOf("const toggleSave"));
    expect(open).toContain("router.push(chatHref(characterId, conversationId))");
    // The create path is the ELSE, reached only with no conversation in hand.
    expect(open).toContain("if (conversationId)");
    expect(open.indexOf("createStory")).toBeGreaterThan(open.indexOf("router.push(chatHref"));
  });

  it("guards creation against a double tap with a ref, not with state", () => {
    // Two taps inside one frame both read `starting === false`; a ref changes
    // on the first line of the first tap.
    expect(page).toContain("const startingRef = useRef(false)");
    expect(page).toContain("if (startingRef.current) return;");
  });

  it("acknowledges the tap before the navigation completes", () => {
    expect(page).toContain('{starting ? "Opening story…" : cta.label}');
  });

  it("reads the story from the server rather than guessing", () => {
    expect(page).toContain("detail.viewerConversationId ?? null");
  });
});

describe("navigating into a chat never renders another section of the app", () => {
  const shell = readFileSync(new URL("../src/components/shell/AppShell.tsx", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  it("knows its route on the first render rather than in an effect", () => {
    expect(shell).toContain("const searchParams = useSearchParams()");
    expect(shell).toContain("useState(() => routeFromSearch(searchParams.toString()))");
    expect(shell).toContain('useState<AppView>(bootRoute?.view ?? "home")');
  });

  it("gives the shell the Suspense boundary that reading the address requires", () => {
    expect(entry).toContain("<Suspense fallback={<AppBoot />}>");
    expect(entry).toContain("<AppShell />");
  });

  it("boots a chat URL into a chat, not into the splash", () => {
    expect(shell).toContain('bootRoute?.view === "chat"');
    expect(shell).toContain('<main className="app-shell booting"><ChatSkeletonPanel /></main>');
  });

  it("shows a loading chat, never the studio, while a chat is pending", () => {
    const branch = shell.slice(shell.indexOf(") : chatView.request ? ("), shell.indexOf("{editingWorld &&"));
    expect(branch).toContain("<ChatSkeletonPanel />");
    // The empty state still exists, and is now only reachable with nothing
    // pending — which is what it was always meant to mean.
    const emptyState = shell.lastIndexOf("<h1>Create someone");
    expect(emptyState).toBeGreaterThan(shell.indexOf(") : chatView.request ? ("));
  });

  it("keeps the skeleton shaped like the chat it precedes", () => {
    const panel = shell.slice(shell.indexOf("function ChatSkeletonPanel"));
    expect(panel).toContain('className="chat-panel chat-panel-loading"');
    expect(panel).toContain('aria-busy="true"');
    expect(panel).toContain("Opening this story");
  });
});

describe("the first frame of a creation page already uses Afterglow's own icon", () => {
  const creationLoading = readFileSync(new URL("../src/app/characters/[id]/loading.tsx", import.meta.url), "utf8");
  const creationPage = readFileSync(new URL("../src/app/characters/[id]/profile.tsx", import.meta.url), "utf8");
  const worldLoading = readFileSync(new URL("../src/app/worlds/[id]/loading.tsx", import.meta.url), "utf8");
  const creationStyles = readFileSync(new URL("../src/app/characters/[id]/profile.module.css", import.meta.url), "utf8");

  it("draws the same element the page itself draws a moment later", () => {
    // `.state` tints `svg` and nothing else, so a text glyph rendered here
    // inherited near-white body text and became pink the instant the page
    // mounted — the reported white sparkle.
    expect(creationStyles).toContain(".state svg { color: #e879a9; }");
    expect(creationLoading).toContain('<Sparkles size={26} className={styles.spin} />');
    expect(creationPage).toContain('<Sparkles size={26} className={styles.spin} />');
  });

  it("uses no bare sparkle glyph in either route-level loading state", () => {
    expect(creationLoading).not.toContain("✦");
    expect(worldLoading).not.toContain("✦");
    expect(worldLoading).toContain('<Sparkles size={26} className={styles.spin} />');
  });
});
