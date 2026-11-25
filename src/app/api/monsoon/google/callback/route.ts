// Where Google sends the browser back. The state must be one signed here in the last ten minutes
// AND carry the nonce this browser was given at the start (compared in constant time), so a
// callback address opened anywhere else does nothing. Only Google's permanent account id decides
// who this is; the email is never matched on. A pending or declined request never gets a session.
// Every answer is a 200 page that moves on to a fixed path (never a 302: the session cookie is
// SameSite strict and must be stored before the browser's next, same-site, request).
import { NextResponse } from "next/server";
import { cookieValue } from "@/lib/monsoon/auth";
import { hashAddress } from "@/lib/monsoon/accounts/crypto";
import {
  beginGoogleAttempt,
  findPersonByGoogleSub,
  findSignup,
  googleIdHeld,
  linkGoogle,
  requestSignup,
  settleGoogleAttempt,
} from "@/lib/monsoon/accounts/signups";
import { evictAccount, recordActivity } from "@/lib/monsoon/accounts/store";
import {
  GOOGLE_COOKIE_PATH,
  GOOGLE_NONCE_COOKIE,
  exchangeCode,
  googleConfigured,
  sameNonce,
  signupsConfigured,
  verifyState,
} from "@/lib/monsoon/google";
import { networkAddress, setSessionCookie } from "@/lib/monsoon/session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Every place this route can send the browser. Fixed strings: nothing from the request is added.
const TARGETS = {
  app: "/monsoon",
  received: "/monsoon/request?status=received",
  waiting: "/monsoon/request?status=waiting",
  declined: "/monsoon/request?status=declined",
  paused: "/monsoon/request?status=paused",
  taken: "/monsoon/request?status=taken",
  error: "/monsoon/request?status=error",
} as const;
type Target = keyof typeof TARGETS;

/** A 200 page that moves on to one of the fixed targets, and uses up the nonce cookie. */
function page(target: Target): NextResponse {
  const href = TARGETS[target].replace(/&/g, "&amp;");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${href}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>Monsoon</title></head>` +
    `<body><p><a href="${href}">Continue to Monsoon</a></p></body></html>`;
  const response = new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
  response.cookies.set(GOOGLE_NONCE_COOKIE, "", { path: GOOGLE_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "lax", maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  if (!googleConfigured()) {
    return NextResponse.json({ error: "Sign in with Google is not available" }, { status: 503 });
  }

  const query = new URL(request.url).searchParams;
  const state = verifyState(query.get("state"));
  if (!state || !sameNonce(state.nonce, cookieValue(request, GOOGLE_NONCE_COOKIE))) return page("error");
  const code = query.get("code");
  if (!code) return page("error");

  try {
    const addressHash = hashAddress(networkAddress(request));
    // Counted before Google is called, so one address cannot make Monsoon call Google without end.
    const attempt = await beginGoogleAttempt(addressHash);
    if (attempt === null) return page("error");

    const google = await exchangeCode(code);
    if (!google.ok) return page("error");
    await settleGoogleAttempt(attempt);

    // Linking comes first: the person is the one inside the signed state, and gets no new session.
    if (state.link) {
      const linked = await linkGoogle(state.link, google.sub);
      // A link started before the seat was reset is as good as one that ran out of time.
      if (linked === "expired") return page("error");
      return page(linked === "linked" ? "app" : "taken");
    }

    const found = await findPersonByGoogleSub(google.sub);
    if (found) {
      // A cached row may carry the session number from before a reset or resume.
      evictAccount(found.customer.id, found.person.id);
      await recordActivity({ customerId: found.customer.id, personId: found.person.id, pipelineKey: null, action: "sign_in" });
      const response = page("app");
      setSessionCookie(response, { customerId: found.customer.id, personId: found.person.id, sessionNo: found.person.sessionNo });
      return response;
    }

    // The Google id is on a person who is suspended, or whose customer is: no way in, and no request.
    if (await googleIdHeld(google.sub)) return page("declined");

    const signup = await findSignup(google.sub);
    if (signup) {
      if (signup.status === "pending") return page("waiting");
      if (signup.status === "declined") return page("declined");
      // Approved, yet no active person has this Google id.
      return page("error");
    }

    // Without the shared database nobody could be approved, so no request is taken.
    if (!signupsConfigured()) return page("paused");

    const asked = await requestSignup({ sub: google.sub, email: google.email, name: google.name, addressHash });
    if (asked === "created") return page("received");
    return page(asked === "paused" ? "paused" : "error");
  } catch (err) {
    // The class name only: a message can carry connection details, and nothing from Google is logged.
    console.error("monsoon: Google callback failed", err instanceof Error ? err.name : "error");
    return page("error");
  }
}
