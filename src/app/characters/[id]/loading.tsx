import styles from "./profile.module.css";

/**
 * What a tap on a creation shows before its page exists.
 *
 * Navigation has to acknowledge itself. Without this the router held the
 * previous screen until the route's payload arrived, so pressing a card looked
 * like nothing had happened — the "dead click" in the sprint report. The page
 * itself has an identical state for the moment after it mounts and before its
 * data lands, so the reader sees one continuous "opening" rather than a flash
 * between two different waits.
 */
export default function LoadingCreation() {
  return <main className={styles.state} aria-busy="true">
    <span aria-hidden className={styles.spin} style={{ fontSize: 26 }}>✦</span>
    <h1>Opening creation</h1>
  </main>;
}
