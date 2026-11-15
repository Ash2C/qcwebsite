import { createHmac, timingSafeEqual } from "node:crypto";
import { masterKeyConfigured } from "./accounts/crypto";

export const SESSION_COOKIE = "monsoon_session";
export const SESSION_SECONDS = 15552000;

const MIN_SECRET = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_NO = /^[1-9]\d{0,8}$/;

export type SessionClaims = { customerId: string; personId: string; sessionNo: number };

function secret(): string {
  return process.env.MONSOON_SESSION_SECRET ?? "";
}

/** Session secret of 32+ characters, a valid master key and an accounts database URL. */
export function accountsConfigured(): boolean {
  return secret().length >= MIN_SECRET && masterKeyConfigured() && !!process.env.MONSOON_ACCOUNTS_DATABASE_URL;
}

function hmac(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

function signatureMatches(payload: string, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(hmac(payload), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** `v2.<customer uuid>.<person uuid>.<session number>.<expiry>.<hmac>` */
export function signSession(c: SessionClaims, nowMs: number = Date.now()): string {
  const expiry = Math.floor(nowMs / 1000) + SESSION_SECONDS;
  const payload = `v2.${c.customerId}.${c.personId}.${c.sessionNo}.${expiry}`;
  return `${payload}.${hmac(payload)}`;
}

export function verifySession(token: string | undefined, nowMs: number = Date.now()): SessionClaims | null {
  try {
    if (!token || secret().length < MIN_SECRET) return null;
    const parts = token.split(".");
    if (parts.length !== 6) return null;
    const [version, customerId, personId, sessionNo, expiry, signature] = parts;
    if (version !== "v2" || !UUID.test(customerId) || !UUID.test(personId)) return null;
    if (!SESSION_NO.test(sessionNo) || !/^\d{1,12}$/.test(expiry)) return null;
    if (!signatureMatches(parts.slice(0, 5).join("."), signature)) return null;
    if (Number(expiry) * 1000 <= nowMs) return null;
    return { customerId, personId, sessionNo: Number(sessionNo) };
  } catch {
    return null;
  }
}

export function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}
