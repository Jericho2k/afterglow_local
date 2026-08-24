"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Menu } from "lucide-react";
import styles from "./ui.module.css";

/**
 * The one shape an ordinary icon action has.
 *
 * Back, Menu, More, Share, Save and Settings all do the same kind of thing —
 * one tap, one icon, no label — so they are one control. Before this they were
 * a circle on pages built in one sprint and a rounded square on pages built in
 * another, which read as two products rather than one.
 *
 * `tone` chooses the surface, never the geometry: `media` is the blurred
 * variant for a control sitting on cover art, `subtle` is the quieter one for
 * inside a card. Anything genuinely circular — an avatar, the floating create
 * control — is not this component and should not become it.
 */
export type IconButtonTone = "default" | "media" | "subtle";

export const iconButtonClass = (tone: IconButtonTone = "default", extra = "") =>
  [styles.iconButton, tone === "media" ? styles.onMedia : tone === "subtle" ? styles.subtle : "", extra]
    .filter(Boolean).join(" ");

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Required: an icon-only control is unusable without one. */
  label: string;
  tone?: IconButtonTone;
}>(function IconButton({ label, tone = "default", className, children, ...rest }, ref) {
  return <button ref={ref} type="button" aria-label={label} title={label} className={iconButtonClass(tone, className)} {...rest}>
    {children}
  </button>;
});

/**
 * The app's menu control.
 *
 * There were three of these: a bare glyph in the chat header, a floating
 * legacy button that rendered in normal flow above 760px because it had no
 * base rule, and three copies of a modern one duplicated across the feed,
 * worlds and creations stylesheets. On the Worlds page two of them appeared at
 * once. This is the only one now.
 */
export function AppMenuButton({ onOpen, className }: { onOpen: () => void; className?: string }) {
  return <IconButton label="Open menu" onClick={onOpen} className={className}>
    <Menu size={18} aria-hidden />
  </IconButton>;
}
