import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { creationActions } from "@/lib/creation-actions";
import { shellViews } from "@/lib/shell-route";
import { isModerationAdminAccount, moderationAdminRequired } from "@/lib/session";

/**
 * Reporting and moderation already exist. This asserts they can be REACHED.
 *
 * A safety feature that is implemented and unreachable is not implemented. The
 * chain has four links and each one has failed in some product at some point:
 * the action has to be offered to the right person, the route has to resolve,
 * the session response has to say whether this account is a moderator, and the
 * server has to keep refusing everybody else regardless of what the interface
 * decided to render.
 *
 * The last of those is the one that must never be relaxed to fix any of the
 * others, which is why it is asserted here beside them.
 */

const originalAdmin = process.env.AFTERGLOW_ADMIN_USER_IDS;
afterEach(() => {
  if (originalAdmin === undefined) delete process.env.AFTERGLOW_ADMIN_USER_IDS;
  else process.env.AFTERGLOW_ADMIN_USER_IDS = originalAdmin;
});

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("reporting a creation", () => {
  it("is offered to somebody who does not own it", () => {
    const actions = creationActions({ owner: false }).map((action) => action.id);
    expect(actions).toContain("report");
  });

  it("is never offered to the owner, who has Edit and Delete instead", () => {
    const actions = creationActions({ owner: true }).map((action) => action.id);
    expect(actions).not.toContain("report");
    expect(actions).toEqual(expect.arrayContaining(["edit", "delete"]));
  });

  it("has a handler and a dialog behind it on the creation page", () => {
    const page = read("app/characters/[id]/profile.tsx");
    // The menu item is wired to something that opens the report dialog…
    expect(page).toContain("report:()=>{setReportOpen(true)");
    // …and the dialog posts to the reporting endpoint.
    expect(page).toContain("/api/reports");
  });
});

describe("the moderation queue", () => {
  it("has a shell route of its own", () => {
    expect(shellViews).toContain("reports");
  });

  it("is listed in the sidebar only for a moderator, and renders only for one", () => {
    const shell = read("components/shell/AppShell.tsx");
    // The nav group is conditional on the flag, not merely styled away.
    expect(shell).toContain("...(isModerator?[{id:\"moderation\",label:\"Admin\"");
    // And the surface itself re-checks, so a hand-typed ?view=reports shows
    // Discovery rather than the queue.
    expect(shell).toContain("activeView === \"reports\" ? (isModerator?<AdminReports");
  });

  it("learns whether this account is a moderator from the session response", () => {
    const session = read("app/api/session/route.ts");
    expect(session).toContain("isModerator:isModerationAdminAccount(account)");
    const shell = read("components/shell/AppShell.tsx");
    expect(shell).toContain("setIsModerator(Boolean(data.isModerator))");
  });
});

describe("the server is the authority, whatever the interface renders", () => {
  const account = { id: "11111111-1111-4111-8111-111111111111", email: null };

  it("refuses moderation for an ordinary account", () => {
    delete process.env.AFTERGLOW_ADMIN_USER_IDS;
    expect(isModerationAdminAccount(account)).toBe(false);
    expect(moderationAdminRequired(account)).not.toBeNull();
  });

  it("allows it only for the explicit administrator allowlist", () => {
    process.env.AFTERGLOW_ADMIN_USER_IDS = account.id;
    expect(isModerationAdminAccount(account)).toBe(true);
    expect(moderationAdminRequired(account)).toBeNull();
  });

  it("keeps every admin report route behind that check", () => {
    for (const route of ["app/api/admin/reports/route.ts", "app/api/admin/reports/[id]/route.ts"]) {
      expect(read(route)).toContain("moderationAdminRequired");
    }
  });
});
