import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composerPlaceholder, composerNameLimit } from "@/lib/creation";
import { declarationsFor } from "./helpers/css";

/**
 * Where a reader finds their memories, and what the composer says.
 *
 * The memory library existed and was reachable from one place: an
 * administrator-only control in the chat header. On a phone that header
 * collapses its labelled buttons to icons, and the control was gated anyway,
 * so for every ordinary reader the archive their story runs on was reachable
 * from nowhere at all.
 *
 * These read the shell's source. It is a large client component with routing,
 * streaming and auth in it, so mounting it in a node test environment is not
 * available here; what can be checked is the structural property each fix
 * consists of, and each assertion below is the exact line whose removal
 * reintroduces the reported bug.
 */

const shell = readFileSync(new URL("../src/components/shell/AppShell.tsx", import.meta.url), "utf8");
const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

describe("Memories is reachable", () => {
  it("is in the chat header for every reader, not only an administrator", () => {
    const header = shell.slice(shell.indexOf('<div className="header-actions">'), shell.indexOf("</header>"));
    expect(header).toContain("<span>Memories</span>");
    expect(header).not.toContain("{isAdmin && <button className=\"icon-button labeled\" onClick={() => setMemoryOpen(true)}");
  });

  it("is in the mobile chat tools immediately above Engine", () => {
    const tools = shell.slice(shell.indexOf('className="composer-tools"'), shell.indexOf('<div className="composer">'));
    const memories = tools.indexOf("<strong>Memories</strong>");
    const engine = tools.indexOf("<strong>Engine</strong>");
    expect(memories).toBeGreaterThan(-1);
    expect(engine).toBeGreaterThan(-1);
    expect(memories).toBeLessThan(engine);
    // Nothing between them: "immediately above" is the requirement. The slice
    // starts inside the Memories label, so its own <strong> is already behind.
    const between = tools.slice(memories + "<strong>Memories</strong>".length, engine);
    expect(between).not.toContain("<strong>");
  });

  it("lays the chat tools out as a list on a phone, so above means above", () => {
    // In a two-column grid the item before Engine sits beside it, not over it.
    expect(globals).toContain("@media(max-width:560px){.composer-tools{grid-template-columns:1fr");
  });

  it("opens the library rather than a story surface", () => {
    expect(shell).toContain("onClick={() => { setComposerToolsOpen(false); setMemoryOpen(true); }}");
  });
});

describe("the per-reply context inspector", () => {
  it("is a message action for every reader", () => {
    expect(shell).toContain("title=\"See what story context this reply was written from\"");
    expect(shell).toContain("{contextActionLabel(message)}");
  });

  it("opens the inspector rather than the old admin recall drawer", () => {
    expect(shell).toContain("<ContextInspector message={recallMessage}");
    expect(shell).not.toContain("<RecallDrawer");
  });
});

describe("the composer placeholder", () => {
  it("names the character when the name fits", () => {
    expect(composerPlaceholder({ name: "Maya", title: "Maya", creationType: "character", profileType: "single", cast: [] }))
      .toBe("Message Maya…");
  });

  it("falls back to a generic line when the name would wrap", () => {
    const long = "Seraphine of the Everburning Cathedral and the Ninth Choir";
    expect(long.length).toBeGreaterThan(composerNameLimit);
    expect(composerPlaceholder({ name: long, title: long, creationType: "character", profileType: "single", cast: [] }))
      .toBe("Send a message…");
  });

  it("can never wrap, whatever it says", () => {
    // The composer sizes itself from scrollHeight, so a placeholder that wraps
    // grows an EMPTY composer and then leaves it scrollable. That is the bug.
    expect(globals).toContain(".composer textarea::placeholder{color:#71656d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}");
  });
});

describe("the composer's + button", () => {
  it("sits where Send sits, so a growing textarea cannot move it", () => {
    // `.composer` is align-items:flex-end; the plus was align-self:center.
    const plus = declarationsFor(globals, ".composer-plus");
    expect(plus["align-self"]).toBe("flex-end");
    expect(plus["place-items"]).toBe("center");
  });

  /*
   * IT ALSO HAS TO LOOK LIKE IT SITS THERE.
   *
   * The composer's horizontal padding was asymmetric — 16px on the left from
   * before a control lived there, 10px on the right — so + carried six more
   * pixels of air than Send, and was a pixel smaller besides. With a control at
   * each end that reads as a misalignment however stable the position is.
   */
  it("has exactly the resting size and inset that Send has", () => {
    const plus = declarationsFor(globals, ".composer-plus");
    const send = declarationsFor(globals, ".send-button");
    expect(plus.width).toBe(send.width);
    expect(plus.height).toBe(send.height);
    expect(plus["border-radius"]).toBe(send["border-radius"]);
    expect(plus.flex).toBe(send.flex);
    expect(send["align-self"]).toBe("flex-end");
  });

  it("is inset symmetrically, rather than corrected with a one-off offset", () => {
    const composer = declarationsFor(globals, ".composer");
    const sides = composer.padding.trim().split(/\s+/);
    // One value, or matching left and right in the two/four-value forms.
    const [top, right = top, , left = right] = sides;
    expect(left).toBe(right);
    expect(top).toBe(right);
  });
});

describe("the shell owns the viewport", () => {
  it("locks the document behind it, and only while the shell is mounted", () => {
    expect(globals).toContain("html.shell-locked,html.shell-locked body{height:100%;max-height:100%;overflow:hidden;overscroll-behavior:none");
    expect(shell).toContain('root.classList.add("shell-locked")');
    expect(shell).toContain('root.classList.remove("shell-locked")');
  });

  /*
   * A DRAWER, NOT A PAGE.
   *
   * It covered the whole viewport, which made it read as somewhere the reader
   * had navigated to rather than a panel over the story they were still in. It
   * is partial width again, flush to the left edge with no gap, and the screen
   * behind stays visible under the scrim.
   */
  it("gives the phone drawer part of the viewport, flush to its edge", () => {
    const drawer = declarationsFor(globals, ".sidebar.open");
    expect(drawer.position).toBe("fixed");
    // Pinned top, bottom and left; the right edge is where it stops.
    expect(drawer.inset).toBe("0 auto 0 0");
    expect(drawer.width).toMatch(/^min\(\d\d?vw,\s*\d+px\)$/);
    const [, viewportShare] = drawer.width.match(/(\d+)vw/) ?? [];
    expect(Number(viewportShare)).toBeGreaterThanOrEqual(80);
    expect(Number(viewportShare)).toBeLessThanOrEqual(90);
  });

  it("scrolls inside itself and slides rather than appearing", () => {
    const drawer = declarationsFor(globals, ".sidebar.open");
    expect(drawer["overflow-y"]).toBe("auto");
    expect(drawer["overscroll-behavior"]).toBe("contain");
    expect(globals).toContain("@keyframes sidebar-in");
  });

  it("respects the safe area on the edge it is flush against", () => {
    const drawer = declarationsFor(globals, ".sidebar.open");
    expect(drawer.padding).toContain("env(safe-area-inset-left)");
    expect(drawer.padding).toContain("env(safe-area-inset-top)");
    expect(drawer.padding).toContain("env(safe-area-inset-bottom)");
  });

  it("darkens and blurs the screen behind instead of replacing it", () => {
    const scrim = declarationsFor(globals, ".sidebar-scrim");
    expect(scrim.position).toBe("fixed");
    expect(scrim.inset).toBe("0");
    expect(scrim.background).toMatch(/rgba\(/);
    expect(scrim["backdrop-filter"]).toContain("blur");
  });

  it("puts a scrim under the drawer that swallows the touch behind it", () => {
    expect(shell).toContain('<button className="sidebar-scrim"');
    expect(globals).toContain(".sidebar-scrim{position:fixed;inset:0;z-index:39");
    expect(globals).toContain("touch-action:none");
  });

  it("collapses and restores the desktop sidebar from the same control", () => {
    expect(shell).toContain("if (isPhone()) setSidebarOpen(true);");
    expect(shell).toContain("else setSidebarCollapsed((value) => !value);");
    expect(declarationsFor(globals, ".app-shell.sidebar-collapsed")["grid-template-columns"]).toBe("0 minmax(0,1fr)");
    expect(globals).toContain("transition:grid-template-columns .24s");
  });

  it("no longer carries a recent-creations module in the sidebar", () => {
    expect(shell).not.toContain('className="sidebar-characters"');
    expect(shell).not.toContain("sidebarCharacterMenuId");
  });
});

describe("bubbles keep their gutters", () => {
  it("wraps a long unbroken token instead of widening", () => {
    expect(globals).toContain(".bubble{max-width:100%;min-width:0;overflow-wrap:anywhere;word-break:break-word;");
    expect(globals).toContain(".message-stack{min-width:0;max-width:min(78%,650px)");
  });
});
