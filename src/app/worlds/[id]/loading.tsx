import styles from "./profile.module.css";

/** The same immediate acknowledgement a creation gets. See ../characters. */
export default function LoadingWorld() {
  return <main className={styles.state} aria-busy="true">
    <span aria-hidden className={styles.spin} style={{ fontSize: 26 }}>✦</span>
    <h1>Opening world</h1>
  </main>;
}
