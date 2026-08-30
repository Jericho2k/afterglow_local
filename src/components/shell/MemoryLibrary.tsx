"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BrainCircuit, Check, Pencil, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { CoreCanonEntry, Memory, MemoryArc, MemoryKind } from "@/lib/types";
import { SelectField, uiStyles, type SelectOption } from "@/components/ui";
import { Sheet } from "./Sheet";
import styles from "./shell.module.css";

/**
 * Everything this story remembers, and the controls to correct it.
 *
 * This surface used to be an administrator's panel behind a feature flag, which
 * meant the person whose story it is — the only person who knows whether a
 * remembered fact is TRUE — could neither read it nor fix it. "She forgot our
 * anniversary" and "she thinks we live in Prague" are the two most common
 * complaints about any memory system, and both were unanswerable.
 *
 * Two decisions worth stating.
 *
 * ATOMS ARE EDITABLE; DERIVED LAYERS ARE NOT. Historical arcs, Core Canon and
 * the rolling summary are rebuilt from the atomic memories on a cadence, so an
 * edit to one of them would be quietly discarded the next time curation ran.
 * Offering a control that undoes itself is worse than not offering it, so they
 * are shown — a reader should see what the story believes — and marked as
 * derived. Editing the atoms is the edit that lasts.
 *
 * REMOVAL IS SUPERSESSION. The server keeps the row and stops retrieving it, so
 * a reply that recalled the memory can still say what it recalled. The reader
 * is told that, rather than being promised a deletion that would take the
 * history of their own story with it.
 */

const memoryKinds: SelectOption[] = [
  { value: "identity", label: "Identity" },
  { value: "relationship", label: "Relationship" },
  { value: "event", label: "Event" },
  { value: "promise", label: "Promise" },
  { value: "preference", label: "Preference" },
  { value: "boundary", label: "Boundary" },
  { value: "open_loop", label: "Open loop" },
];

const statusOptions: SelectOption[] = [
  { value: "active", label: "Still open" },
  { value: "resolved", label: "Resolved" },
];

type MemoryPayload = {
  memories: Memory[];
  arcs: MemoryArc[];
  coreCanon: CoreCanonEntry[];
  summary: string;
  editable: { memories: boolean; arcs: boolean; coreCanon: boolean; summary: boolean };
};

type Draft = Pick<Memory, "content" | "kind" | "importance" | "keywords" | "pinned" | "status" | "resolution">;

function draftOf(memory: Memory): Draft {
  return {
    content: memory.content, kind: memory.kind, importance: memory.importance,
    keywords: memory.keywords, pinned: memory.pinned, status: memory.status, resolution: memory.resolution,
  };
}

function kindLabel(kind: MemoryKind) {
  return memoryKinds.find((option) => option.value === kind)?.label ?? kind.replace("_", " ");
}

export function MemoryLibrary({ characterId, characterName, conversationId, diagnostics, onClose, onChanged }: {
  characterId: string;
  characterName: string;
  conversationId: string | null;
  /** Administrator-only panels. Absent for an ordinary reader. */
  diagnostics?: ReactNode;
  onClose: () => void;
  onChanged?: (memories: Memory[]) => void;
}) {
  const [payload, setPayload] = useState<MemoryPayload | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("event");
  const [newScope, setNewScope] = useState<"chat" | "creation">("chat");
  const [newKeywords, setNewKeywords] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const url = useCallback((removed: boolean) => {
    const params = new URLSearchParams({ characterId });
    if (conversationId) params.set("conversationId", conversationId);
    if (removed) params.set("includeRemoved", "1");
    return `/api/memories?${params}`;
  }, [characterId, conversationId]);

  const load = useCallback(async (removed: boolean) => {
    try {
      const data = await api<MemoryPayload>(url(removed));
      setPayload(data);
      setError("");
      onChanged?.(data.memories);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Those memories could not be read");
    }
  }, [url, onChanged]);

  useEffect(() => { void load(showRemoved); }, [load, showRemoved]);

  async function save(memory: Memory, changes: Partial<Draft>) {
    setBusyId(memory.id);
    try {
      await api(`/api/memories?id=${memory.id}`, { method: "PATCH", body: JSON.stringify({ ...draftOf(memory), ...changes }) });
      setEditingId(null); setDraft(null);
      await load(showRemoved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That change could not be saved");
    } finally { setBusyId(null); }
  }

  async function remove(memory: Memory) {
    setBusyId(memory.id);
    try {
      await api(`/api/memories?id=${memory.id}`, { method: "DELETE" });
      setConfirmingId(null);
      await load(showRemoved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That memory could not be removed");
    } finally { setBusyId(null); }
  }

  async function add() {
    if (!newContent.trim()) return;
    setBusyId("new");
    try {
      await api("/api/memories", {
        method: "POST",
        body: JSON.stringify({
          characterId,
          conversationId: newScope === "chat" ? conversationId : null,
          content: newContent.trim(),
          kind: newKind,
          importance: 4,
          keywords: newKeywords.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 12),
          pinned: true,
        }),
      });
      setNewContent(""); setNewKeywords(""); setAdding(false);
      await load(showRemoved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That memory could not be added");
    } finally { setBusyId(null); }
  }

  const memories = payload?.memories ?? [];
  const active = memories.filter((memory) => memory.status !== "superseded");

  return <Sheet
    size="full"
    eyebrow="What this story remembers"
    title={`${characterName}'s memories`}
    onClose={onClose}
    footer={<>
      <span className={styles.fieldHint}>{active.length} {active.length === 1 ? "memory" : "memories"}{payload?.arcs.length ? ` · ${payload.arcs.length} arcs` : ""}</span>
      <button type="button" className={`${uiStyles.button} ${uiStyles.primary}`} onClick={() => setAdding((value) => !value)}>
        <Plus size={15} aria-hidden />{adding ? "Cancel" : "Add a memory"}
      </button>
    </>}
  >
    {error && <p className={styles.error} role="alert">{error}</p>}

    <p className={styles.memoryIntro}>
      <BrainCircuit size={15} aria-hidden />
      These are the durable facts Afterglow carries into future replies. Correct anything that is wrong — your edits change what gets recalled from now on, and never rewrite a reply that has already been written.
    </p>

    {adding && <form
      className={styles.memoryEditor}
      onSubmit={(event) => { event.preventDefault(); void add(); }}
    >
      <label className={styles.fieldLabel} htmlFor="new-memory">Something to remember</label>
      <textarea
        id="new-memory" className={styles.memoryTextarea} rows={3}
        value={newContent} onChange={(event) => setNewContent(event.target.value)}
        placeholder="A fact, a promise, a preference, a boundary…"
      />
      <div className={styles.memoryEditorRow}>
        <SelectField label="Kind" value={newKind} options={memoryKinds} onChange={(value) => setNewKind(value as MemoryKind)} compact />
        <SelectField
          label="Use in" value={newScope} compact
          options={[{ value: "chat", label: "This story only" }, { value: "creation", label: "Every story with them" }]}
          onChange={(value) => setNewScope(value as "chat" | "creation")}
        />
      </div>
      <input
        className={styles.input} value={newKeywords} onChange={(event) => setNewKeywords(event.target.value)}
        placeholder="Recall keywords, comma separated (optional)" aria-label="Recall keywords"
      />
      <div className={styles.memoryEditorActions}>
        <button type="button" className={`${uiStyles.button} ${uiStyles.secondary}`} onClick={() => setAdding(false)}>Cancel</button>
        <button type="submit" className={`${uiStyles.button} ${uiStyles.primary}`} disabled={busyId === "new" || !newContent.trim()}>
          {busyId === "new" ? "Adding…" : "Add"}
        </button>
      </div>
    </form>}

    {diagnostics}

    {payload?.coreCanon.length ? <section className={styles.memoryDerived}>
      <h3>Core canon</h3>
      <p className={styles.fieldHint}>The handful of facts this story cannot afford to forget. Curated from the memories below, so it updates when they do.</p>
      <ul>{payload.coreCanon.map((entry) => <li key={entry.id}><b>{entry.category.replace("_", " ")}</b>{entry.content}</li>)}</ul>
    </section> : null}

    {payload?.summary ? <section className={styles.memoryDerived}>
      <h3>Story so far</h3>
      <p className={styles.fieldHint}>The current rolling summary. Rewritten as the story advances.</p>
      <p className={styles.memorySummary}>{payload.summary}</p>
    </section> : null}

    <div className={styles.memoryListHead}>
      <h3>Memories</h3>
      <label className={styles.memoryToggle}>
        <input type="checkbox" checked={showRemoved} onChange={(event) => setShowRemoved(event.target.checked)} />
        Show removed
      </label>
    </div>

    {payload && !memories.length && <p className={styles.fieldHint}>Nothing yet. Memories are written as the story goes; you can also add one yourself.</p>}

    <ul className={styles.memoryList}>
      {memories.map((memory) => {
        const editing = editingId === memory.id;
        const removed = memory.status === "superseded";
        return <li key={memory.id} className={removed ? `${styles.memoryItem} ${styles.memoryItemRemoved}` : styles.memoryItem}>
          <div className={styles.memoryMeta}>
            <span>{kindLabel(memory.kind)}</span>
            {memory.pinned && <span className={styles.memoryPinned}><Pin size={11} aria-hidden />Pinned</span>}
            {memory.status === "resolved" && <span>Resolved</span>}
            {removed && <span>Removed</span>}
            <span>{memory.conversationId ? "This story" : "Every story"}</span>
            {memory.origin === "user" && <span>You wrote this</span>}
          </div>

          {editing && draft ? <>
            <textarea
              className={styles.memoryTextarea} rows={4} autoFocus
              value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              aria-label="Memory text"
            />
            <div className={styles.memoryEditorRow}>
              <SelectField label="Kind" value={draft.kind} options={memoryKinds} onChange={(value) => setDraft({ ...draft, kind: value as MemoryKind })} compact />
              {(draft.kind === "promise" || draft.kind === "open_loop") && <SelectField
                label="Status" value={draft.status === "superseded" ? "active" : draft.status} options={statusOptions} compact
                onChange={(value) => setDraft({ ...draft, status: value as Memory["status"], resolution: value === "active" ? "" : draft.resolution })}
              />}
            </div>
            <div className={styles.memoryEditorActions}>
              <button type="button" className={`${uiStyles.button} ${uiStyles.secondary}`} onClick={() => { setEditingId(null); setDraft(null); }}>Cancel</button>
              <button
                type="button" className={`${uiStyles.button} ${uiStyles.primary}`}
                disabled={busyId === memory.id || !draft.content.trim()}
                onClick={() => void save(memory, draft)}
              ><Check size={15} aria-hidden />{busyId === memory.id ? "Saving…" : "Save"}</button>
            </div>
          </> : <>
            <p className={styles.memoryText}>{memory.content}</p>
            {memory.resolution && <p className={styles.fieldHint}>Resolved: {memory.resolution}</p>}
            {memory.keywords.length > 0 && <p className={styles.memoryKeywords}>{memory.keywords.map((keyword) => `#${keyword}`).join("  ")}</p>}
            {!removed && <div className={styles.memoryActions}>
              <button type="button" onClick={() => { setEditingId(memory.id); setDraft(draftOf(memory)); }}>
                <Pencil size={13} aria-hidden />Edit
              </button>
              <button type="button" disabled={busyId === memory.id} onClick={() => void save(memory, { pinned: !memory.pinned })}>
                {memory.pinned ? <><PinOff size={13} aria-hidden />Unpin</> : <><Pin size={13} aria-hidden />Pin</>}
              </button>
              {confirmingId === memory.id ? <>
                <button type="button" className={styles.memoryDanger} disabled={busyId === memory.id} onClick={() => void remove(memory)}>
                  <Trash2 size={13} aria-hidden />{busyId === memory.id ? "Removing…" : "Yes, remove"}
                </button>
                <button type="button" onClick={() => setConfirmingId(null)}><X size={13} aria-hidden />Keep</button>
              </> : <button type="button" className={styles.memoryDanger} onClick={() => setConfirmingId(memory.id)}>
                <Trash2 size={13} aria-hidden />Remove
              </button>}
            </div>}
            {confirmingId === memory.id && <p className={styles.fieldHint}>
              She stops recalling this from now on. Replies that already used it keep saying so.
            </p>}
          </>}
        </li>;
      })}
    </ul>

    {payload?.arcs.length ? <section className={styles.memoryDerived}>
      <h3>Chapters</h3>
      <p className={styles.fieldHint}>Longer stretches of the story, kept for when something from far back becomes relevant again.</p>
      <ul>{payload.arcs.map((arc) => <li key={arc.id}><b>{arc.startMessageCount}–{arc.endMessageCount}</b>{arc.summary}</li>)}</ul>
    </section> : null}
  </Sheet>;
}
