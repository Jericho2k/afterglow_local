/**
 * Creation accent colour.
 *
 * The studio has always let creators pick one and the product has never shown
 * it: it reached two rules on the creation page, both of which only render
 * when there is no cover art. A setting with no visible effect is worse than
 * no setting, so this makes it real — carefully.
 *
 * Two rules govern how far it goes.
 *
 * It is a seed, not a theme. The accent tints edges, glows and one gradient
 * endpoint; it never becomes body text, a page background or a whole button.
 * A creation is personalised by it, not repainted in it, and the product still
 * obviously looks like Afterglow at every value.
 *
 * It cannot make anything unreadable. Every derived value is a blend rather
 * than the raw colour, and the one variant text is ever drawn in is lifted
 * toward white until it carries against a near-black surface. A creator who
 * picks near-black or a blinding yellow gets a creation that still works.
 *
 * Only the chosen colour is stored. Everything below is derived at render
 * time, so improving the palette later does not mean migrating rows.
 */

/** The product's own accent, used for anything without a valid colour of its own. */
export const defaultAccent = "#e879a9";

/**
 * A colour the product will actually render.
 *
 * Six-digit or three-digit hex and nothing else. This is the boundary that
 * keeps a stored value out of CSS as anything but a colour: `url(...)`,
 * `var(--x)`, `calc(...)`, a semicolon and a second declaration, or any other
 * attempt to write CSS through this field fails the pattern and becomes the
 * default.
 */
export function normalizeAccent(value: string | null | undefined): string {
  if (typeof value !== "string") return defaultAccent;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
  }
  return defaultAccent;
}

function channels(hex: string) {
  const value = normalizeAccent(hex);
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ] as const;
}

function toHex([r, g, b]: readonly [number, number, number]) {
  const clamp = (channel: number) => Math.max(0, Math.min(255, Math.round(channel)));
  return `#${[r, g, b].map((channel) => clamp(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** Perceived brightness, 0 to 1. The weights are the usual luminance ones. */
export function accentLuminance(hex: string) {
  const [r, g, b] = channels(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function mix(hex: string, towards: readonly [number, number, number], amount: number) {
  const [r, g, b] = channels(hex);
  return toHex([
    r + (towards[0] - r) * amount,
    g + (towards[1] - g) * amount,
    b + (towards[2] - b) * amount,
  ]);
}

const white = [255, 255, 255] as const;

/**
 * The variant safe to draw text and icons in on a near-black surface.
 *
 * A dark accent is lifted toward white until it carries; a colour that is
 * already bright is left alone. The threshold is deliberately generous — this
 * is the only derived value used for anything a reader has to read, so it errs
 * toward legible rather than toward faithful.
 */
export function readableAccent(hex: string) {
  const accent = normalizeAccent(hex);
  const luminance = accentLuminance(accent);
  if (luminance >= 0.5) return accent;
  // Lift proportionally: barely-dark colours barely move, near-black ones
  // move most of the way.
  return mix(accent, white, Math.min(0.82, (0.5 - luminance) * 1.5));
}

export type AccentVariables = {
  "--creation-accent": string;
  "--creation-accent-readable": string;
  "--creation-accent-soft": string;
  "--creation-accent-border": string;
  "--creation-accent-glow": string;
};

/**
 * The custom properties a surface tinted by a creation sets.
 *
 * Returned as a plain object so it can be spread into a `style` prop; every
 * value is a hex colour or an rgba() built from validated channels, so nothing
 * a creator typed reaches CSS as syntax.
 */
export function accentVariables(hex: string | null | undefined): AccentVariables {
  const accent = normalizeAccent(hex);
  const [r, g, b] = channels(accent);
  return {
    "--creation-accent": accent,
    "--creation-accent-readable": readableAccent(accent),
    // Blended toward the product's own violet-pink surface tone, which is what
    // keeps an arbitrary hue looking like Afterglow rather than like a theme.
    "--creation-accent-soft": mix(accent, [184, 146, 240], 0.42),
    "--creation-accent-border": `rgba(${r}, ${g}, ${b}, 0.34)`,
    "--creation-accent-glow": `rgba(${r}, ${g}, ${b}, 0.22)`,
  };
}

/** True when a creation carries an accent the creator actually chose. */
export function hasCustomAccent(hex: string | null | undefined) {
  return normalizeAccent(hex) !== defaultAccent;
}
