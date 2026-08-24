"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import styles from "./menu.module.css";

/**
 * The three-dot menu.
 *
 * Three dots mean "there are more actions here", so pressing them opens a
 * list of them. This exists because the control on the creation page was not a
 * menu at all — it was a link straight to the edit route, which itself
 * redirected through the home shell, so tapping a menu button navigated twice
 * and landed somewhere the reader never asked to go.
 *
 * Everything about the behaviour follows from that: opening is not
 * navigation, each item does exactly the one thing it is labelled with, and
 * the menu closes on outside click, on Escape and after any item runs.
 */

export type MoreMenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Marks an irreversible action so it reads as one. Confirmation is the caller's. */
  danger?: boolean;
};

export function MoreMenu({ items, label = "More actions", className, align = "end" }: {
  items: MoreMenuItem[];
  label?: string;
  className?: string;
  /** Which edge the panel is pinned to. `end` keeps it inside a right-aligned bar. */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  // Outside click and Escape, bound only while the menu is actually open so a
  // page carrying several menus is not listening on every one of them.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!wrapper.current?.contains(event.target as Node)) close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.stopPropagation(); close(true); }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  // Focus moves into the menu when it opens, which is what makes it usable
  // from a keyboard and what tells a screen reader that anything happened.
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  if (!items.length) return null;

  return <div className={styles.wrapper} ref={wrapper}>
    <button
      type="button"
      ref={trigger}
      className={className}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      // Opens the menu and does nothing else. It is not a link, it has no
      // href, and it never navigates.
      onClick={() => setOpen((value) => !value)}
    >
      <MoreHorizontal size={18} aria-hidden />
    </button>
    {open && <div
      className={`${styles.panel} ${align === "start" ? styles.panelStart : styles.panelEnd}`}
      id={id}
      role="menu"
      ref={panel}
      aria-label={label}
      onKeyDown={(event) => {
        // Arrow keys walk the items; Tab out closes, so the menu never traps.
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown") { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus(); }
        if (event.key === "ArrowUp") { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length]?.focus(); }
        if (event.key === "Tab") close(false);
      }}
    >
      {items.map((item) => <button
        key={item.label}
        type="button"
        role="menuitem"
        className={`${styles.item} ${item.danger ? styles.danger : ""}`}
        onClick={() => {
          // Closed before the action runs, so an action that navigates does
          // not leave an orphaned panel behind on the page it came from.
          close(false);
          item.onSelect();
        }}
      >
        {item.icon}
        <span>{item.label}</span>
      </button>)}
    </div>}
  </div>;
}
