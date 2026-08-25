import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase session on every navigation.
 *
 * Without this the access token expires mid-session and server components stop
 * recognising the account. Route protection itself is enforced in each route
 * handler against a revalidated user, never here alone — middleware runs before
 * the handler but is not the security boundary.
 *
 * API routes are deliberately EXCLUDED below. Every one of them resolves the
 * caller through `currentAccount()`, which verifies the token and refreshes an
 * expiring session itself, so running this first meant every request in the
 * product verified the same token twice — two round trips where the second
 * could never disagree with the first. Route handlers may write cookies, so
 * the refresh still lands; nothing about the security boundary moves.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(items) {
        for (const { name, value } of items) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of items) response.cookies.set(name, value, options);
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: [
    // Navigations only. API routes verify and refresh for themselves, and
    // static assets carry no session.
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
