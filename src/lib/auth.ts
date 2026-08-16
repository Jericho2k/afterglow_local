import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "afterglow_session";

function secret() {
  const value = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!value || value.length < 32)) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production");
  }
  return value || "development-only-session-secret-change-me";
}

export function sessionToken() {
  return createHmac("sha256", secret()).update("afterglow:owner:v1").digest("hex");
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function isAuthenticated() {
  const password = process.env.APP_PASSWORD;
  if (!password && process.env.NODE_ENV !== "production") return true;
  const token = (await cookies()).get(COOKIE)?.value ?? "";
  return safeEqual(token, sessionToken());
}

export async function requireAuth() {
  if (!(await isAuthenticated())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export const sessionCookie = {
  name: COOKIE,
  options: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  },
};
