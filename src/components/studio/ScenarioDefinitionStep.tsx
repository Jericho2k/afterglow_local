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
      hint="Describe what is happening and the situation the reader enters — what is at stake, and why now."
      counter={<Counter value={draft.scenario.length} max={12000} />}
    >
      <TextArea
        value={draft.scenario}
        maxLength={12000}
        size="epic"
        onChange={(value) => update({ scenario: value })}
        placeholder="Describe the situation, what is at stake, and why the reader arrives now"
      />
    </Field>

    <Field
      label="The reader's role"
      optional
      hint="Describe who the reader is in this scenario, if the role is predefined. Shown publicly as “Your role” when you fill it in."
      counter={<Counter value={draft.userRole.length} max={4000} />}
    >
      <TextArea
        value={draft.userRole}
        maxLength={4000}
        onChange={(value) => update({ userRole: value })}
        placeholder="Describe who the reader plays, and what everyone else knows about them"
      />
    </Field>

    <Field
      label="What the AI is responsible for"
      hint="Tell the AI what it controls and how to handle the world, the narration and the NPCs — including what it must never do."
      counter={<Counter value={draft.responseDirective.length} max={8000} />}
    >
      <TextArea
        value={draft.responseDirective}
        maxLength={8000}
        size="tall"
        onChange={(value) => update({ responseDirective: value })}
        placeholder="Describe what the AI narrates, which characters it plays, and what it must never write for the reader"
      />
    </Field>

    <Field
      label="Background, lore & established facts"
      optional
      hint="Write the history and established facts the AI should treat as already true here. Setting material you want to reuse elsewhere belongs in a World on the next step."
      counter={<Counter value={draft.backstory.length} max={30000} />}
    >
      <TextArea value={draft.backstory} maxLength={30000} size="tall" onChange={(value) => update({ backstory: value })} placeholder="Write what is already true when the story begins" />
    </Field>

    <SectionCard
      icon={<UsersRound size={17} aria-hidden />}
      title={`Important characters${draft.cast.length ? ` · ${draft.cast.length}` : ""}`}
      description="Optional. Define recurring characters the AI should know in detail. There is no need to list every NPC — the AI creates the rest from your premise and world."
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
      description="Show the AI how the narration itself should read."
      count={(draft.personality ? 1 : 0) + (draft.exampleDialogue ? 1 : 0)}
    >
      <Field
        label="Tone & narrative style"
        optional
        hint="Describe the atmosphere and pacing you want: how grim or warm, how dense the description, how fast events move."
        counter={<Counter value={draft.personality.length} max={12000} />}
      >
        <TextArea value={draft.personality} maxLength={12000} size="tall" onChange={(value) => update({ personality: value })} placeholder="Describe the atmosphere, pacing and density of the writing" />
      </Field>
      <Field
        label="Example prose"
        optional
        hint="Write a passage that demonstrates how narration and dialogue should be written. {{user}} refers to the reader."
        counter={<Counter value={draft.exampleDialogue.length} max={12000} />}
      >
        <TextArea value={draft.exampleDialogue} maxLength={12000} size="tall" onChange={(value) => update({ exampleDialogue: value })} placeholder="Write a short passage in the voice the narration should use" />
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
        hint="State the consent rules, hard limits and topics this scenario must never go near."
        counter={<Counter value={draft.boundaries.length} max={5000} />}
      >
        <TextArea value={draft.boundaries} maxLength={5000} size="tall" onChange={(value) => update({ boundaries: value })} placeholder="State the limits this scenario must respect" />
      </Field>
    </Disclosure>

    <SourceMaterial draft={draft} update={update} />
  </>;
}
