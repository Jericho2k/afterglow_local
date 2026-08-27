import { Sparkles } from "lucide-react";
import styles from "./profile.module.css";

/**
 * What a tap on a creation shows before its page exists.
 *
 * Navigation has to acknowledge itself. Without this the router held the
 * previous screen until the route's payload arrived, so pressing a card looked
 * like nothing had happened — the "dead click" in an earlier sprint report.
 *
 * It must be the SAME acknowledgement the page itself shows a moment later,
 * and for one release it was not. This file drew the sparkle as a bare text
 * glyph while the page drew it with lucide's `Sparkles`, and `.state` tints
 * only `svg` — so the glyph inherited near-white body text and the icon was
 * Afterglow's pink. The reader saw a white sparkle become a pink one, which is
 * the "white sparkle flash" in this sprint's report. Rendering the identical
 * element here means the first visible frame is already the intended one and
 * nothing changes when the page mounts.
 */
export default function LoadingCreation() {
  return <main className={styles.state} aria-busy="true">
    <Sparkles size={26} className={styles.spin} />
    <h1>Opening creation</h1>
  </main>;
}
