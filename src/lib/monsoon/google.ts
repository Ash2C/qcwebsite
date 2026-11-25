// Sign in with Google: the signed `state`, the address the browser is sent to, and the one call
// Monsoon makes to Google (exchanging the code for who the person is). One fixed host, a redirect
// is refused, eight seconds, no retry. Nothing here throws on a bad reply and nothing is logged:
// Google's reply carries tokens. The redirect address comes from configuration, never from a request.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { accountsConfigured } from "./auth";

export const GOOGLE_NONCE_COOKIE = "monsoon_g";
/** The nonce cookie is sent only to the two Google routes. */
export const GOOGLE_COOKIE_PATH = "/api/monsoon/google";
export const GOOGLE_STATE_SECONDS = 600;
export const GOOGLE_TIMEOUT_MS = 8000;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SCOPE = "openid email profile";

const MIN_SECRET = 32;
// A session is signed over its bare payload; a state is signed over this prefix plus its payload,
// and has another shape (five parts, `g1`), so neither can ever pass as the other.
const STATE_PREFIX = "google-state:";
const STATE_VERSION = "g1";
const NO_LINK = "-";
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GOOGLE_SUB = /^\d{1,64}$/;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}$/;
const MAX_STATE = 400;
const MAX_CODE = 2048;
const MAX_EMAIL = 320;
const MAX_NAME = 200;
const MAX_REPLY_CHARS = 100_000;

export type GoogleLink = { customerId: string; personId: string };
export type GoogleState = { nonce: string; link?: GoogleLink };
export type GoogleIdentity = { ok: true; sub: string; email: string; name: string } | { ok: false };

function secret(): string {
  return process.env.MONSOON_SESSION_SECRET ?? "";
}

/** The fixed callback address, or null unless it is an https address (http only on localhost). */
function redirectUri(): string | null {
  const raw = process.env.MONSOON_GOOGLE_REDIRECT_URI ?? "";
  if (!raw || raw.length > 500) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.hash || url.username || url.password) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * True with the three Google settings and the accounts settings present: enough to sign in with
 * Google and to link a Google account. With any missing, Sign in with Google is off.
 */
export function googleConfigured(): boolean {
  return (
    accountsConfigured() &&
    !!process.env.MONSOON_GOOGLE_CLIENT_ID &&
    !!process.env.MONSOON_GOOGLE_CLIENT_SECRET &&
    redirectUri() !== null
  );
}

/**
 * True when new requests can be taken and approved: Sign in with Google is on and the shared
 * database's owner address is set. Only its presence is looked at here; it is never read.
 */
export function signupsConfigured(): boolean {
  return googleConfigured() && !!process.env.MONSOON_SHARED_DB_ADMIN_URL;
}

/** A fresh per-browser nonce: 32 random bytes. */
export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison of the state's nonce with the browser's cookie. False unless both are nonces. */
export function sameNonce(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !NONCE.test(a) || !NONCE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function stateHmac(payload: string): string {
  return createHmac("sha256", secret()).update(STATE_PREFIX + payload).digest("hex");
}

/** `g1.<nonce>.<expiry>.<customer~person or ->.<hmac>`; good for ten minutes. Throws on a malformed payload. */
export function signState(payload: GoogleState, nowMs: number = Date.now()): string {
  if (secret().length < MIN_SECRET) throw new Error("Monsoon is not configured");
  if (!NONCE.test(payload.nonce)) throw new Error("malformed nonce");
  let link = NO_LINK;
  if (payload.link) {
    if (!UUID.test(payload.link.customerId) || !UUID.test(payload.link.personId)) throw new Error("malformed link");
    link = `${payload.link.customerId}~${payload.link.personId}`;
  }
  const expiry = Math.floor(nowMs / 1000) + GOOGLE_STATE_SECONDS;
  const body = `${STATE_VERSION}.${payload.nonce}.${expiry}.${link}`;
  return `${body}.${stateHmac(body)}`;
}

/** The state's payload, or null for anything not signed here, tampered with, or older than ten minutes. */
export function verifyState(state: string | null | undefined, nowMs: number = Date.now()): GoogleState | null {
  try {
    if (typeof state !== "string" || state.length > MAX_STATE || secret().length < MIN_SECRET) return null;
    const parts = state.split(".");
    if (parts.length !== 5) return null;
    const [version, nonce, expiry, link, signature] = parts;
    if (version !== STATE_VERSION || !NONCE.test(nonce) || !/^\d{1,12}$/.test(expiry)) return null;
    if (!/^[0-9a-f]{64}$/.test(signature)) return null;
    const expected = Buffer.from(stateHmac(parts.slice(0, 4).join(".")), "hex");
    const actual = Buffer.from(signature, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const left = Number(expiry) * 1000 - nowMs;
    if (left <= 0 || left > GOOGLE_STATE_SECONDS * 1000) return null;
    if (link === NO_LINK) return { nonce };
    const ids = link.split("~");
    if (ids.length !== 2 || !UUID.test(ids[0]) || !UUID.test(ids[1])) return null;
    return { nonce, link: { customerId: ids[0], personId: ids[1] } };
  } catch {
    return null;
  }
}

/** Where the browser is sent to sign in. Call only when `googleConfigured()`. */
export function authUrl(state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", process.env.MONSOON_GOOGLE_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", redirectUri() ?? "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  // Always let the person pick the account: linking the wrong one cannot be undone in the app.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The claims of an id token that came straight from Google's token address over TLS, or null. */
function idClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length > MAX_REPLY_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  return isObj(claims) ? claims : null;
}

function displayName(raw: unknown, email: string): string {
  const clean = (v: string) =>
    v
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME)
      .trim();
  const name = typeof raw === "string" ? clean(raw) : "";
  return name || clean(email.split("@")[0]) || "Monsoon user";
}

/**
 * Exchanges the code Google sent the browser back with for who the person is. One request, no
 * retry. Requires the id token to be for this app, from Google, unexpired, with a verified email
 * and a numeric account id. Resolves `{ ok: false }` for anything else; never rejects, never logs.
 */
export async function exchangeCode(code: string): Promise<GoogleIdentity> {
  const failed: GoogleIdentity = { ok: false };
  try {
    if (typeof code !== "string" || code.length > MAX_CODE || !/^[\x21-\x7e]+$/.test(code)) return failed;
    const clientId = process.env.MONSOON_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.MONSOON_GOOGLE_CLIENT_SECRET;
    const redirect = redirectUri();
    if (!clientId || !clientSecret || !redirect) return failed;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        grant_type: "authorization_code",
      }).toString(),
      // A redirect could carry the client secret to another host: refuse to follow one.
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      // The refusal's body is never read: it is not needed and must not be logged.
      void res.body?.cancel().catch(() => undefined);
      return failed;
    }
    const text = await res.text();
    if (text.length > MAX_REPLY_CHARS) return failed;
    const reply: unknown = JSON.parse(text);
    if (!isObj(reply)) return failed;
    const claims = idClaims(reply.id_token);
    if (!claims) return failed;
    if (claims.aud !== clientId) return failed;
    if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return failed;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return failed;
    if (claims.email_verified !== true) return failed;
    if (typeof claims.sub !== "string" || !GOOGLE_SUB.test(claims.sub)) return failed;
    if (typeof claims.email !== "string" || claims.email.length > MAX_EMAIL || !EMAIL.test(claims.email)) return failed;
    return { ok: true, sub: claims.sub, email: claims.email, name: displayName(claims.name, claims.email) };
  } catch {
    // Timeout, network, a refused redirect or a reply that is not what Google sends. Dropped unread.
    return failed;
  }
}
