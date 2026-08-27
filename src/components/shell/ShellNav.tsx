"use client";

import { createContext, useContext } from "react";
import type { ShellView } from "@/lib/shell-route";

/**
 * How a component deep inside a surface asks the shell to go somewhere.
 *
 * The shell renders several surfaces from one route and owns the history entry
 * for each of them, so navigation cannot be `router.push` from an arbitrary
 * child: the shell would not learn that the view changed. Every surface already
 * receives `onOpenMenu` by prop for the same reason, and threading a second,
 * third and fourth callback through six components to put one control in a
 * header is how a shell becomes untouchable.
 *
 * So the shell publishes its navigator once. A component that has nothing to do
 * with routing — a bell in a page header — can ask for a destination by name
 * and still go through the same `goToView` every sidebar item uses.
 *
 * The default is a no-op rather than a throw, so a surface rendered outside the
 * shell (a test, a story) renders instead of failing.
 */
export type ShellNavigator = {
  openView: (view: ShellView) => void;
};

const ShellNavContext = createContext<ShellNavigator>({ openView: () => undefined });

export const ShellNavProvider = ShellNavContext.Provider;

export function useShellNav() {
  return useContext(ShellNavContext);
}
