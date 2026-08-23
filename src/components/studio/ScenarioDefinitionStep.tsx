"use client";

import { MessageSquareQuote, Sliders, UsersRound } from "lucide-react";
import { CastEditor } from "./CastEditor";
import { SourceMaterial } from "./CharacterDefinitionStep";
import { Counter, Disclosure, Field, SectionCard, TextArea } from "./fields";
import type { CreationDraft } from "./draft";
import styles from "./studio.module.css";

/**
 * Scenario definition.
 *
 * A scenario is not a character with the fields renamed. It describes what is
 * happening, who the reader is inside it, and what the AI is responsible for —
 * and it never demands a primary character. Named characters are available and
 * entirely optional: a war with fifty canonical figures should not require
 * fifty cards before it can be published.
 */
export function ScenarioDefinitionStep({ draft, update, onError }: {
  draft: CreationDraft;
  update: (changes: Partial<CreationDraft>) => void;
  onError: (message: string) => void;
}) {
  return <>
    <header className={styles.stepHead}>
      <h2>The scenario</h2>
      <p>What is happening, who the reader is, and what the AI is responsible for.</p>
    </header>

    <Field
      label="Premise"
      required
      hint="The situation the reader is stepping into, and why now."
      counter={<Counter value={draft.scenario.length} max={12000} />}
    >
      <TextArea
        value={draft.scenario}
        maxLength={12000}
        size="epic"
        onChange={(value) => update({ scenario: value })}
        placeholder="The Final War is approaching. U.A. is no longer functioning as only a school — it is a fortress, an evacuation centre and one of the last places still able to organise a resistance…"
      />
    </Field>

    <Field
      label="The reader's role"
      optional
      hint="Who {{user}} plays. Shown publicly as “Your role” when you fill it in."
      counter={<Counter value={draft.userRole.length} max={4000} />}
    >
      <TextArea
        value={draft.userRole}
        maxLength={4000}
        onChange={(value) => update({ userRole: value })}
        placeholder="A sealed asset whose file is classified and whose history is disputed."
      />
    </Field>

    <Field
      label="What the AI is responsible for"
      hint="Narration, NPCs, pacing, consequences — and what it must never do."
      counter={<Counter value={draft.responseDirective.length} max={8000} />}
    >
      <TextArea
        value={draft.responseDirective}
        maxLength={8000}
        size="tall"
        onChange={(value) => update({ responseDirective: value })}
        placeholder="Narrate the environment and control every NPC. Never write actions, dialogue or internal thoughts for {{user}}. Let decisions have consequences that persist."
      />
    </Field>

    <Field
      label="Background, lore & established facts"
      optional
      hint="What is already true in this story. Reusable setting material belongs in a World on the next step."
      counter={<Counter value={draft.backstory.length} max={30000} />}
    >
      <TextArea value={draft.backstory} maxLength={30000} size="tall" onChange={(value) => update({ backstory: value })} />
    </Field>

    <SectionCard
      icon={<UsersRound size={17} aria-hidden />}
      title={`Important characters${draft.cast.length ? ` · ${draft.cast.length}` : ""}`}
      description="Optional. Add recurring characters the AI should know in detail. You do not need to list every NPC in the scenario — the AI creates the rest from your premise and world."
    >
      <CastEditor
        cast={draft.cast}
        onChange={(cast) => update({ cast })}
        onError={onError}
        addLabel="Add an important character"
        emptyNote="No named characters. The AI will populate the scenario from your premise and any attached world."
      />
    </SectionCard>

    <Disclosure
      icon={<MessageSquareQuote size={17} aria-hidden />}
      title="Tone & example prose"
      description="How the narration should read."
      count={(draft.personality ? 1 : 0) + (draft.exampleDialogue ? 1 : 0)}
    >
      <Field
        label="Tone & narrative style"
        optional
        hint="Atmosphere, pacing, how grim or warm, how much description."
        counter={<Counter value={draft.personality.length} max={12000} />}
      >
        <TextArea value={draft.personality} maxLength={12000} size="tall" onChange={(value) => update({ personality: value })} />
      </Field>
      <Field
        label="Example prose"
        optional
        hint="A sample passage showing how narration and dialogue should be written. {{user}} refers to the reader."
        counter={<Counter value={draft.exampleDialogue.length} max={12000} />}
      >
        <TextArea value={draft.exampleDialogue} maxLength={12000} size="tall" onChange={(value) => update({ exampleDialogue: value })} />
      </Field>
    </Disclosure>

    <Disclosure
      icon={<Sliders size={17} aria-hidden />}
      title="Scenario rules & boundaries"
      description="Hard rules for how this roleplay runs. Never shown publicly."
      count={draft.boundaries ? 1 : 0}
    >
      <Field
        label="Boundaries"
        optional
        hint="Consent rules, topics to avoid, hard limits, anything the story must never do."
        counter={<Counter value={draft.boundaries.length} max={5000} />}
      >
        <TextArea value={draft.boundaries} maxLength={5000} size="tall" onChange={(value) => update({ boundaries: value })} />
      </Field>
    </Disclosure>

    <SourceMaterial draft={draft} update={update} />
  </>;
}
