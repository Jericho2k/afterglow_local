"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
 *
 * THE PANEL IS PORTALLED, and that is not a detail. It used to be an
 * absolutely positioned child of the trigger, which put it inside whatever the
 * trigger happened to be inside — and a creation card is `overflow: hidden`,
 * because it has rounded corners and cover art. So the menu on Your Creations
 * was cut off at the card's edge. No amount of `z-index` fixes that: a clipped
 * element is clipped at every depth. It renders into `document.body` and is
 * positioned from the trigger's own rectangle instead, which also lets it flip
 * above the trigger near the bottom of the screen and stay inside the viewport
 * horizontally rather than disappearing off the right edge of a narrow phone.
 */

/** Gap between the trigger and the panel, and the margin it keeps from an edge. */
const panelGap = 8;
const viewportMargin = 12;

type PanelPosition = { top: number; left: number; maxHeight: number };

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
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  /**
   * Where the panel goes, measured from the trigger rather than inherited from
   * it. Flips above when there is more room there, and is clamped into the
   * viewport on both axes so a menu at the right edge of a phone stays legible.
   */
  const place = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = panel.current?.offsetWidth ?? 208;
    const height = panel.current?.offsetHeight ?? 0;
    const below = window.innerHeight - anchor.bottom - panelGap - viewportMargin;
    const above = anchor.top - panelGap - viewportMargin;
    const flip = height > below && above > below;
    const left = align === "end" ? anchor.right - width : anchor.left;
    setPosition({
      top: flip ? Math.max(viewportMargin, anchor.top - panelGap - height) : anchor.bottom + panelGap,
      left: Math.min(Math.max(viewportMargin, left), Math.max(viewportMargin, window.innerWidth - width - viewportMargin)),
      maxHeight: Math.max(120, flip ? above : below),
    });
  }, [align]);

  // Measured after the panel exists, then kept correct while the page moves
  // under it. `true` on the scroll listener so a scrollable ancestor counts.
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  // Outside click and Escape, bound only while the menu is actually open so a
  // page carrying several menus is not listening on every one of them.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      // The panel is no longer inside the wrapper, so it has to be asked too.
      const target = event.target as Node;
      if (wrapper.current?.contains(target) || panel.current?.contains(target)) return;
      close(false);
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
    {open && typeof document !== "undefined" && createPortal(<div
      className={styles.panel}
      id={id}
      role="menu"
      ref={panel}
      aria-label={label}
      // Hidden until measured rather than painted at the top-left corner and
      // then moved, which is what a first frame at (0,0) looks like.
      style={position
        ? { top: position.top, left: position.left, maxHeight: position.maxHeight }
        : { top: 0, left: 0, visibility: "hidden" }}
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
    </div>, document.body)}
  </div>;
}
