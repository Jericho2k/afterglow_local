/**
 * Public count formatting.
 *
 * One formatter for every surface. A feed card, the creation page and any
 * future list all shorten the same way, so "12.5K" never appears next to
 * "12,483" for the same number. The locale is fixed rather than taken from the
 * browser because these strings sit inside a fixed-width card: a locale that
 * renders "12,5 K" would wrap where "12.5K" does not.
 */
const compactFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function compactCount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "0";
  return compactFormatter.format(Math.max(0, Math.round(value)));
}

/** The same number spelled out, for tooltips and assistive labels. */
export function exactCount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en").format(Math.max(0, Math.round(value)));
}
