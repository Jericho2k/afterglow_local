import { Sparkles } from "lucide-react";
import styles from "./profile.module.css";

/**
 * The same immediate acknowledgement a creation gets, drawn with the same
 * element the world page itself uses. See ../../characters/[id]/loading.tsx
 * for why the element and not just the shape has to match.
 */
export default function LoadingWorld() {
  return <main className={styles.state} aria-busy="true">
    <Sparkles size={26} className={styles.spin} />
    <h1>Opening world</h1>
  </main>;
}
