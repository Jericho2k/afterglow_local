import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AchievementBadge, CreatorAvatar, CreatorCard, CreatorStat, RankMedal, rankSummary, type CreatorCardData } from "@/components/creator";
import { achievementStates } from "@/lib/achievements";
import { profileBorder } from "@/lib/cosmetics";

/**
 * Creator identity, as it is actually drawn.
 *
 * Three rules the sprint set explicitly, and each is a rendering decision
 * rather than a data one — which is why they are asserted against the markup:
 *
 *   THE MEDAL IS FOR THE TOP 100, on a creation page. A badge every creator
 *   carries is a label; one the hundred most-read creators carry is worth
 *   noticing, and putting a ranking widget on every creation would spend that
 *   distinction on nothing.
 *
 *   RANK IS NEVER COLOUR ALONE. The number is in the text and the standing is
 *   spelled out in the accessible name, so a reader who cannot tell gold from
 *   silver still knows exactly where a creator stands.
 *
 *   A LOCKED ACHIEVEMENT SAYS IT IS LOCKED. Dimming it is a visual convention
 *   and nothing more; the state has to be in the accessible name too.
 */

const border = profileBorder("default");

describe("the rank medal is a distinction rather than a label", () => {
  it("draws nothing for a creator outside the top 100", () => {
    expect(renderToStaticMarkup(<RankMedal rank={347} total={43_120} showFrom={100} />)).toBe("");
    expect(renderToStaticMarkup(<RankMedal rank={101} total={43_120} showFrom={100} />)).toBe("");
  });

  it("draws it at the boundary and above", () => {
    expect(renderToStaticMarkup(<RankMedal rank={100} total={43_120} showFrom={100} />)).toContain("#100");
    expect(renderToStaticMarkup(<RankMedal rank={1} total={43_120} showFrom={100} />)).toContain("#1");
  });

  it("draws nothing at all for an unranked creator", () => {
    expect(renderToStaticMarkup(<RankMedal rank={null} total={43_120} showFrom={100} />)).toBe("");
  });

  it("shows any rank where the profile asks for it", () => {
    // The creator's own page is where a rank of 347 is worth seeing.
    expect(renderToStaticMarkup(<RankMedal rank={347} total={43_120} />)).toContain("#347");
  });

  it("says where the creator stands in words, not only in colour", () => {
    const markup = renderToStaticMarkup(<RankMedal rank={42} total={43_120} showFrom={100} />);
    expect(markup).toContain("Ranked number 42 of 43,120 Afterglow creators");
    expect(markup).toContain("#42");
  });
});

describe("a rank in words", () => {
  it("reads as a percentile the product can defend", () => {
    expect(rankSummary(347, 43_120)).toBe("Top 0.8%");
    expect(rankSummary(1, 43_120)).toBe("Top 0.1%");
    expect(rankSummary(4_312, 43_120)).toBe("Top 10%");
  });

  it("says nothing when there is nothing to say", () => {
    expect(rankSummary(null, 43_120)).toBe("");
    expect(rankSummary(3, 0)).toBe("");
  });
});

describe("achievements", () => {
  const states = achievementStates(
    { followers: 100, messages: 0, publishedCreations: 1, publishedWorlds: 0, rank: null },
    0,
  );
  const unlocked = states.find((state) => state.id === "followers_100")!;
  const locked = states.find((state) => state.id === "followers_1k")!;

  it("draws an unlocked one with its title and what earned it", () => {
    const markup = renderToStaticMarkup(<AchievementBadge achievement={unlocked} />);
    expect(markup).toContain("First 100 Followers");
    expect(markup).toContain("Reach 100 followers.");
    expect(markup).toContain("Unlocked");
  });

  it("hides a locked one unless the surface asks for it", () => {
    expect(renderToStaticMarkup(<AchievementBadge achievement={locked} />)).toBe("");
    expect(renderToStaticMarkup(<AchievementBadge achievement={locked} showLocked />)).toContain("1K Followers");
  });

  it("says 'Locked' rather than relying on the dimming", () => {
    expect(renderToStaticMarkup(<AchievementBadge achievement={locked} showLocked />)).toContain("Locked");
  });

  it("keeps the earned check outside the clipped hexagon", () => {
    const source = readFileSync(new URL("../src/components/creator/CreatorIdentity.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/components/creator/creator.module.css", import.meta.url), "utf8");
    expect(source).toContain("styles.badgeArtwork");
    expect(source.indexOf("styles.badgeMark")).toBeLessThan(source.indexOf("styles.badgeCheck"));
    const artwork = css.slice(css.indexOf(".badgeArtwork"), css.indexOf("}", css.indexOf(".badgeArtwork")));
    expect(artwork).toContain("overflow: visible");
  });
});

describe("the avatar and its ring", () => {
  it("names the person in the image's alt text", () => {
    const markup = renderToStaticMarkup(<CreatorAvatar avatarPath="" name="Noctis" border={border} />);
    // With no picture there is an initial, marked decorative because the name
    // is already beside it.
    expect(markup).toContain("aria-hidden");
    expect(markup).toContain("N");
  });

  it("carries the border as data rather than as a class per cosmetic", () => {
    const markup = renderToStaticMarkup(<CreatorAvatar avatarPath="" name="Noctis" border={profileBorder("ranked")} />);
    expect(markup).toContain('data-border="ranked"');
    expect(markup).toContain("--border-from:#f0c987");
  });
});

describe("a stat says the exact number as well as the short one", () => {
  it("keeps the full figure available", () => {
    const markup = renderToStaticMarkup(<CreatorStat icon={null} label="Messages" value={2_310_000} />);
    expect(markup).toContain("2.3M");
    expect(markup).toContain('title="2,310,000"');
  });
});

/**
 * The creator card.
 *
 * This is the component that fixes the report the sprint opened with: a public
 * creation whose creator was visible only to that creator. The tests below are
 * about what a VISITOR sees, because that was the broken case.
 */
const card: CreatorCardData = {
  id: "cccccccc-0000-4000-8000-000000000001",
  username: "noctis",
  displayName: "Noctis",
  avatarPath: "",
  border,
  followers: 12_400,
  messages: 2_310_000,
  creations: 48,
  rank: 42,
  rankTotal: 43_120,
  viewerFollows: false,
  owner: false,
};

describe("the creator card names the creator to everybody", () => {
  it("shows the identity, the handle and the three real totals", () => {
    const markup = renderToStaticMarkup(<CreatorCard creator={card} />);
    expect(markup).toContain("Noctis");
    expect(markup).toContain("@noctis");
    expect(markup).toContain("Followers");
    expect(markup).toContain("Messages");
    expect(markup).toContain("Creations");
    expect(markup).toContain("12.4K");
    expect(markup).toContain("2.3M");
    expect(markup).toContain("48");
  });

  it("links the identity to the creator's real page", () => {
    const markup = renderToStaticMarkup(<CreatorCard creator={card} />);
    expect(markup).toContain('href="/creators/noctis"');
    expect(markup).toContain("Open Noctis&#x27;s creator profile");
  });

  it("offers Follow to a visitor", () => {
    const markup = renderToStaticMarkup(<CreatorCard creator={card} />);
    expect(markup).toContain("Follow");
    expect(markup).not.toContain("Edit profile");
  });

  it("says Following when the viewer already does", () => {
    const markup = renderToStaticMarkup(<CreatorCard creator={{ ...card, viewerFollows: true }} />);
    expect(markup).toContain("Following");
    expect(markup).toContain('aria-pressed="true"');
  });

  /*
   * The owner keeps the card.
   *
   * Hiding it from its creator on the grounds that they already know who they
   * are is exactly what made the page inconsistent. The layout is the same
   * object for everybody; only the control in it changes.
   */
  it("keeps the whole card for the creator, and swaps the control", () => {
    const markup = renderToStaticMarkup(<CreatorCard creator={{ ...card, owner: true }} />);
    expect(markup).toContain("Noctis");
    expect(markup).toContain("Followers");
    expect(markup).toContain("Edit profile");
    expect(markup).toContain("View your public profile");
    expect(markup).not.toContain("aria-pressed");
  });

  it("shows the medal only from the top 100", () => {
    expect(renderToStaticMarkup(<CreatorCard creator={card} />)).toContain("#42");
    expect(renderToStaticMarkup(<CreatorCard creator={{ ...card, rank: 347 }} />)).not.toContain("#347");
  });

  /*
   * A creation is never anonymous.
   *
   * An account with no handle still gets named, with the link and the follow
   * control simply absent rather than the whole section disappearing — which
   * is what used to happen, to every viewer except the creator.
   */
  it("still names a creator who has no public page yet", () => {
    const markup = renderToStaticMarkup(<CreatorCard creator={{ ...card, username: "" }} />);
    expect(markup).toContain("Noctis");
    expect(markup).toContain("Followers");
    expect(markup).not.toContain("href=\"/creators/");
    expect(markup).toContain("has not opened a public profile yet");
  });

  it("carries no profile inside it", () => {
    const markup = renderToStaticMarkup(<CreatorCard creator={card} />);
    // A creator's achievements, worlds and history belong on their own page.
    expect(markup).not.toContain("Achievement");
    expect(markup).not.toContain("Activity");
  });
});

describe("the creation page draws the creator for every viewer", () => {
  const page = readFileSync(new URL("../src/app/characters/[id]/profile.tsx", import.meta.url), "utf8");

  it("gates the section on the card rather than on a profile only the owner could read", () => {
    expect(page).toContain('{creatorCard && <section id="creator"');
    expect(page).not.toContain('{character.creator && <section id="creator"');
    expect(page).not.toContain("?view=creator&creator=");
  });

  it("uses the shared card rather than a second copy of it", () => {
    expect(page).toContain("<CreatorCard creator={creatorCard}");
    // One follow primitive, in src/lib/follows.ts.
    expect(page).not.toContain("/api/follows");
  });
});

describe("the creator card costs the creation page no extra round trips", () => {
  const route = readFileSync(new URL("../src/app/api/characters/[id]/route.ts", import.meta.url), "utf8");

  it("reads the standing from a join rather than from queries of its own", () => {
    expect(route).toContain("LEFT JOIN creator_stats cs ON cs.user_id=c.user_id");
    expect(route).toContain("LEFT JOIN profile_follows follows ON follows.creator_user_id=c.user_id");
    // The page must not rebuild the platform's rankings to draw one card.
    expect(route).not.toContain("refreshCreatorStatsIfStale");
  });
});
