import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { savedCreationDestination } from "@/lib/creation-actions";
import { justCreatedParam, isJustCreated } from "@/lib/back-navigation";

/**
 * Where a save lands, and when.
 *
 * The symptom was two destinations: the studio closed onto the feed, and five
 * to ten seconds later the new creation's page opened by itself. The cause was
 * an ordering mistake in one handler — three library refreshes (six API calls,
 * each with its own auth round trip, one of them downloading every creation's
 * import source) were AWAITED before `router.replace` ran.
 *
 * So there are two things to hold: the decision itself, which is pure and
 * asserted directly, and the ordering in the shell, which is asserted against
 * the handler's source because that is precisely where the bug lived.
 */

const shell = readFileSync(new URL("../src/components/shell/AppShell.tsx", import.meta.url), "utf8");

/** The `onSaved` handler the studio is given, from `{` to its closing `}}`. */
function savedHandler() {
  const start = shell.indexOf("onSaved={(character,{created}) =>");
  expect(start).toBeGreaterThan(-1);
  return shell.slice(start, shell.indexOf("onDeleted=", start));
}

describe("a successful create has exactly one destination", () => {
  it("opens the new creation's own page, replacing the studio's entry", () => {
    const destination = savedCreationDestination("aaaaaaaa-0000-4000-8000-000000000001", { created: true, justCreatedParam });
    expect(destination).toEqual({
      kind: "creation",
      href: `/characters/aaaaaaaa-0000-4000-8000-000000000001?${justCreatedParam}=1`,
      replace: true,
    });
    // The marker is what tells that page's Back control to go to Discovery
    // rather than back into the form that was just completed.
    expect(isJustCreated(new URL(`http://test${destination.kind === "creation" ? destination.href : ""}`).search)).toBe(true);
  });

  it("returns an edit to its story rather than to a page", () => {
    expect(savedCreationDestination("aaaaaaaa-0000-4000-8000-000000000001", { created: false, justCreatedParam }))
      .toEqual({ kind: "chat" });
  });

  it("never produces both", () => {
    for (const created of [true, false]) {
      const destination = savedCreationDestination("aaaaaaaa-0000-4000-8000-000000000001", { created, justCreatedParam });
      expect(["creation", "chat"]).toContain(destination.kind);
    }
  });
});

describe("nothing slow stands between the save and the navigation", () => {
  const handler = savedHandler();

  it("is not an async handler", () => {
    // An `async` handler here is how the await crept in. The save has already
    // completed by the time this runs; there is nothing left to wait for.
    expect(handler).not.toContain("async (character");
  });

  it("awaits nothing at all", () => {
    expect(handler).not.toContain("await");
    expect(handler).not.toContain("Promise.all");
  });

  it("navigates before it refreshes anything", () => {
    const navigate = handler.indexOf("router.replace");
    const refresh = handler.indexOf("refreshLibraries");
    expect(navigate).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(navigate);
  });

  it("schedules no delayed navigation anywhere in the shell", () => {
    // The other shape this bug takes: a timer that navigates. Every remaining
    // timeout in the shell clears a notice or debounces a keystroke.
    for (const match of shell.matchAll(/setTimeout\(([\s\S]{0,220}?)\)/g)) {
      expect(match[1]).not.toContain("router.");
      expect(match[1]).not.toContain("location.href");
    }
  });
});
