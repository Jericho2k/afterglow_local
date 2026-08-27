import type { CreatorMetrics } from "./achievements";

/**
 * Profile borders.
 *
 * A small, real foundation rather than a cosmetics system: six borders, each
 * unlocked by something the creator actually did, none of them purchasable and
 * none of them a currency. There is no store here and this file is not the
 * beginning of one — what it is the beginning of is creator identity, which is
 * the thing the sprint asked for.
 *
 * Two rules keep them from becoming noise:
 *
 *   A BORDER IS AN ACCENT, NOT A FRAME. Each is a thin ring and, at most, a
 *   soft glow. None of them puts anything between the reader and the avatar,
 *   because a portrait a creator chose is more interesting than a decoration
 *   the platform issued.
 *
 *   THE SERVER DECIDES WHAT IS UNLOCKED. `unlockedBorders` is the only
 *   authority, and the profile endpoint runs it against real metrics before
 *   storing a choice. A browser that posts `ranked` cannot equip `ranked`.
 */

export type ProfileBorderId = "default" | "rose" | "violet" | "star" | "ranked" | "luminary";

export type ProfileBorder = {
  id: ProfileBorderId;
  label: string;
  /** What earns it, in one line, shown beside the swatch. */
  requirement: string;
  /** The two stops the ring is drawn from, and the glow it casts. */
  colors: { from: string; to: string; glow: string };
};

export const profileBorders: ProfileBorder[] = [
  {
    id: "default",
    label: "Afterglow",
    requirement: "Available to everyone.",
    colors: { from: "#e879a9", to: "#8a5cf6", glow: "rgba(232, 121, 169, .28)" },
  },
  {
    id: "rose",
    label: "Rose",
    requirement: "Publish your first creation.",
    colors: { from: "#f4a6c0", to: "#e0518a", glow: "rgba(244, 166, 192, .3)" },
  },
  {
    id: "violet",
    label: "Violet",
    requirement: "Reach 100 followers.",
    colors: { from: "#a78bfa", to: "#6d3bd6", glow: "rgba(167, 139, 250, .32)" },
  },
  {
    id: "star",
    label: "Rising Star",
    requirement: "Rank in the top 10% of creators.",
    colors: { from: "#ffd7a1", to: "#e879a9", glow: "rgba(255, 215, 161, .3)" },
  },
  {
    id: "ranked",
    label: "Top 100",
    requirement: "Rank among the 100 most-read creators.",
    colors: { from: "#f0c987", to: "#b8722e", glow: "rgba(240, 201, 135, .34)" },
  },
  {
    id: "luminary",
    label: "Luminary",
    requirement: "Rank among the 10 most-read creators.",
    colors: { from: "#e6f2ff", to: "#8a5cf6", glow: "rgba(230, 242, 255, .36)" },
  },
];

const byId = new Map(profileBorders.map((border) => [border.id, border]));

export function profileBorder(id: string): ProfileBorder {
  return byId.get(id as ProfileBorderId) ?? byId.get("default")!;
}

export function isProfileBorderId(value: string): value is ProfileBorderId {
  return byId.has(value as ProfileBorderId);
}

/**
 * Which borders this creator may equip.
 *
 * Read from the same metrics the achievements are, so a border and the badge
 * beside it can never disagree about whether a threshold was crossed. Default
 * is always in the list: a creator who unpublishes everything loses the ring
 * they earned and keeps a profile that still looks like Afterglow.
 */
export function unlockedBorders(metrics: CreatorMetrics, rankTotal: number): ProfileBorderId[] {
  const unlocked: ProfileBorderId[] = ["default"];
  if (metrics.publishedCreations >= 1) unlocked.push("rose");
  if (metrics.followers >= 100) unlocked.push("violet");
  const percentile = metrics.rank !== null && rankTotal > 0 ? metrics.rank / rankTotal : null;
  if (percentile !== null && percentile <= 0.1) unlocked.push("star");
  if (metrics.rank !== null && metrics.rank <= 100) unlocked.push("ranked");
  if (metrics.rank !== null && metrics.rank <= 10) unlocked.push("luminary");
  return unlocked;
}

/**
 * The border to actually draw.
 *
 * A stored choice the creator no longer qualifies for falls back to Afterglow
 * rather than being honoured — the check is on read as well as on write, so a
 * ring that was earned and then lost stops being displayed without anything
 * having to notice and rewrite the row.
 */
export function effectiveBorder(stored: string, metrics: CreatorMetrics, rankTotal: number): ProfileBorder {
  const allowed = unlockedBorders(metrics, rankTotal);
  return profileBorder(allowed.includes(stored as ProfileBorderId) ? stored : "default");
}

/** The CSS custom properties a border contributes, and nothing else. */
export function borderVariables(border: ProfileBorder) {
  return {
    "--border-from": border.colors.from,
    "--border-to": border.colors.to,
    "--border-glow": border.colors.glow,
  } as Record<string, string>;
}
