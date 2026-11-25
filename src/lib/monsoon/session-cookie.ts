// The session cookie, set the same way by every route that signs someone in (the passcode route and
// the Google callback), and the caller's network address as the sign-in limits see it.
import type { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_SECONDS, signSession, type SessionClaims } from "./auth";

const BASE = { path: "/", httpOnly: true, secure: true, sameSite: "strict" } as const;

/** Signs the person in: `monsoon_session`, SameSite strict, about six months. */
export function setSessionCookie(response: NextResponse, claims: SessionClaims): void {
  response.cookies.set(
    SESSION_COOKIE,
    signSession({ customerId: claims.customerId, personId: claims.personId, sessionNo: claims.sessionNo }),
    { ...BASE, maxAge: SESSION_SECONDS },
  );
}

/** Signs the browser out. */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", { ...BASE, maxAge: 0 });
}

// Vercel sets x-real-ip and the client cannot forge it; x-forwarded-for can carry client-supplied entries.
export function networkAddress(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}
