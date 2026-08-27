import { Sparkles } from "lucide-react";
import styles from "./profile.module.css";

/**
 * The same acknowledgement the page itself shows a moment later, drawn with
 * the same element — see ../../characters/[id]/loading.tsx for why the element
 * and not merely the shape has to match.
 */
export default function LoadingCreator() {
  return <main className={styles.state} aria-busy="true">
    <Sparkles size={26} className={styles.spin} />
    <h1>Opening profile</h1>
  </main>;
}
