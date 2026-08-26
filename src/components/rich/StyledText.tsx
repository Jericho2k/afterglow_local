import { Fragment } from "react";
import { parseInlineMarkup } from "@/lib/markup";
import { displaySegments } from "@/lib/message-format";

/**
 * Prose, rendered.
 *
 * Two components, one contract: emphasis becomes an element and everything else
 * becomes a text node. There is no `dangerouslySetInnerHTML` on either path, so
 * a creation's description and a model's reply are data all the way to the
 * screen — which is why parsing markup here is safe in a way that rendering
 * Markdown-to-HTML would not be.
 */

function Emphasis({ bold, italic, children }: { bold: boolean; italic: boolean; children: string }) {
  if (bold && italic) return <strong><em>{children}</em></strong>;
  if (bold) return <strong>{children}</strong>;
  if (italic) return <em>{children}</em>;
  return <>{children}</>;
}

/**
 * A message in the chat: speech and narration, each with its own emphasis.
 *
 * `providerEscapes` says whose backslashes these are. A model's are an artefact
 * of it escaping its own markdown and a matched escaped pair is read as the
 * emphasis it meant; a reader's are deliberate and are obeyed literally.
 *
 * Segments arrive through `displaySegments`, which is where the one difference
 * between what was written and what is drawn lives: `*action*` is roleplay
 * narration rather than emphasis, so its markers resolve away and its text
 * renders in the ordinary face. Bold still renders bold. See
 * src/lib/message-format.ts.
 */
export function StyledMessage({ content, providerEscapes = true }: { content: string; providerEscapes?: boolean }) {
  return <>{displaySegments(content, { providerEscapes }).map((segment, index) => (
    <span className={`message-segment ${segment.kind}`} key={index}>
      <Emphasis bold={segment.bold} italic={segment.italic}>{segment.text}</Emphasis>
    </span>
  ))}</>;
}

/** Authored prose outside the chat: a description, a world's lore, a caption. */
export function StyledProse({ text }: { text: string }) {
  return <>{parseInlineMarkup(text).map((segment, index) => (
    <Fragment key={index}>
      <Emphasis bold={segment.bold} italic={segment.italic}>{segment.text}</Emphasis>
    </Fragment>
  ))}</>;
}
