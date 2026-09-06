"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { creationTitle, creationTypeLabels } from "@/lib/creation";
import { forgetCreation } from "@/lib/creation-cache";
import { adultTagsIn } from "@/lib/tags";
import type { Character, CharacterGalleryImage, CreationType, World } from "@/lib/types";
import { BasicsStep } from "./BasicsStep";
import { CastDefinitionStep } from "./CastDefinitionStep";
import { CharacterDefinitionStep } from "./CharacterDefinitionStep";
import { CreationProgress, type StudioStep } from "./CreationProgress";
import { OpeningStep } from "./OpeningStep";
import { PublishStep } from "./PublishStep";
import { ScenarioDefinitionStep } from "./ScenarioDefinitionStep";
import { WorldStep, type StudioWorld } from "./WorldStep";
import { CreateIntro, AiNotices } from "./CreateIntro";
import { blankCastMember, draftFromCharacter, draftPayload, draftProblems, isMeaningfulDraft, type CreationDraft, type StagedGalleryImage } from "./draft";
import { draftStorageKey, forgetStoredDraft, readStoredDraft, writeStoredDraft, type DraftSummary } from "./drafts";
import type { CreationAiNotice } from "@/lib/creation-ai";
import styles from "./studio.module.css";

/**
 * Creation Studio.
 *
 * One adaptive flow for all three authoring structures. The steps a creator
 * sees follow what they are actually making, but the draft is a single object
 * held for the lifetime of the studio: moving between steps, changing the
 * creation type, or reloading the page never discards typed text.
 */

const definitionLabels: Record<CreationType, string> = { character: "Character", cast: "Cast", scenario: "Scenario" };

function stepsFor(type: CreationType): StudioStep[] {
  return [
    { id: "basics", label: "Basics" },
    { id: "definition", label: definitionLabels[type] },
    { id: "world", label: "World" },
    { id: "opening", label: "Opening" },
    { id: "publish", label: "Publish" },
  ];
}

function sameGallery(a: StagedGalleryImage[], b: StagedGalleryImage[]) {
  if (a.length !== b.length) return false;
  return a.every((image, index) => image.storagePath === b[index].storagePath && image.externalUrl === b[index].externalUrl && image.caption === b[index].caption);
}

export function CreationStudio({ character, worlds, startStep, onClose, onSaved, onDeleted, onLibrariesChanged }: {
  character: Character | null;
  worlds: StudioWorld[];
  startStep?: string;
  onClose: () => void;
  /**
   * `created` is true only when this save brought the creation into
   * existence. Publishing and editing end in different places, and this is
   * the one bit of information that distinguishes them.
   */
  onSaved: (character: Character, context: { created: boolean }) => void;
  onDeleted: () => void;
  onLibrariesChanged: () => void;
}) {
  // The record being edited. A new creation gains one the first time it is
  // saved, after which further saves update it rather than creating copies.
  const [record, setRecord] = useState<Character | null>(character);
  const [draft, setDraft] = useState<CreationDraft>(() => draftFromCharacter(character));
  const [phase, setPhase] = useState<"type" | "steps">(character ? "steps" : "type");
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restored, setRestored] = useState(false);
  /*
   * True until the complete record has been fetched for an edit.
   *
   * Saving before it lands would write the list's copy of the creation, which
   * is deliberately not the whole record — it carries no gallery and no import
   * source material. Both would be blanked. The gallery case was already
   * handled by loading the record; this closes the window before that load
   * finishes, which is the same bug with a stopwatch attached.
   */
  const [loadingRecord, setLoadingRecord] = useState(Boolean(character));
  const [aiNotices, setAiNotices] = useState<CreationAiNotice[]>([]);
  const [localWorlds, setLocalWorlds] = useState<StudioWorld[]>(worlds);
  const savedGallery = useRef<StagedGalleryImage[]>(draftFromCharacter(character).gallery);
  // What "unchanged" currently means: the blank draft for a new creation, the
  // loaded record while editing, and the saved copy after every save. Every
  // decision about whether there is unsaved work is made against this.
  const baseline = useRef<CreationDraft | null>(character ? draftFromCharacter(character) : null);
  // Autosave key. A creation saved for the first time moves from the shared
  // "new" slot to its own, so a later Create does not resurrect it.
  const storageKey = useRef(draftStorageKey(character?.id ?? null));
  const hydrated = useRef(false);
  // Set before the record is fetched, so a restored local draft is never
  // overwritten by the server copy it is newer than.
  const restoredRef = useRef(false);

  useEffect(() => { setLocalWorlds(worlds); }, [worlds]);

  const steps = useMemo(() => stepsFor(draft.creationType), [draft.creationType]);
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const problems = useMemo(() => draftProblems(draft), [draft]);

  const update = useCallback((changes: Partial<CreationDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  }, []);

  /**
   * Load the complete record when editing.
   *
   * The character list carries no gallery, so editing from there and saving
   * would otherwise write an empty gallery over the creator's images.
   */
  useEffect(() => {
    if (!character) { hydrated.current = true; return; }
    let cancelled = false;
    api<{ character: Character }>(`/api/characters/${character.id}?scope=edit`)
      .then(({ character: full }) => {
        if (cancelled) return;
        const loaded = draftFromCharacter(full);
        savedGallery.current = loaded.gallery;
        baseline.current = loaded;
        setRecord(full);
        // A restored local draft is newer than the server copy, so it wins.
        setDraft((current) => (restoredRef.current ? { ...current, gallery: current.gallery.length ? current.gallery : loaded.gallery } : loaded));
      })
      .catch(() => undefined)
      .finally(() => { hydrated.current = true; if (!cancelled) setLoadingRecord(false); });
    return () => { cancelled = true; };
  }, [character]);

  /**
   * Restore an interrupted session before anything else touches the draft.
   *
   * Only work that actually differs from where the session started is
   * restorable. A stored draft that turns out to hold nothing — written by an
   * older build, or left behind by a session that was opened and abandoned — is
   * deleted here rather than resurrected, so the intro screen comes back and no
   * notice claims work was recovered.
   */
  useEffect(() => {
    const key = draftStorageKey(character?.id ?? null);
    const stored = readStoredDraft(character?.id ?? null);
    if (!stored) return;
    const restoredDraft = draftFromCharacter(stored.draft as unknown as Character);
    if (!isMeaningfulDraft(restoredDraft, baseline.current)) { forgetStoredDraft(key); return; }
    restoredRef.current = true;
    setDraft(restoredDraft);
    setRestored(true);
    if (!character) setPhase("steps");
  }, [character]);

  /**
   * Autosave. Long definitions are exactly the thing a lost tab destroys.
   *
   * Nothing is written until the session holds work, and the moment it stops
   * holding work — everything typed was deleted again, the draft was discarded,
   * the creation was saved — the stored copy is removed. An empty session
   * therefore leaves no trace at all.
   */
  useEffect(() => {
    if (!hydrated.current && character) return;
    const timeout = window.setTimeout(() => {
      if (!isMeaningfulDraft(draft, baseline.current)) { forgetStoredDraft(storageKey.current); return; }
      writeStoredDraft(storageKey.current, draft);
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [draft, character]);

  const clearStoredDraft = useCallback(() => { forgetStoredDraft(storageKey.current); }, []);

  /**
   * Changing the structure never destroys anything: every field stays in the
   * draft, and only the step that presents them changes. Moving a lone
   * character into a cast seeds them as the first member so the work carries
   * across visibly.
   */
  function changeType(next: CreationType) {
    setDraft((current) => {
      if (current.creationType === next) return current;
      const seeded = next === "cast" && current.cast.length === 0 && current.name.trim()
        ? [{ ...blankCastMember, name: current.name.trim(), tagline: current.tagline.trim().slice(0, 240) }]
        : current.cast;
      return { ...current, creationType: next, profileType: next === "character" ? "single" : "ensemble", cast: seeded };
    });
    if (next === "cast" && draft.creationType === "character" && draft.cast.length === 0 && draft.name.trim()) {
      setNotice(`${draft.name.trim()} was added as the first cast member. Everything else you wrote is still here.`);
    }
  }

  /**
   * Resume a draft the Create screen offered.
   *
   * Everything the draft held is restored — structure, fields, tags,
   * hashtags, cast, worlds, openings, images, adult setting and imported
   * source — because the stored object is the whole draft rather than a
   * summary of it. A draft belonging to a creation that was already saved
   * also moves this session onto that creation's autosave slot, so continuing
   * it keeps updating the same draft instead of forking a second one.
   */
  const continueDraft = useCallback((summary: DraftSummary) => {
    storageKey.current = summary.key;
    // Its own stored state is what "unchanged" means from here: a resumed
    // draft is not immediately re-announced as recovered work.
    baseline.current = summary.creationId ? null : { ...summary.draft };
    restoredRef.current = true;
    setDraft(summary.draft);
    setRestored(false);
    setAiNotices([]);
    setPhase("steps");
    setStepIndex(0);
    if (summary.creationId) {
      // The saved record is fetched so the gallery and the server's own copy
      // are available; the resumed draft stays in front of it. Saving waits
      // for it, because until `record` exists a save would create a SECOND
      // creation rather than updating the one being resumed.
      setLoadingRecord(true);
      api<{ character: Character }>(`/api/characters/${summary.creationId}?scope=edit`)
        .then(({ character: full }) => {
          const loaded = draftFromCharacter(full);
          savedGallery.current = loaded.gallery;
          baseline.current = loaded;
          setRecord(full);
        })
        .catch(() => undefined)
        .finally(() => setLoadingRecord(false));
    }
    scrollTop();
  }, []);

  function goToStep(id: string) {
    const index = steps.findIndex((item) => item.id === id);
    if (index >= 0) { setStepIndex(index); scrollTop(); }
  }

  const bodyRef = useRef<HTMLDivElement>(null);
  function scrollTop() { bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" }); }

  useEffect(() => {
    if (!startStep) return;
    const index = stepsFor(draft.creationType).findIndex((item) => item.id === startStep);
    if (index >= 0) setStepIndex(index);
    // Only honours the entry point once; later step changes are the creator's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startStep]);

  /**
   * Saves the creation.
   *
   * Mirrors the behaviour the studio already had: an imported lorebook is
   * promoted to its own reusable World, world links are replaced, and the
   * gallery is written through its own endpoint once an id exists.
   */
  async function save({ close }: { close: boolean }) {
    // Adult tags and adult mode cannot disagree on anything anybody else can
    // reach. The server enforces this too, but stopping here is what lets the
    // creator decide which of the two to change rather than being corrected
    // after the fact.
    const adult = adultTagsIn(draft.tags);
    if (adult.length && draft.contentMode !== "adult_focused" && draft.visibility !== "private") {
      setError(`${adult.slice(0, 3).join(", ")}${adult.length > 3 ? ` and ${adult.length - 3} more` : ""} ${adult.length === 1 ? "is an adult tag" : "are adult tags"}, so this can only be shared as Adult-focused · 18+. Change the content mode, remove ${adult.length === 1 ? "it" : "them"}, or keep the creation private.`);
      goToStep("publish");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let worldIds = [...draft.worldIds];
      // World material an import separated becomes a real, reusable World —
      // but only here, on an explicit save, and under the name the creator
      // saw and could edit. Nothing persistent appears in their library
      // merely because they ran an import and looked at the result.
      if (draft.lorebook.trim()) {
        const created = await api<{ world: World }>("/api/worlds", {
          method: "POST",
          body: JSON.stringify({
            name: draft.proposedWorld?.name.trim() || `${(draft.title || draft.name).trim() || "Imported"} world`,
            description: draft.proposedWorld?.description.trim() || "World material separated automatically from the import.",
            content: draft.lorebook.trim(),
          }),
        });
        worldIds = [...new Set([...worldIds, created.world.id])];
        onLibrariesChanged();
      }
      const payload = { ...draftPayload({ ...draft, worldIds }), lorebook: "" };
      const saved = await api<{ character: Character }>(
        record ? `/api/characters/${record.id}` : "/api/characters",
        { method: record ? "PATCH" : "POST", body: JSON.stringify(payload) },
      );

      let stored: CharacterGalleryImage[] | null = null;
      if (!sameGallery(draft.gallery, savedGallery.current)) {
        const result = await api<{ images: CharacterGalleryImage[] }>(`/api/characters/${saved.character.id}/gallery`, {
          method: "PUT",
          body: JSON.stringify({ images: draft.gallery }),
        });
        stored = result.images;
        savedGallery.current = [...draft.gallery];
      }

      const complete: Character = { ...saved.character, gallery: stored ?? saved.character.gallery };
      const created = !record;
      /*
       * The creation page must not be able to paint what this save replaced.
       *
       * Saving from `/characters/{id}/edit` returns THROUGH HISTORY to the
       * creation, which remounts its page, which paints from the per-tab cache
       * before its own fetch lands. That entry was written before the edit, so
       * a creator who had just moved a focal point or uploaded a banner was
       * shown the previous presentation — briefly on a good network, and until
       * they reloaded if the revalidation failed. Forgetting it here covers
       * every way the studio is reached and both save controls, and the Back
       * semantics the editor computes are untouched: the destination is the
       * same entry, it simply has nothing stale left to draw.
       */
      forgetCreation(complete.id);
      clearStoredDraft();
      storageKey.current = draftStorageKey(complete.id);
      setRecord(complete);
      const settled = { ...draft, worldIds, lorebook: "", proposedWorld: null };
      // The saved copy is the new "unchanged", so a creation that was just
      // published is not immediately mistaken for unsaved work.
      baseline.current = settled;
      forgetStoredDraft(storageKey.current);
      setDraft(settled);
      setRestored(false);
      restoredRef.current = false;
      if (close) { onSaved(complete, { created }); return; }
      setNotice(complete.visibility === "public" ? "Saved and published." : "Draft saved to your library.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this creation");
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!record) return;
    const label = creationTitle(record);
    if (!window.confirm(`Permanently delete “${label}”, including every chat and memory attached to it?`)) return;
    setBusy(true);
    try {
      await api(`/api/characters/${record.id}`, { method: "DELETE" });
      // Nothing may paint a creation that no longer exists, for the same
      // reason a save forgets one: this tab's cache outlives the page.
      forgetCreation(record.id);
      clearStoredDraft();
      onDeleted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete this creation");
      setBusy(false);
    }
  }

  const title = creationTitle({ title: draft.title, name: draft.name, creationType: draft.creationType, profileType: draft.profileType });
  const savable = Boolean(draft.title.trim() || draft.name.trim()) && !loadingRecord;
  const last = stepIndex >= steps.length - 1;
  const publishLabel = record
    ? "Save changes"
    : draft.visibility === "public" ? "Publish creation" : draft.visibility === "unlisted" ? "Save & get link" : "Save privately";

  return <div className={styles.studio} role="dialog" aria-modal="true" aria-label={record ? `Edit ${title}` : "Create"}>
    <header className={styles.header}>
      <button type="button" className={styles.iconButton} aria-label="Close studio" onClick={onClose}><X size={18} /></button>
      <div className={styles.headerTitle}>
        <strong>{record ? "Edit creation" : "Create"}</strong>
        <small>{phase === "type" ? "Choose what you're making" : `${creationTypeLabels[draft.creationType]} · ${title}`}</small>
      </div>
      {phase === "steps"
        ? <button type="button" className={styles.headerAction} disabled={busy || !savable} onClick={() => void save({ close: false })}>
          {busy ? "Saving…" : record ? "Save" : "Save draft"}
        </button>
        : <span className={styles.headerSpacer} />}
    </header>

    {phase === "steps" && <CreationProgress steps={steps} current={stepIndex} onSelect={(index) => { setStepIndex(index); scrollTop(); }} />}

    <div className={styles.body} ref={bodyRef}>
      <div className={styles.inner}>
        {restored && <div className={styles.notice}>
          <Sparkles size={15} className={styles.noticeIcon} aria-hidden />
          <span>Unsaved work from your last session was restored.</span>
          <button type="button" onClick={() => {
            clearStoredDraft();
            // Back to where the session started, which is also the state the
            // autosave treats as "nothing to keep" — so it stays discarded.
            setDraft(baseline.current ? { ...baseline.current } : draftFromCharacter(null));
            setRestored(false);
            restoredRef.current = false;
          }}>Discard</button>
        </div>}
        {notice && <div className={styles.notice}>
          <Check size={15} className={styles.noticeIcon} aria-hidden />
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")}>Dismiss</button>
        </div>}
        <AiNotices notices={aiNotices} onDismiss={() => setAiNotices([])} />
        {error && <div className={styles.error} role="alert">{error}</div>}

        {phase === "type"
          ? <CreateIntro
            draft={draft}
            update={update}
            onChangeType={changeType}
            hasWork={isMeaningfulDraft(draft, baseline.current)}
            onGenerated={(generated, notices) => {
              setDraft(generated);
              setAiNotices(notices);
              setPhase("steps");
              setStepIndex(0);
              scrollTop();
            }}
            onContinueDraft={continueDraft}
            onError={setError}
          />
          : step.id === "basics" ? <BasicsStep draft={draft} update={update} onChangeType={changeType} onError={setError} />
            : step.id === "definition" ? (
              draft.creationType === "scenario" ? <ScenarioDefinitionStep draft={draft} update={update} onError={setError} />
                : draft.creationType === "cast" ? <CastDefinitionStep draft={draft} update={update} onError={setError} />
                  : <CharacterDefinitionStep draft={draft} update={update} onError={setError} />
            )
              : step.id === "world" ? <WorldStep
                draft={draft}
                update={update}
                worlds={localWorlds}
                onWorldCreated={(world) => { setLocalWorlds((current) => [world, ...current]); onLibrariesChanged(); }}
                onError={setError}
              />
                : step.id === "opening" ? <OpeningStep draft={draft} update={update} onError={setError} />
                  : <PublishStep
                    draft={draft}
                    update={update}
                    problems={problems}
                    existing={Boolean(record)}
                    onGoToStep={goToStep}
                    onError={setError}
                    onDelete={record ? () => void remove() : undefined}
                  />}
      </div>
    </div>

    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        {/* Back walks the steps, and from the first step of a new creation it
            returns to the Create screen rather than dead-ending — which is
            what makes the studio's own Back behave like the rest of the app.
            Nothing is discarded: the draft is one object either way. */}
        {phase === "steps" && (stepIndex > 0 || !record) && <button
          type="button"
          className={styles.backButton}
          onClick={() => {
            if (stepIndex > 0) { setStepIndex(stepIndex - 1); scrollTop(); return; }
            setPhase("type");
            scrollTop();
          }}
        >
          <ArrowLeft size={16} aria-hidden />Back
        </button>}
        {phase === "type"
          ? <button type="button" className={styles.primaryCta} onClick={() => { setPhase("steps"); setStepIndex(0); scrollTop(); }}>
            Continue<ArrowRight size={17} aria-hidden />
          </button>
          : last
            ? <button type="button" className={styles.primaryCta} disabled={busy || loadingRecord || problems.length > 0} onClick={() => void save({ close: true })}>
              {busy ? "Saving…" : loadingRecord ? "Loading…" : publishLabel}
            </button>
            : <button type="button" className={styles.primaryCta} onClick={() => { setStepIndex(stepIndex + 1); scrollTop(); }}>
              Next: {steps[stepIndex + 1].label}<ArrowRight size={17} aria-hidden />
            </button>}
      </div>
    </footer>
  </div>;
}
