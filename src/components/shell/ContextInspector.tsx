"use client";

import { useEffect, useState } from "react";
import { BookMarked, BrainCircuit, Clock, MessagesSquare, ScrollText } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Message } from "@/lib/types";
import { Sheet } from "./Sheet";
import styles from "./shell.module.css";

/**
 * What story context Afterglow used for one reply.
 *
 * This is a STORY inspector, not a prompt dump, and the distinction decides
 * what is in it. A reader wants to know why the character behaved as it did:
 * how far back it could see, which durable facts it was handed, what it holds
 * as permanent, where it thought everyone was. It does not answer — and must
 * never answer — what the system prompt says, what the creator wrote in a
 * private definition, which model wrote the reply, or what a response directive
 * belonging to somebody else's creation contains. The server enforces that; see
 * src/app/api/messages/[id]/recall/route.ts.
 *
 * Every figure comes from provenance recorded WITH the reply rather than
 * measured now, because a memory can be edited, canon re-curated and the
 * summary overwritten between the reply and this panel being opened. The one
 * thing deliberately not shown is the rolling summary's TEXT: there is one
 * summary row per story and it is rewritten on every consolidation, so the text
 * available now is not the text this reply read. Its presence and size are
 * true; its content would be a confident, wrong answer.
 */

/**
 * How an item stands relative to what the writer was actually handed.
 *
 * These four are the only honest answers, and "not recorded" is one of them: a
 * reply written before per-generation provenance existed cannot have its
 * context reconstructed, and showing today's text as though it were history is
 * the failure this panel exists to avoid.
 */
type HistoricalState = "as_supplied" | "edited_since" | "removed_since" | "not_recorded";

type ContextItem =
  | { kind: "memory"; id: string; available: true; content: string; memoryKind: string; status: string; importance: number; resolution: string; origin: string; scope: "chat" | "creation"; historicalState?: HistoricalState }
  | { kind: "arc"; id: string; available: true; summary: string; startMessageCount: number; endMessageCount: number }
  | { kind: "canon"; id: string; available: true; content: string; category: string; importance: number; status: string }
  | { kind: "memory" | "arc" | "canon"; id: string; available: false; historicalState?: HistoricalState };

type TranscriptTurn = { id: string; role: string; content: string; historicalState: HistoricalState };

type SceneFields = {
  storyDay?: number | null;
  timeOfDay?: string;
  dateText?: string;
  location?: { place: string; sub: string };
  presentCharacters?: string[];
};

type ContextDetail = {
  items: ContextItem[];
  transcript: { recorded: boolean; messages?: number; firstMessageId?: string | null; estimatedTokens?: number; trimmedToFit?: number; turns?: TranscriptTurn[] };
  variantIndex?: number;
  variants?: number;
  provenanceRecorded?: boolean;
  scene: { available: boolean; fields?: SceneFields };
  summary: { recorded: boolean; used?: boolean; characters?: number };
  counts: { memories: number; arcs: number; canon: number; unavailable: number; total: number };
  diagnostics?: unknown[];
};

/** The unobtrusive label on the reply itself. */
export function contextActionLabel(message: Message) {
  const total = message.memoryIds.length + message.arcIds.length;
  return total ? `Context · ${total}` : "Context";
}

function sceneLine(fields?: SceneFields) {
  if (!fields) return "";
  const place = [fields.location?.place, fields.location?.sub].filter(Boolean).join(" · ");
  const when = [fields.dateText, fields.timeOfDay].filter(Boolean).join(", ");
  const day = typeof fields.storyDay === "number" ? `Day ${fields.storyDay}` : "";
  return [day, when, place].filter(Boolean).join(" — ");
}

/** The one-word note beside an item whose state has moved on. */
function stateNote(state?: HistoricalState) {
  if (state === "edited_since") return "edited since — shown as it was";
  if (state === "removed_since") return "removed since";
  if (state === "not_recorded") return "version not recorded";
  return "";
}

export function ContextInspector({ message, onClose }: { message: Message; onClose: () => void }) {
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [failed, setFailed] = useState(false);

  /*
   * Asked about the variant on screen, not about the message.
   *
   * Regenerate keeps every attempt as a variant of one row, so "what did this
   * reply read" is a question about a GENERATION. Without the variant the
   * server would answer for whichever attempt is selected, which is right only
   * by coincidence when the reader is looking at an older option.
   */
  const variant = message.selectedVariant;

  useEffect(() => {
    let live = true;
    api<ContextDetail>(`/api/messages/${message.id}/recall?variant=${variant}`)
      .then((data) => { if (live) setDetail(data); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [message.id, variant]);

  /*
   * Narrowed by hand because the "no longer available" variant deliberately
   * shares the same `kind` values: an item that has since been edited away is
   * still listed under the section it was used in, so the count and the rows
   * can never disagree.
   */
  const of = <K extends ContextItem["kind"]>(kind: K) =>
    (detail?.items ?? []).filter((item): item is Extract<ContextItem, { kind: K }> => item.kind === kind);
  const memories = of("memory");
  const arcs = of("arc");
  const canon = of("canon");
  const scene = detail?.scene.available ? sceneLine(detail.scene.fields) : "";

  return <Sheet size="full" eyebrow="This reply" title="What she was working from" onClose={onClose}>
    {!detail && !failed && <p className={styles.fieldHint} aria-live="polite">Reading this reply&apos;s context…</p>}
    {failed && <p className={styles.error} role="alert">This reply&apos;s context could not be read. Nothing has been lost — close and reopen to try again.</p>}

    {detail && <>
      <p className={styles.memoryIntro}>
        <BrainCircuit size={15} aria-hidden />
        Every reply is written from the creation&apos;s own profile plus the story context below. This is what was carried into this one.
      </p>

      {detail.provenanceRecorded === false && <p className={styles.fieldHint}>
        Provenance was not recorded for this variant. It was written before Afterglow kept a per-reply record, so the sections below show only what the reply itself stored — nothing here has been reconstructed after the fact.
      </p>}

      {(detail.variants ?? 1) > 1 && <p className={styles.fieldHint}>
        This is option {(detail.variantIndex ?? 0) + 1} of {detail.variants}. Each option was written from its own context; switch options to see theirs.
      </p>}

      <section className={styles.memoryDerived}>
        <h3><MessagesSquare size={14} aria-hidden /> Recent conversation</h3>
        {detail.transcript.recorded
          ? <p className={styles.fieldHint}>
            {detail.transcript.messages} {detail.transcript.messages === 1 ? "message" : "messages"} of this story were visible, about {(detail.transcript.estimatedTokens ?? 0).toLocaleString()} tokens.
            {detail.transcript.trimmedToFit ? ` ${detail.transcript.trimmedToFit} older ${detail.transcript.trimmedToFit === 1 ? "message was" : "messages were"} left out to fit the writer's context.` : ""}
          </p>
          : <p className={styles.fieldHint}>This reply predates context recording, so how much transcript it saw was never written down.</p>}
        {detail.transcript.turns?.length ? <ul className={styles.contextTurns}>
          {detail.transcript.turns.map((turn) => <li key={turn.id} data-state={turn.historicalState}>
            <b>{turn.role === "user" ? "You" : "Reply"}</b>
            <span>{turn.content.length > 220 ? `${turn.content.slice(0, 220).trimEnd()}…` : turn.content}</span>
            {stateNote(turn.historicalState) && <em>{stateNote(turn.historicalState)}</em>}
          </li>)}
        </ul> : null}
      </section>

      {detail.summary.recorded && <section className={styles.memoryDerived}>
        <h3><ScrollText size={14} aria-hidden /> Story so far</h3>
        <p className={styles.fieldHint}>
          {detail.summary.used
            ? `A rolling summary of about ${Math.round((detail.summary.characters ?? 0) / 5).toLocaleString()} words was included. It is rewritten as the story advances, so the version you can read today is not word-for-word the one this reply saw; open Memories for the current text.`
            : "No rolling summary existed yet at this point in the story."}
        </p>
      </section>}

      {scene && <section className={styles.memoryDerived}>
        <h3><Clock size={14} aria-hidden /> Where and when</h3>
        <p className={styles.memoryText}>{scene}</p>
        {detail.scene.fields?.presentCharacters?.length ? <p className={styles.fieldHint}>Present: {detail.scene.fields.presentCharacters.join(", ")}</p> : null}
      </section>}

      {canon.length > 0 && <section className={styles.memoryDerived}>
        <h3><BookMarked size={14} aria-hidden /> Core canon</h3>
        <ul>{canon.map((item) => <li key={item.id}>
          {item.available ? <><b>{item.category.replace("_", " ")}</b>{item.content}</> : <>This canon entry has since been re-curated. It is listed so the count always matches what was used.</>}
        </li>)}</ul>
      </section>}

      <section className={styles.memoryDerived}>
        <h3><BrainCircuit size={14} aria-hidden /> Memories recalled</h3>
        {memories.length === 0
          ? <p className={styles.fieldHint}>Nothing was drawn from the permanent archive for this reply — the recent conversation carried it.</p>
          : <ul>{memories.map((item) => <li key={item.id}>
            {item.available
              ? <><b>{item.memoryKind.replace("_", " ")}</b>{item.content}{item.resolution ? ` (Resolved: ${item.resolution})` : ""}{stateNote(item.historicalState) && <em className={styles.contextStateNote}>{stateNote(item.historicalState)}</em>}</>
              : <>This memory was recalled for the reply and its text is no longer stored. It is listed so the count always matches what was used.</>}
          </li>)}</ul>}
      </section>

      {arcs.length > 0 && <section className={styles.memoryDerived}>
        <h3><ScrollText size={14} aria-hidden /> Chapters recalled</h3>
        <ul>{arcs.map((item) => <li key={item.id}>
          {item.available ? <><b>{item.startMessageCount}–{item.endMessageCount}</b>{item.summary}</> : <>This chapter is no longer in the archive.</>}
        </li>)}</ul>
      </section>}

      {/* Administrator-only. Ranking internals answer a question about the
          machine, and are only present when the server chose to send them. */}
      {detail.diagnostics?.length ? <section className={styles.memoryDerived}>
        <h3>Retrieval diagnostics</h3>
        <pre className={styles.diagnosticBlock}>{JSON.stringify(detail.diagnostics[0], null, 2)}</pre>
      </section> : null}
    </>}
  </Sheet>;
}
