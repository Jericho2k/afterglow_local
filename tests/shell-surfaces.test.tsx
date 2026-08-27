import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatsView } from "@/components/shell/ChatsView";
import { PersonasView } from "@/components/shell/PersonasView";
import { ProfileView } from "@/components/shell/ProfileView";
import shellStyles from "@/components/shell/shell.module.css";
import uiStyles from "@/components/ui/ui.module.css";
import type { Character, Conversation, Persona, Profile } from "@/lib/types";

/**
 * The redesigned shell surfaces.
 *
 * These assert the things a screenshot cannot: that nothing was lost in the
 * rebuild, that the list pages stay lean, and that the geometry actually
 * converged. The last group is the button QA — equivalent icon actions are
 * checked as a class rather than eyeballed one page at a time.
 */

const character: Character = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "Seraphine", creationType: "character", title: "Seraphine", profileType: "single",
  tagline: "", description: "", descriptionRich: [], userRole: "",
  avatarUrl: "https://cdn.example/seraphine.png", avatarPath: "", accent: "#7f3ce0",
  backstory: "", cast: [], lorebook: "", personality: "", scenario: "",
  greeting: "", greetingRich: [], alternateGreetings: [], alternateGreetingsRich: [],
  exampleDialogue: "", responseDirective: "", boundaries: "", sourceMaterial: "",
  worldIds: [], tags: [], hashtags: [], quickFacts: [], gallery: [],
  publicStats: { messages: null, saves: null, chats: null, rank: null, rankCategory: null },
  visibility: "public", nsfwEnabled: false, saveCount: 0, savedByViewer: false,
  creator: null, ownedByViewer: true,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};

const conversation = (id: string, title: string): Conversation => ({
  id, characterId: character.id, title, summary: "",
  personaId: null, providerId: "deepseek", modelId: "deepseek-v4-flash", rpEngineId: "immersive",
  instructionPresets: [], customInstructions: "", responseLength: null, temperature: null,
  messageCount: 12, createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(),
});

const persona: Persona = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  name: "Ivy", description: "A archivist who never stops taking notes.",
  avatarUrl: "", avatarPath: "", accent: "#e879a9", isDefault: true,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};

const profile: Profile = {
  id: "cccccccc-0000-4000-8000-000000000001",
  username: "", displayName: "Alex", avatarPath: "", bio: "", plan: "free",
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};

describe("Chats", () => {
  it("leads with the creation rather than the first message sent to it", () => {
    const markup = renderToStaticMarkup(<ChatsView
      characters={[character]}
      conversations={[conversation("c1", "A quiet evening"), conversation("c2", "The argument")]}
      personas={[persona]}
      onOpen={() => undefined}
      onCreate={() => undefined}
    />);
    expect(markup).toContain("Seraphine");
    expect(markup).toContain(shellStyles.chatArt);
    // Two stories, so the group offers to show all of them and reports the count.
    expect(markup).toContain("2 stories");
    expect(markup).toContain("All 2");
  });

  it("keeps every conversation reachable and hides none", () => {
    const conversations = ["c1", "c2", "c3"].map((id, index) => conversation(id, `Story ${index + 1}`));
    const markup = renderToStaticMarkup(<ChatsView
      characters={[character]} conversations={conversations} personas={[persona]}
      onOpen={() => undefined} onCreate={() => undefined}
    />);
    // Grouping is presentation. The count must reflect everything that exists.
    expect(markup).toContain("3 stories");
    expect(markup).toContain("3 stories across 1 creation");
  });

  it("offers a real empty state instead of a bare sentence", () => {
    const markup = renderToStaticMarkup(<ChatsView
      characters={[]} conversations={[]} personas={[]}
      onOpen={() => undefined} onCreate={() => undefined}
    />);
    expect(markup).toContain("No stories yet");
    expect(markup).toContain(shellStyles.empty);
  });
});

describe("Personas", () => {
  it("presents personas as people and marks the default one", () => {
    const markup = renderToStaticMarkup(<PersonasView personas={[persona]} onChange={() => undefined} />);
    expect(markup).toContain("Ivy");
    expect(markup).toContain("Default");
    expect(markup).toContain(shellStyles.avatar);
    // Personas are who the USER plays, and the page says so rather than
    // leaving it to be confused with a creation's cast.
    expect(markup).toContain("Who you play as");
  });
});

describe("Profile", () => {
  /**
   * This used to assert that the words "Followers" and "Rank" never appeared,
   * because at the time they would have been fiction. They are real numbers
   * now — followers is a relation, rank is a stated ordering over published
   * work — so the assertion moves rather than being dropped: what must never
   * appear is a metric the product does not compute, and what must never
   * appear YET is a number whose value has not arrived.
   */
  it("shows the editable fields", () => {
    const markup = renderToStaticMarkup(<ProfileView profile={profile} onSaved={() => undefined} />);
    expect(markup).toContain("Display name");
    expect(markup).toContain("Creator username");
    expect(markup).toContain("Bio");
  });

  it("names no metric the product does not compute", () => {
    const markup = renderToStaticMarkup(<ProfileView profile={profile} onSaved={() => undefined} />);
    // "Reach" is deliberately absent from this list: it appears as a verb in
    // "Reach 100 followers", which is a requirement rather than a metric.
    for (const fiction of ["Impressions", "Trending", "Engagement", "Views", "Score"]) {
      expect(markup, `${fiction} is not something Afterglow measures`).not.toContain(fiction);
    }
  });

  it("draws no standing at all until the real one has arrived", () => {
    // The stats card renders from a fetched aggregate; before it resolves there
    // is nothing to show, and a placeholder zero would be a number that is not
    // true rather than a number that is not there yet.
    const markup = renderToStaticMarkup(<ProfileView profile={profile} onSaved={() => undefined} />);
    expect(markup).not.toContain("Followers");
    expect(markup).not.toContain("Messages");
  });

  it("offers only the cosmetics this account has actually earned", () => {
    const markup = renderToStaticMarkup(<ProfileView profile={profile} onSaved={() => undefined} />);
    // Afterglow's own ring is available to everybody and selected; every other
    // ring is disabled and says what earns it.
    expect(markup).toContain('aria-label="Afterglow"');
    expect(markup).toContain('aria-label="Top 100 — locked. Rank among the 100 most-read creators."');
    expect(markup).toContain("disabled=\"\"");
  });
});

describe("button geometry", () => {
  const ui = readFileSync("src/components/ui/ui.module.css", "utf8");

  it("gives every ordinary icon action the same rounded-square shape", () => {
    const iconRule = ui.slice(ui.indexOf(".iconButton {"), ui.indexOf("}", ui.indexOf(".iconButton {")));
    expect(iconRule).toContain("border-radius: var(--ui-radius-control)");
    expect(iconRule).not.toContain("border-radius: 50%");
  });

  it("has removed the circular hero controls the pages used to define", () => {
    for (const path of [
      "src/app/characters/[id]/profile.module.css",
      "src/app/characters/[id]/cast/[memberId]/member.module.css",
      "src/app/worlds/[id]/profile.module.css",
    ]) {
      const css = readFileSync(path, "utf8");
      expect(css, `${path} still declares a circular icon control`).not.toMatch(/\.circleButton\s*\{/);
    }
  });

  it("uses one canonical menu control rather than three copies and two legacies", () => {
    const globals = readFileSync("src/app/globals.css", "utf8");
    expect(globals).not.toMatch(/\.mobile-menu\s*\{/);
    expect(globals).not.toMatch(/\.global-mobile-menu\s*\{/);
    // The remaining per-surface rules decide placement only; the shape comes
    // from the shared primitive.
    for (const path of [
      "src/components/feed/feed.module.css",
      "src/components/worlds/worlds.module.css",
      "src/components/creations/creations.module.css",
    ]) {
      const rule = readFileSync(path, "utf8").match(/\.menuButton \{[^}]*\}/)?.[0] ?? "";
      expect(rule, `${path} still styles the menu button itself`).not.toContain("border-radius");
    }
  });

  it("keeps the world hero bar a row, so Back and More cannot stack", () => {
    // The original bug in full: `.heroBar` was declared with no `display` and
    // given `justify-content: space-between` later in the same file, so the
    // alignment was inert and the two children stacked vertically — the
    // three-dot control rendered underneath Back rather than opposite it.
    const css = readFileSync("src/app/worlds/[id]/profile.module.css", "utf8");
    const bar = css.slice(css.indexOf(".heroBar {"), css.indexOf("}", css.indexOf(".heroBar {")));
    expect(bar).toContain("display: flex");
    expect(bar).toContain("justify-content: space-between");
    // And the safe area is respected on all three edges the bar touches.
    expect(bar).toContain("env(safe-area-inset-top)");
    expect(bar).toContain("env(safe-area-inset-left)");
    // Exactly one top-level declaration, so the display and the alignment
    // cannot be separated again. The responsive override inside a media query
    // is indented and only adjusts padding.
    expect(css.match(/^\.heroBar\s*\{/gm) ?? []).toHaveLength(1);
  });

  it("keeps circles only where the circle means something", () => {
    // Avatars stay round. That is a shape with a meaning, not an inconsistency.
    expect(shellStyles.avatar).toBeTruthy();
    const shell = readFileSync("src/components/shell/shell.module.css", "utf8");
    const avatarRule = shell.slice(shell.indexOf(".avatar {"), shell.indexOf("}", shell.indexOf(".avatar {")));
    expect(avatarRule).toContain("border-radius: 50%");
  });

  it("exposes the shared variants the surfaces are built from", () => {
    for (const variant of ["iconButton", "button", "primary", "secondary", "destructive", "chip", "subtle", "onMedia"]) {
      expect(uiStyles[variant], `${variant} must exist as a shared variant`).toBeTruthy();
    }
  });
});
