import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "monsoon_session";
export const SESSION_SECONDS = 15552000;

const MIN_PASSCODE = 16;
const MIN_SECRET = 32;

function passcode(): string {
  return process.env.MONSOON_PASSCODE ?? "";
}

function secret(): string {
  return process.env.MONSOON_SESSION_SECRET ?? "";
}

export function authConfigured(): boolean {
  return passcode().length >= MIN_PASSCODE && secret().length >= MIN_SECRET;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function checkPasscode(candidate: string): boolean {
  if (!authConfigured() || typeof candidate !== "string") return false;
  return timingSafeEqual(sha256(candidate), sha256(passcode()));
}

function hmac(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function signSession(nowMs: number = Date.now()): string {
  const expiry = Math.floor(nowMs / 1000) + SESSION_SECONDS;
  const payload = `v1.${expiry}`;
  return `${payload}.${hmac(payload)}`;
}

export function verifySession(
  token: string | undefined,
  nowMs: number = Date.now()
): boolean {
  try {
    if (!token || secret().length < MIN_SECRET) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [version, expiry, signature] = parts;
    if (version !== "v1" || !/^\d+$/.test(expiry)) return false;
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;
    const expected = Buffer.from(hmac(`${version}.${expiry}`), "hex");
    const actual = Buffer.from(signature, "hex");
    if (expected.length !== actual.length) return false;
    if (!timingSafeEqual(expected, actual)) return false;
    return Number(expiry) * 1000 > nowMs;
  } catch {
    return false;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
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

export function requireSession(request: Request): Response | null {
  if (verifySession(cookieValue(request, SESSION_COOKIE))) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
