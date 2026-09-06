import { accentVariables } from "./accent";
import type { OgCardModel } from "./og-card";

/**
 * The drawing half of a link preview card.
 *
 * Separate from the route so that the composition can be rendered — and looked
 * at — without standing a server up, and so that the route is left holding
 * nothing but "resolve the creation, hand it to this, fall back if the runtime
 * cannot raster". Every decision about WHAT may appear was made in
 * `src/lib/og-card.ts` before this is called.
 *
 * Written for Satori rather than for a browser: every container declares
 * `display: flex`, nothing relies on inline layout or on text wrapping, and
 * both lines of copy are pre-bounded by the model.
 */

export const ogCardWidth = 1200;
export const ogCardHeight = 630;

const ink = "#f6eef4";
const muted = "#c9b6c6";
const ground = "#0b0710";

/**
 * The card, as elements.
 *
 * A single left-weighted column of copy over a cinematic crop of the artwork.
 * The scrim is the reason the composition works at every image: it is opaque
 * where the words are and clears to nothing on the right, so a dark photograph
 * and a white one both leave the title readable, and neither becomes a
 * background the wordmark disappears into.
 */
export function ogCardElement(card: OgCardModel) {
  /*
   * The product's own derived palette, not three colours invented here.
   *
   * `accentVariables` is what every tinted surface in the app already uses: it
   * tempers a violently saturated pick toward Afterglow's violet, lifts a dark
   * one until text drawn in it carries on near-black, and quietens the glow of
   * an aggressive choice. A preview card built from raw hex would be the one
   * surface in the product where a creator could pick something unreadable.
   */
  const palette = accentVariables(card.accent);
  const accent = palette["--creation-accent"];
  const label = [card.type, card.handle].filter(Boolean).join("  ·  ");
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", position: "relative",
        background: ground, color: ink,
      }}
    >
      {card.artwork
        ? <img
          src={card.artwork}
          alt=""
          width={ogCardWidth}
          height={ogCardHeight}
          // Cover, then let the scrim below decide how much of it survives.
          // 1200×630 is a wider frame than any artwork a creator uploads, so
          // this is always a crop rather than a stretch.
          // Crop toward the upper third, where the subject of a portrait
          // upload almost always is: a centred crop of a 3:4 character sheet
          // is a torso.
          style={{ position: "absolute", top: 0, left: 0, width: ogCardWidth, height: ogCardHeight, objectFit: "cover", objectPosition: "50% 32%" }}
        />
        : null}
      {/* The scrim over artwork. Two gradients — one across, one up — so the
          copy sits on near-solid ground in both directions without a hard edge
          anywhere, and the picture is still a picture on the right. */}
      <div style={{
        position: "absolute", top: 0, left: 0, width: ogCardWidth, height: ogCardHeight,
        backgroundImage: card.artwork
          ? `linear-gradient(90deg, ${ground}f5 0%, ${ground}e0 34%, ${ground}8c 58%, ${ground}1f 82%, ${ground}00 100%)`
          // Without artwork the same space carries light instead: the
          // creation's own accent, low and behind the title. The intermediate
          // stops are not decoration — a two-stop radial bands visibly once it
          // is rastered at this size.
          : `radial-gradient(circle at 14% 86%, ${palette["--creation-accent-glow-strong"]} 0%, ${palette["--creation-accent-glow"]} 30%, ${ground}00 66%)`,
      }} />
      {/* A second, quieter wash from the opposite corner, so an empty card is
          lit from two directions rather than shading off into a flat panel. */}
      {card.artwork ? null : <div style={{
        position: "absolute", top: 0, left: 0, width: ogCardWidth, height: ogCardHeight,
        backgroundImage: `radial-gradient(circle at 86% 8%, ${palette["--creation-accent-glow"]} 0%, ${ground}00 58%)`,
      }} />}
      <div style={{
        position: "absolute", top: 0, left: 0, width: ogCardWidth, height: ogCardHeight,
        backgroundImage: `linear-gradient(0deg, ${ground}e6 0%, ${ground}40 32%, ${ground}00 62%)`,
      }} />
      {/* The accent, used as an edge rather than as a colour scheme. */}
      <div style={{ position: "absolute", top: 0, left: 0, width: 10, height: ogCardHeight, background: accent, opacity: 0.9 }} />

      <div style={{
        position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between",
        width: ogCardWidth, height: ogCardHeight, padding: "58px 72px",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ width: 12, height: 12, borderRadius: 12, background: accent, marginRight: 14 }} />
            <div style={{ fontSize: 32, letterSpacing: 5, color: ink }}>Afterglow</div>
          </div>
          {card.adult
            ? <div style={{
              display: "flex", fontSize: 22, letterSpacing: 3, color: muted,
              border: `1px solid ${muted}55`, borderRadius: 999, padding: "6px 18px",
            }}>18+</div>
            : null}
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", width: "100%" }}>
          <div style={{ display: "flex", flexDirection: "column", maxWidth: card.monogram && !card.artwork ? 700 : 940 }}>
            <div style={{ display: "flex", fontSize: 24, letterSpacing: 5, color: palette["--creation-accent-readable"], marginBottom: 18 }}>
              {label.toUpperCase()}
            </div>
            <div style={{ display: "flex", fontSize: card.title.length > 34 ? 60 : 76, lineHeight: 1.05, color: ink }}>
              {card.title}
            </div>
            {card.tagline
              ? <div style={{ display: "flex", fontSize: 28, lineHeight: 1.35, color: muted, marginTop: 20 }}>{card.tagline}</div>
              : null}
          </div>
          {/* Where there is no artwork, the creation still gets something of
              its own: its initials, in its accent. A gated creation has no
              monogram — see `ogCardModel`, which will not derive one from a
              title that may not leave. */}
          {!card.artwork && card.monogram
            ? <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 168, height: 168, borderRadius: 32,
              border: `2px solid ${palette["--creation-accent-border"]}`, background: palette["--creation-accent-surface"],
              fontSize: 76, color: ink,
            }}>{card.monogram}</div>
            : null}
        </div>
      </div>
    </div>
  );
}

