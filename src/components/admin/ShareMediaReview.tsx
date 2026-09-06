"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, ImageOff, ShieldCheck, XCircle } from "lucide-react";
import { api } from "@/lib/api-client";
import { shareMediaStatusLabels, shareMediaStatuses, type ShareMediaStatus } from "@/lib/content-mode";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import { AppMenuButton } from "@/components/ui";
import styles from "./admin-reports.module.css";

/**
 * The share-media queue.
 *
 * A creator nominates an image for link previews; Afterglow decides whether it
 * may leave the site. The second half had no surface, so nothing was ever
 * classified and every external preview in the product fell back to the branded
 * card — for adult work, which is the point of the rule, and equally for a
 * clean romance whose creator had done everything right.
 *
 * This is the smallest thing that closes it, and it is a HUMAN queue on
 * purpose: there is no image classifier in this deployment, and the honest
 * answer to that is a reviewer rather than a trust checkbox handed to creators.
 * See docs/share-media-review-2026-09.md.
 *
 * The decision names the image, not the creation. A creator can change their
 * nomination at any moment, and the server refuses a decision about an image
 * that is no longer the one nominated — so an approval always means "somebody
 * looked at this file", never "somebody looked at this creation once".
 */

type QueueItem = {
  characterId: string;
  name: string;
  title: string;
  creator: { id: string; username: string; displayName: string };
  contentMode: string;
  status: ShareMediaStatus;
  image: { kind: string; path: string; url: string; nominated: boolean };
  updatedAt: string;
};

function imageSource(image: QueueItem["image"]) {
  return image.kind === "storage" ? avatarSource(characterAvatarBucket, image.path, "") : image.url;
}

/** The value a decision is about: the same collapse the server compares. */
function imageIdentity(image: QueueItem["image"]) {
  return image.kind === "storage" ? image.path : image.url;
}

export function ShareMediaReview({ onOpenMenu }: { onOpenMenu: () => void }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [status, setStatus] = useState<ShareMediaStatus>("unreviewed");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ queue: QueueItem[] }>(`/api/admin/share-media?status=${status}`);
      setQueue(data.queue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the queue");
    } finally { setLoading(false); }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  async function classify(item: QueueItem, decision: ShareMediaStatus) {
    setBusy(`${item.characterId}:${decision}`);
    setError("");
    try {
      await api("/api/admin/share-media", {
        method: "POST",
        body: JSON.stringify({ characterId: item.characterId, status: decision, image: imageIdentity(item.image) }),
      });
      // Decided items leave the view they were decided in.
      setQueue((current) => current.filter((entry) => entry.characterId !== item.characterId));
    } catch (reason) {
      // A 409 here means the creator re-nominated while this was open, which is
      // information rather than a failure: reloading shows the current image.
      setError(reason instanceof Error ? reason.message : "Could not record that decision");
      await load();
    } finally { setBusy(""); }
  }

  return <main className={styles.page}>
    <header>
      <AppMenuButton onOpen={onOpenMenu} />
      <div><span>Moderation</span><h1>Share images</h1></div>
      <div className={styles.filters}>
        {shareMediaStatuses.map((item) => <button key={item} data-active={status === item} onClick={() => setStatus(item)}>{item}</button>)}
      </div>
    </header>
    {error && <p className={styles.error} role="alert">{error}<button onClick={() => void load()}>Retry</button></p>}
    <div className={styles.layout}>
      <section className={styles.detail}>
        {loading
          ? <p>Loading the queue…</p>
          : !queue.length
            ? <div className={styles.empty}><CheckCircle2 /><strong>Queue clear</strong><span>Nothing public is waiting in “{shareMediaStatusLabels[status].toLowerCase()}”.</span></div>
            : <div className={styles.reports}>
              {queue.map((item) => {
                const source = imageSource(item.image);
                return <article key={item.characterId}>
                  <div>
                    <strong>{item.title || item.name || "Untitled creation"}</strong>
                    <span>{item.contentMode.replace("_", "-")} · {new Date(item.updatedAt).toLocaleDateString()}</span>
                  </div>
                  {/* The picture is the decision, so it is shown at a size a
                      person can actually judge rather than as a thumbnail. */}
                  <p>
                    {source
                      ? <img src={source} alt="" style={{ maxWidth: "min(420px, 100%)", borderRadius: 12, display: "block" }} />
                      : <span><ImageOff size={14} aria-hidden /> The nominated image could not be resolved.</span>}
                  </p>
                  <p>
                    {item.image.nominated
                      ? "Nominated for sharing by the creator."
                      : "No dedicated share image; this is the creation’s cover, which is what a preview would use."}
                  </p>
                  <div className={styles.actions}>
                    <button disabled={Boolean(busy)} onClick={() => void classify(item, "safe")}>
                      <ShieldCheck size={14} />Safe for previews
                    </button>
                    <button disabled={Boolean(busy)} onClick={() => void classify(item, "adult")}>
                      <XCircle size={14} />Adult — keep off previews
                    </button>
                    <button className={styles.danger} disabled={Boolean(busy)} onClick={() => void classify(item, "rejected")}>
                      <XCircle size={14} />Reject
                    </button>
                    {status !== "unreviewed" && <button disabled={Boolean(busy)} onClick={() => void classify(item, "unreviewed")}>
                      Send back to unreviewed
                    </button>}
                  </div>
                  <small>
                    {item.creator.username
                      ? <Link href={`/creators/${encodeURIComponent(item.creator.username)}`}>@{item.creator.username}</Link>
                      : item.creator.displayName}
                    {" · "}
                    <Link href={`/characters/${item.characterId}`}><ExternalLink size={12} /> Open creation</Link>
                  </small>
                </article>;
              })}
            </div>}
      </section>
    </div>
  </main>;
}
