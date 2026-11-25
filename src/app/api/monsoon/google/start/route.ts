// Starts Sign in with Google: gives this browser a one-time nonce cookie and sends it to Google with
// a signed state carrying the same nonce. With ?link=1 a signed-in person is linking their Google
// account, and that person (from the session, never from the request) goes into the signed state,
// with the session number they are signed in under: a seat reset before they return makes it stale.
import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { SESSION_COOKIE, cookieValue, verifySession } from "@/lib/monsoon/auth";
import {
  GOOGLE_COOKIE_PATH,
  GOOGLE_NONCE_COOKIE,
  GOOGLE_STATE_SECONDS,
  authUrl,
  googleConfigured,
  newNonce,
  signState,
  type GoogleLink,
} from "@/lib/monsoon/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!googleConfigured()) {
    return NextResponse.json({ error: "Sign in with Google is not available" }, { status: 503 });
  }

  let link: GoogleLink | undefined;
  if (new URL(request.url).searchParams.get("link") === "1") {
    const auth = await requireAccount(request);
    if (!auth.ok) return auth.response;
    // The account was loaded from this same cookie, and only when its session number is the current one.
    const claims = verifySession(cookieValue(request, SESSION_COOKIE));
    if (!claims || claims.customerId !== auth.account.customer.id || claims.personId !== auth.account.person.id) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    link = { customerId: auth.account.customer.id, personId: auth.account.person.id, sessionNo: claims.sessionNo };
  }

  const nonce = newNonce();
  const state = signState(link ? { nonce, link } : { nonce });
  // The address is built from configuration only; nothing in the request reaches it.
  const response = new NextResponse(null, {
    status: 302,
    headers: { Location: authUrl(state), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
  // Lax, so it comes back on the top-level return from Google; scoped to the two Google routes.
  response.cookies.set(GOOGLE_NONCE_COOKIE, nonce, {
    path: GOOGLE_COOKIE_PATH,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: GOOGLE_STATE_SECONDS,
  });
  return response;
}
