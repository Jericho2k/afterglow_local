"use client";

import { useMemo, useState } from "react";
import { MessageSquare, Plus, Search, Sparkles } from "lucide-react";
import type { Character, Conversation, Persona } from "@/lib/types";
import { creationKindLine, creationTitle } from "@/lib/creation";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import { compactMessagePreview } from "@/lib/message-format";
import { accentVariables } from "@/lib/accent";
import { uiStyles } from "@/components/ui";
import { PageHeader } from "./PageHeader";
import styles from "./shell.module.css";

/**
 * Chats.
 *
 * The old version was a flat list of rows in which the thing people actually
 * scan for — whose story is this — was a small line of grey text under a title
 * that was usually the first message they had sent. So the creation leads now:
 * its artwork, its own title, and its stories nested beneath it.
 *
 * Grouping is a presentation choice, not a data one. Every conversation that
 * existed still has a row, in the same order, reachable in one tap; a creation
 * with a single story shows that story inline rather than making the reader
 * expand a group of one. Nothing is hidden.
 *
 * The list stays lean deliberately: it renders the conversation index the
 * shell already holds — title, message count, persona, timestamp — and reads
 * no transcripts. A chat list must not cost what opening a chat costs.
 */

function relativeDay(value: string) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export function ChatsView({ characters, conversations, personas, onOpen, onOpenMenu, onCreate }: {
  characters: Character[];
  conversations: Conversation[];
  personas: Persona[];
  onOpen: (characterId: string, conversationId?: string) => void;
  onOpenMenu?: () => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return characters
      .map((character) => ({
        character,
        stories: conversations
          .filter((item) => item.characterId === character.id)
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
      }))
      // A creation whose title matches keeps all of its stories; otherwise a
      // story whose own title matches is enough to keep the creation visible.
      .filter(({ character, stories }) => {
        if (!needle) return true;
        if (creationTitle(character).toLowerCase().includes(needle)) return true;
        return stories.some((story) => story.title.toLowerCase().includes(needle));
      })
      .sort((a, b) => {
        const left = a.stories[0]?.updatedAt ?? a.character.updatedAt;
        const right = b.stories[0]?.updatedAt ?? b.character.updatedAt;
        return new Date(right).getTime() - new Date(left).getTime();
      });
  }, [characters, conversations, query]);

  const personaName = (id: string | null) => personas.find((persona) => persona.id === id)?.name || "Default persona";
  const totalStories = conversations.length;

  return <section className={styles.page}>
    <div className={styles.inner}>
      <PageHeader
        eyebrow="Your stories"
        title="Chats"
        lede="Every creation you have talked to, and every separate story you have with them."
        onOpenMenu={onOpenMenu}
        actions={<button className={`${uiStyles.button} ${uiStyles.primary}`} onClick={onCreate}>
          <Plus size={16} aria-hidden />New
        </button>}
      />

      {characters.length > 0 && <div className={styles.field} style={{ marginBottom: 18 }}>
        <label className={styles.fieldLabel} htmlFor="chat-search">Find a creation or a story</label>
        <div style={{ position: "relative" }}>
          <Search size={15} aria-hidden style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", opacity: .5, pointerEvents: "none" }} />
          <input
            id="chat-search"
            className={styles.input}
            style={{ paddingLeft: 34 }}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name…"
          />
        </div>
      </div>}

      {groups.length === 0 && <div className={styles.empty}>
        <MessageSquare size={26} aria-hidden />
        <h2>{characters.length ? "Nothing matches that" : "No stories yet"}</h2>
        <p>{characters.length
          ? "Try a different name, or clear the search to see everything."
          : "Find a creation in Discovery, or make one of your own — your chats collect here."}</p>
        {!characters.length && <button className={`${uiStyles.button} ${uiStyles.primary}`} onClick={onCreate}>
          <Sparkles size={16} aria-hidden />Create something
        </button>}
      </div>}

      <div className={styles.stack}>
        {groups.map(({ character, stories }) => {
          const cover = avatarSource(characterAvatarBucket, character.avatarPath, character.avatarUrl);
          const newest = stories[0];
          // A single story needs no group to open: showing one row under a
          // header of one would be ceremony for nothing.
          const open = stories.length > 1 && expanded.has(character.id);
          return <article
            key={character.id}
            className={styles.chatGroup}
            style={accentVariables(character.accent) as React.CSSProperties}
          >
            <div className={styles.chatHead}>
              <span className={styles.chatArt} aria-hidden>
                {cover ? <img src={cover} alt="" /> : initials(character.name)}
              </span>
              <button className={styles.chatIdentity} onClick={() => onOpen(character.id, newest?.id)}>
                <strong>{creationTitle(character)}</strong>
                <span className={styles.chatMeta}>
                  <span>{creationKindLine(character)}</span>
                  <span aria-hidden>·</span>
                  <span>{stories.length} {stories.length === 1 ? "story" : "stories"}</span>
                  {newest && <><span aria-hidden>·</span><span>{relativeDay(newest.updatedAt)}</span></>}
                </span>
                {newest && <span className={styles.chatPreview}>{compactMessagePreview(newest.title, 90)}</span>}
              </button>
              {stories.length > 1 && <button
                className={`${uiStyles.chip}`}
                aria-expanded={open}
                onClick={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(character.id)) next.delete(character.id); else next.add(character.id);
                  return next;
                })}
              >{open ? "Hide" : `All ${stories.length}`}</button>}
            </div>

            {open && <div className={styles.chatStories}>
              {stories.map((story) => <button key={story.id} className={styles.storyRow} onClick={() => onOpen(character.id, story.id)}>
                <span>
                  <strong>{story.title}</strong>
                  <small>{story.messageCount} messages · {personaName(story.personaId)}</small>
                </span>
                <time dateTime={story.updatedAt}>{relativeDay(story.updatedAt)}</time>
              </button>)}
              <button className={styles.newStory} onClick={() => onOpen(character.id)}>
                <Plus size={14} aria-hidden />Start another story
              </button>
            </div>}

            {stories.length === 0 && <div className={styles.chatStories}>
              <button className={styles.newStory} onClick={() => onOpen(character.id)}>
                <Plus size={14} aria-hidden />Start the first story
              </button>
            </div>}
          </article>;
        })}
      </div>

      {totalStories > 0 && <p className={styles.quiet} style={{ marginTop: 18 }}>
        {totalStories} {totalStories === 1 ? "story" : "stories"} across {characters.length} {characters.length === 1 ? "creation" : "creations"}.
      </p>}
    </div>
  </section>;
}
