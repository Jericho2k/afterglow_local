/**
 * What a creator has earned.
 *
 * Every achievement here is a threshold on a number the database already
 * maintains, and that is the entire design. There is no achievement for
 * "engagement", none for a score nobody can check, and none that a creator
 * cannot work out for themselves from the three figures on their own profile.
 * A badge that cannot be explained is decoration; a badge that names a real
 * milestone is a record.
 *
 * The set is deliberately SMALL. The reference design shows five badges in a
 * row, and five earned badges read as an achievement while thirty read as a
 * checklist — so each family stops at the point where the next tier would be
 * aspirational rather than meaningful, and the rank family exists only where
 * the standing is genuinely rare.
 *
 * WHEN an achievement was earned is not stored here, because for most of them
 * nobody knows. See `profile_achievements` in 0021: the first time the system
 * OBSERVES a threshold is recorded, so future crossings become real history,
 * and a creator who passed ten thousand messages last year holds the
 * achievement without the product inventing a date for it.
 */

export type AchievementCategory = "followers" | "messages" | "creations" | "worlds" | "rank";

export type Achievement = {
  id: string;
  category: AchievementCategory;
  title: string;
  /** One line, in the product's voice, saying what earns it. */
  description: string;
  /**
   * The icon this renders with. A name rather than a component, so the
   * definitions stay usable on the server and in a test.
   */
  icon: "heart" | "message" | "flame" | "star" | "crown" | "globe" | "medal" | "sparkle";
  /** The number the metric must reach. Absent for rank achievements. */
  threshold?: number;
  /** For rank achievements: the standing that earns it. */
  rank?: { atOrBetter: number };
};

/** The metrics an achievement can be measured against. All real, all public. */
export type CreatorMetrics = {
  followers: number;
  /** User messages received across published creations. See 0021. */
  messages: number;
  publishedCreations: number;
  publishedWorlds: number;
  /** Null when this creator is not ranked, which is not a failure. */
  rank: number | null;
};

export const achievements: Achievement[] = [
  { id: "followers_100", category: "followers", title: "First 100 Followers", description: "Reach 100 followers.", icon: "heart", threshold: 100 },
  { id: "followers_1k", category: "followers", title: "1K Followers", description: "Reach 1,000 followers.", icon: "heart", threshold: 1_000 },
  { id: "followers_10k", category: "followers", title: "10K Followers", description: "Reach 10,000 followers.", icon: "heart", threshold: 10_000 },
  { id: "followers_100k", category: "followers", title: "100K Followers", description: "Reach 100,000 followers.", icon: "heart", threshold: 100_000 },

  { id: "messages_10k", category: "messages", title: "10K Messages", description: "Receive 10,000 messages across your published creations.", icon: "message", threshold: 10_000 },
  { id: "messages_100k", category: "messages", title: "100K Messages", description: "Receive 100,000 messages across your published creations.", icon: "message", threshold: 100_000 },
  { id: "messages_1m", category: "messages", title: "1M Messages", description: "Receive 1,000,000 messages across your published creations.", icon: "flame", threshold: 1_000_000 },

  { id: "creations_1", category: "creations", title: "First Creation", description: "Publish your first creation.", icon: "sparkle", threshold: 1 },
  { id: "creations_10", category: "creations", title: "10 Creations", description: "Publish 10 creations.", icon: "sparkle", threshold: 10 },
  { id: "creations_25", category: "creations", title: "Marathon Writer", description: "Publish 25 creations.", icon: "flame", threshold: 25 },

  { id: "worlds_1", category: "worlds", title: "World Builder", description: "Publish your first world.", icon: "globe", threshold: 1 },
  { id: "worlds_3", category: "worlds", title: "Three Worlds", description: "Publish 3 worlds.", icon: "globe", threshold: 3 },

  { id: "rank_top_10_percent", category: "rank", title: "Rising Star", description: "Rank in the top 10% of creators.", icon: "star" },
  { id: "rank_top_1_percent", category: "rank", title: "Top 1%", description: "Rank in the top 1% of creators.", icon: "star" },
  { id: "rank_top_100", category: "rank", title: "Top 100 Creator", description: "Rank among the 100 most-read creators.", icon: "medal", rank: { atOrBetter: 100 } },
  { id: "rank_top_10", category: "rank", title: "Top 10 Creator", description: "Rank among the 10 most-read creators.", icon: "crown", rank: { atOrBetter: 10 } },
];

const byId = new Map(achievements.map((achievement) => [achievement.id, achievement]));

export function achievementById(id: string) {
  return byId.get(id) ?? null;
}

/**
 * Where a creator stands as a fraction, or null when they are not ranked.
 *
 * Rank 1 of 500 is the top 0.2%, and rank 500 of 500 is the 100th percentile
 * rather than the 0th — the number answers "how far from the top", which is
 * the direction the product talks in.
 */
export function rankPercentile(rank: number | null, total: number) {
  if (rank === null || total <= 0) return null;
  return Math.min(1, Math.max(0, rank / total));
}

/**
 * Whether one achievement is earned by these metrics.
 *
 * Percentile achievements are deliberately evaluated against the rank AND the
 * size of the field, so "top 10%" means what it says on a platform of forty
 * creators and on a platform of forty thousand.
 */
export function achievementUnlocked(achievement: Achievement, metrics: CreatorMetrics, rankTotal: number) {
  if (achievement.rank) return metrics.rank !== null && metrics.rank <= achievement.rank.atOrBetter;
  if (achievement.category === "rank") {
    const percentile = rankPercentile(metrics.rank, rankTotal);
    if (percentile === null) return false;
    if (achievement.id === "rank_top_10_percent") return percentile <= 0.1;
    if (achievement.id === "rank_top_1_percent") return percentile <= 0.01;
    return false;
  }
  const threshold = achievement.threshold ?? Infinity;
  if (achievement.category === "followers") return metrics.followers >= threshold;
  if (achievement.category === "messages") return metrics.messages >= threshold;
  if (achievement.category === "creations") return metrics.publishedCreations >= threshold;
  if (achievement.category === "worlds") return metrics.publishedWorlds >= threshold;
  return false;
}

export type AchievementState = Achievement & {
  unlocked: boolean;
  /** When the system first observed it. Null for one earned before it looked. */
  unlockedAt: string | null;
};

/**
 * Every achievement, with its state for this creator.
 *
 * Locked ones are included rather than filtered out: a profile that shows what
 * is still ahead is a profile worth building toward, and the owner's own view
 * is where that matters most. Which of them a visitor actually SEES is a
 * presentation decision, made on the page.
 */
export function achievementStates(
  metrics: CreatorMetrics,
  rankTotal: number,
  unlockedAt: Map<string, string> = new Map(),
): AchievementState[] {
  return achievements.map((achievement) => {
    const unlocked = achievementUnlocked(achievement, metrics, rankTotal);
    return { ...achievement, unlocked, unlockedAt: unlocked ? unlockedAt.get(achievement.id) ?? null : null };
  });
}

/**
 * The achievements a profile leads with.
 *
 * The creator's own choice when they have made one, and otherwise the hardest
 * things they have actually done — because an automatic selection that led
 * with "First Creation" would be technically true and say nothing. A featured
 * id that is not unlocked is dropped here as well as rejected on write, so a
 * creator who unpublishes their way below a threshold stops displaying it.
 */
export function featuredAchievements(states: AchievementState[], chosen: string[], limit = 5) {
  const unlocked = states.filter((state) => state.unlocked);
  const picked = chosen
    .map((id) => unlocked.find((state) => state.id === id))
    .filter((state): state is AchievementState => Boolean(state));
  if (picked.length) return picked.slice(0, limit);
  const weight = (state: AchievementState) => (state.rank ? 1e12 : state.category === "rank" ? 1e11 : state.threshold ?? 0);
  return [...unlocked].sort((left, right) => weight(right) - weight(left)).slice(0, limit);
}
