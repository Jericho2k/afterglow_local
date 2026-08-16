import { NextResponse } from "next/server";
import { safeEqual, sessionCookie, sessionToken } from "@/lib/auth";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export async function POST(request: Request) {
  const limited = checkRateLimit(`login:${clientIp(request)}`, 10, 10 * 60_000);
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const expected = process.env.APP_PASSWORD;
  if (!expected && process.env.NODE_ENV !== "production") {
    const response = NextResponse.json({ ok: true });
    response.cookies.set(sessionCookie.name, sessionToken(), sessionCookie.options);
    return response;
  }
  if (!expected || typeof body.password !== "string" || !safeEqual(body.password, expected)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return Response.json({ error: "Incorrect password" }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, sessionToken(), sessionCookie.options);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, "", { ...sessionCookie.options, maxAge: 0 });
  return response;
}
