import { Suspense } from "react";
import AppShell from "@/components/shell/AppShell";

/**
 * The shell's route.
 *
 * Thin on purpose. Everything Afterglow does outside a creation, world or
 * editor page happens inside one client component, and the only job here is to
 * give that component a Suspense boundary.
 *
 * That boundary is load-bearing rather than decorative. The shell reads its
 * route from the query string — which surface, which creation, which story —
 * and a client component may only call `useSearchParams` beneath a boundary,
 * because the server has no query string to render with. What the rule buys is
 * exactly what the sprint asked for: the server renders the fallback below,
 * the browser renders the shell with the real address already in hand, and
 * there is no first frame in which the app is showing the wrong section of
 * itself. The Studio no longer flashes on the way into a chat because the shell
 * never renders a state that does not know it is opening one.
 *
 * The fallback is deliberately the app's own boot screen and not a spinner: it
 * is what a cold load has always shown, and it is replaced within a frame of
 * the bundle running.
 */
export default function AfterglowPage() {
  return <Suspense fallback={<AppBoot />}>
    <AppShell />
  </Suspense>;
}

function AppBoot() {
  return <div className="splash">
    <div className="logo"><span className="logo-mark">A</span><span>Afterglow</span></div>
    <div className="pulse" />
  </div>;
}
