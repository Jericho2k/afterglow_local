"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { api } from "@/lib/api-client";
import { backFallbacks, claimDepth, currentDepth, resolveBack, rootDepth } from "@/lib/back-navigation";
import { forgetEditorOrigin, savedEditDestination, takeEditorOrigin } from "@/lib/editor-navigation";
import { CreationStudio, type StudioWorld } from "@/components/studio";
import type { Character } from "@/lib/types";
import styles from "../profile.module.css";

/**
 * The edit route.
 *
 * This used to be a server redirect into the home shell with the creation's
 * id in a query string, which is why pressing Edit anywhere took the reader to
 * Home first and then opened the studio on top of it — and why Back from the
 * studio returned to Home rather than to the creation they were reading.
 *
 * It is now the page it claims to be. `/characters/{id}/edit` loads that one
 * creation and opens the studio on it, so the link goes where it says, the
 * URL is shareable and reloadable, and closing returns through history to
 * wherever the reader actually came from.
 *
 * Ownership is the server's decision, not this component's: the API returns
 * `owner` and anyone else is sent to the public page.
 */
export default function CreationEditor({ creationId }: { creationId: string }) {
  const router = useRouter();
  const [character, setCharacter] = useState<Character | null>(null);
  const [worlds, setWorlds] = useState<StudioWorld[]>([]);
  const [error, setError] = useState("");

  const loadWorlds = useCallback(() => {
    api<{ worlds: StudioWorld[] }>("/api/worlds").then((data) => setWorlds(data.worlds)).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ character: Character; owner: boolean }>(`/api/characters/${creationId}?scope=edit`)
      .then((detail) => {
        if (cancelled) return;
        // Editing somebody else's creation is not a thing that exists. The
        // server has already refused to send the definition; this only
        // decides where such a reader is sent instead.
        if (!detail.owner) { router.replace(`/characters/${creationId}`); return; }
        setCharacter(detail.character);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open this creation"));
    loadWorlds();
    return () => { cancelled = true; };
  }, [creationId, loadWorlds, router]);

  /** Back through history, exactly as every other Back control in the app. */
  const leave = useCallback(() => {
    // An abandoned edit must not leave a marker for the next save to read.
    forgetEditorOrigin(window.sessionStorage);
    const destination = resolveBack(currentDepth(window.history.state, window.sessionStorage), `/characters/${creationId}`);
    if (destination.type === "history") { router.back(); return; }
    claimDepth(window.sessionStorage, rootDepth);
    router.replace(destination.href);
  }, [creationId, router]);

  /**
   * Saving.
   *
   * This used to `push` the creation page, which stacked a SECOND creation
   * entry on top of the editor and made Back return into the editor — the
   * reported "edit bounce". Where the destination is already the entry
   * underneath, the save walks back to it; otherwise it replaces the editor's
   * entry. See src/lib/editor-navigation.ts for how the two are told apart.
   */
  const finish = useCallback((savedId: string) => {
    const destination = savedEditDestination(savedId, takeEditorOrigin(window.sessionStorage));
    if (destination.type === "back") { router.back(); return; }
    claimDepth(window.sessionStorage, currentDepth(window.history.state, window.sessionStorage));
    router.replace(destination.href);
  }, [router]);

  if (error) return <main className={styles.state}>
    <Sparkles size={26} /><h1>Creation unavailable</h1><p>{error}</p>
    <Link href={backFallbacks.creations}>Go to Your Creations</Link>
  </main>;
  if (!character) return <main className={styles.state}><Sparkles size={26} className={styles.spin} /><h1>Opening the studio</h1></main>;

  return <CreationStudio
    character={character}
    worlds={worlds}
    onLibrariesChanged={loadWorlds}
    onClose={leave}
    // Saving lands on the creation's own page, which is where a creator wants
    // to see what they just changed. Never a push: see `finish` above. There
    // is deliberately no just-created marker either — an edit is not a publish,
    // and Back from here returns to whatever the creator was managing from.
    onSaved={(saved) => finish(saved.id)}
    // There is no creation to return to once it is deleted, so the management
    // list replaces this entry rather than stacking on top of it.
    onDeleted={() => { forgetEditorOrigin(window.sessionStorage); claimDepth(window.sessionStorage, rootDepth); router.replace(backFallbacks.creations); }}
  />;
}
