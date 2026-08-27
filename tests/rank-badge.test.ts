import { describe, expect, it } from "vitest";
import { platformTagCategories } from "@/lib/tags";
import {
  bestRankBadge, parseRankingCategory, rankBadgeLabel, rankBadgeThreshold,
  rankingCategories, rankingCategoryLabel,
} from "@/lib/rankings";

/**
 * Which rank a creation page is allowed to mention.
 *
 * This is a product rule rather than a query, so it is tested as one. The
 * failure it exists to prevent is a creation page reading
 *
 *   #147 Overall · #5 Drama · #19 Romance · #73 Fantasy
 *
 * which is four facts where there is one.
 */

describe("the badge a creation shows", () => {
  it("prefers a category rank over the overall one", () => {
    const badge = bestRankBadge([
      { category: "", rank: 147, rankTotal: 40_000 },
      { category: "Drama", rank: 5, rankTotal: 900 },
      { category: "Romance", rank: 19, rankTotal: 2_400 },
    ]);
    expect(badge).toEqual({ category: "Drama", rank: 5, rankTotal: 900 });
    expect(rankBadgeLabel(badge!)).toBe("#5 in Drama");
  });

  it("takes the best numerical rank among categories", () => {
    const badge = bestRankBadge([
      { category: "Fantasy", rank: 73, rankTotal: 5_000 },
      { category: "Horror", rank: 12, rankTotal: 800 },
      { category: "Romance", rank: 40, rankTotal: 9_000 },
    ]);
    expect(badge?.category).toBe("Horror");
  });

  /*
   * The tie-break is the part that has to be decided rather than left to
   * whatever order the rows arrived in, or the same creation would show a
   * different badge on two page loads.
   */
  it("breaks a tie on the larger field, then on the name — deterministically", () => {
    const ranks = [
      { category: "Romance", rank: 5, rankTotal: 9_000 },
      { category: "Drama", rank: 5, rankTotal: 900 },
    ];
    // Fifth out of nine thousand is the better result.
    expect(bestRankBadge(ranks)?.category).toBe("Romance");
    expect(bestRankBadge([...ranks].reverse())?.category).toBe("Romance");

    const sameField = [
      { category: "Romance", rank: 5, rankTotal: 900 },
      { category: "Drama", rank: 5, rankTotal: 900 },
    ];
    expect(bestRankBadge(sameField)?.category).toBe("Drama");
    expect(bestRankBadge([...sameField].reverse())?.category).toBe("Drama");
  });

  it("falls back to Overall when no category qualifies", () => {
    const badge = bestRankBadge([
      { category: "", rank: 42, rankTotal: 40_000 },
      { category: "Drama", rank: 380, rankTotal: 900 },
    ]);
    expect(badge).toEqual({ category: "", rank: 42, rankTotal: 40_000 });
    expect(rankBadgeLabel(badge!)).toBe("#42 Overall");
  });

  it("shows nothing at all below the threshold", () => {
    expect(bestRankBadge([
      { category: "", rank: 147, rankTotal: 40_000 },
      { category: "Drama", rank: 101, rankTotal: 900 },
    ])).toBe(null);
    expect(bestRankBadge([])).toBe(null);
  });

  it("shows the badge exactly at the threshold", () => {
    expect(bestRankBadge([{ category: "Drama", rank: rankBadgeThreshold, rankTotal: 900 }])?.rank).toBe(100);
    expect(bestRankBadge([{ category: "Drama", rank: rankBadgeThreshold + 1, rankTotal: 900 }])).toBe(null);
  });
});

/**
 * What can be a board.
 *
 * Tags and hashtags are separate systems on purpose. A ranking category anybody
 * can mint by typing it is a ranking nobody can trust, so only the controlled
 * taxonomy is eligible — and only its GENRE group, because "the most-read
 * Submissive creations" is not a board anybody is looking for.
 */
describe("ranking categories come from the controlled taxonomy", () => {
  it("is exactly the genre group", () => {
    const genres = platformTagCategories.find((category) => category.id === "genre")!.tags;
    expect(rankingCategories).toEqual(genres);
    expect(rankingCategories).toContain("Drama");
    expect(rankingCategories).toContain("Romance");
    expect(rankingCategories).toContain("Sci-Fi");
  });

  it("does not rank identity, orientation, point of view or adult tags", () => {
    for (const tag of ["Female", "Straight", "AnyPOV", "Dominant", "Explicit", "Femboy", "Maid"]) {
      expect(rankingCategories, `${tag} is not a board`).not.toContain(tag);
    }
  });

  it("refuses anything that is not a taxonomy genre", () => {
    // A creator hashtag, a made-up board, an injection attempt.
    expect(parseRankingCategory("darkacademia")).toBe("");
    expect(parseRankingCategory("'; DROP TABLE creation_rankings;--")).toBe("");
    expect(parseRankingCategory("Best")).toBe("");
  });

  it("accepts a genre however it was spelled, and treats Overall as the whole board", () => {
    expect(parseRankingCategory("drama")).toBe("Drama");
    expect(parseRankingCategory("  DRAMA ")).toBe("Drama");
    expect(parseRankingCategory("Overall")).toBe("");
    expect(parseRankingCategory("")).toBe("");
    expect(parseRankingCategory(null)).toBe("");
  });

  it("names the overall board rather than leaving it blank", () => {
    expect(rankingCategoryLabel("")).toBe("Overall");
    expect(rankingCategoryLabel("Drama")).toBe("Drama");
  });
});
