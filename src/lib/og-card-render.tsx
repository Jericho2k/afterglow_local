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
/*
 * The tagline over a photograph.
 *
 * `muted` is the right weight on the branded composition, where it sits on a
 * known near-black. Over artwork it is the first thing a bright crop erases —
 * it is the smallest type on the card and the lowest contrast — so the same
 * line is drawn a step brighter there. Not `ink`: the hierarchy between title
 * and tagline is the reason the card reads at a glance.
 */
const quiet = "#e8dae4";
const ground = "#0b0710";

/**
 * The creator's picture, sized to survive the downscale.
 *
 * Chat clients paint this card at roughly a third of its size, so anything
 * smaller than this stops being a face and becomes a coloured dot.
 */
const avatarSize = 132;

/**
 * The card, as elements.
 *
 * A single left-weighted column of copy over a cinematic crop of the artwork,
 * with the creator's face in the opposite corner. The scrim is the reason the
 * composition works at every image: it is dense where the words are and clears
 * to nothing on the right, so a dark photograph and a white one both leave the
 * title readable, and neither becomes a background the wordmark disappears
 * into — while the picture is still recognisably a picture, which is the whole
 * point of putting it there.
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
  /*
   * A halo under the copy, only where there is a photograph to lose it against.
   *
   * The alternative was a heavier scrim, and that is the wrong trade now that
   * artwork is the ordinary case rather than the rare one: a gradient dense
   * enough for a white photograph flattens every dark one into the branded
   * panel this card exists to stop being. A shadow costs the picture almost
   * nothing and holds the tagline — the smallest, faintest line, and the first
   * to disappear — over a bright crop.
   */
  const shadow = card.artwork ? `0 2px 20px ${ground}f0, 0 1px 3px ${ground}c0` : "none";
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
          // this is always a crop rather than a stretch — and WHERE it crops is
          // the creator's own focal point wherever they set one. See
          // `artworkPosition` in the model: a universal constant here was the
          // studio's framing control failing on the one surface strangers see.
          style={{ position: "absolute", top: 0, left: 0, width: ogCardWidth, height: ogCardHeight, objectFit: "cover", objectPosition: card.artworkPosition }}
        />
        : null}
      {/* The scrim over artwork. Two gradients — one across, one up — so the
          copy sits on near-solid ground in both directions without a hard edge
          anywhere, and the picture is still a picture on the right.

          Tuned lighter than the version that shipped, because the situation
          changed under it: artwork used to be the rare case, so the scrim was
          built to make an unusual card safe. It is now the ordinary case, and a
          gradient dense enough to guarantee readability over a white photograph
          also erased every dark one — which is the "generic Afterglow business
          card" failure. It clears to nothing by two thirds across, and the
          left-hand stops stay opaque enough to carry text over anything. */}
      <div style={{
        position: "absolute", top: 0, left: 0, width: ogCardWidth, height: ogCardHeight,
        backgroundImage: card.artwork
          ? `linear-gradient(90deg, ${ground}f2 0%, ${ground}d8 30%, ${ground}96 52%, ${ground}3d 72%, ${ground}00 90%)`
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
      {/* The upward wash, which the copy block sits in. Softer over artwork than
          over the empty composition: there it is the only thing separating the
          tagline from a photograph, here it is the second layer over one. */}
      <div style={{
        position: "absolute", top: 0, left: 0, width: ogCardWidth, height: ogCardHeight,
        backgroundImage: card.artwork
          ? `linear-gradient(0deg, ${ground}d9 0%, ${ground}52 26%, ${ground}00 56%)`
          : `linear-gradient(0deg, ${ground}e6 0%, ${ground}40 32%, ${ground}00 62%)`,
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
          {/* The copy column narrows only when something is actually beside it,
              so a card with no avatar uses the full width rather than leaving a
              hole where one would have been. */}
          <div style={{ display: "flex", flexDirection: "column", maxWidth: card.creatorAvatar ? 840 : 940 }}>
            <div style={{ display: "flex", fontSize: 24, letterSpacing: 5, color: palette["--creation-accent-readable"], marginBottom: 18, textShadow: shadow }}>
              {label.toUpperCase()}
            </div>
            <div style={{ display: "flex", fontSize: card.title.length > 34 ? 60 : 76, lineHeight: 1.05, color: ink, textShadow: shadow }}>
              {card.title}
            </div>
            {card.tagline
              ? <div style={{ display: "flex", fontSize: 28, lineHeight: 1.35, color: card.artwork ? quiet : muted, marginTop: 20, textShadow: shadow }}>{card.tagline}</div>
              : null}
          </div>
          {/*
            * The creator, as a face rather than as a letter.
            *
            * This corner used to hold a large box containing the first letter
            * of the creation's title, which told a reader nothing they could
            * not already read six inches to the left — and which a gated
            * creation could not have at all, because its title may not leave.
            * A creator's profile picture is public in every mode, identifies
            * the person rather than the content, and is the same picture their
            * profile page and every creation page already show.
            *
            * A creator with no picture gets NOTHING here. The letter is not a
            * fallback to return to; the composition simply reads as one column
            * of copy, which it does well.
            *
            * The ring is drawn as a separate padded frame rather than as a
            * border on the image, because Satori applies `border-radius` to an
            * `img` and its border independently and the two edges do not meet
            * cleanly at this size.
            */}
          {card.creatorAvatar
            ? <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: avatarSize + 16, height: avatarSize + 16, borderRadius: 999,
              border: `2px solid ${palette["--creation-accent-border"]}`,
              background: palette["--creation-accent-surface"],
              // Lifted off the baseline so the ring sits with the title rather
              // than with the descenders of the tagline below it.
              marginBottom: 6, marginLeft: 40,
            }}>
              <img
                src={card.creatorAvatar}
                alt=""
                width={avatarSize}
                height={avatarSize}
                style={{ width: avatarSize, height: avatarSize, borderRadius: 999, objectFit: "cover" }}
              />
            </div>
            : null}
        </div>
      </div>
    </div>
  );
}
