import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { WORDS } from "./words";

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;
const SALT_LEN = 16;

function masterKey(): Buffer | null {
  const raw = process.env.MONSOON_MASTER_KEY ?? "";
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function masterKeyConfigured(): boolean {
  return masterKey() !== null;
}

export function encryptSecret(plain: string, customerId: string, field: string): string {
  const key = masterKey();
  if (!key) throw new Error("Master key not configured");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${customerId}|${field}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["k1", nonce, ct, tag].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptSecret(stored: string, customerId: string, field: string): string {
  try {
    const key = masterKey();
    if (!key) throw new Error();
    const parts = stored.split(".");
    if (parts.length !== 4 || parts[0] !== "k1") throw new Error();
    const nonce = Buffer.from(parts[1], "base64url");
    const ct = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`${customerId}|${field}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt");
  }
}

function derive(p: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(p.normalize("NFKC"), salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPasscode(p: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await derive(p, salt);
  return `s1.${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

export async function verifyPasscode(p: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split(".");
    if (parts.length !== 3 || parts[0] !== "s1") return false;
    const salt = Buffer.from(parts[1], "base64url");
    const expected = Buffer.from(parts[2], "base64url");
    if (salt.length !== SALT_LEN || expected.length !== KEY_LEN) return false;
    return timingSafeEqual(await derive(p, salt), expected);
  } catch {
    return false;
  }
}

// A valid hash of a random value, so unknown company codes cost the same work.
const dummySalt = randomBytes(SALT_LEN);
export const DUMMY_PASSCODE_HASH: string = `s1.${dummySalt.toString("base64url")}.${randomBytes(KEY_LEN).toString("base64url")}`;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generatePasscode(): string {
  return Array.from({ length: 5 }, () => WORDS[randomInt(WORDS.length)]).join("-");
}

export function hashAddress(ip: string): string {
  return createHmac("sha256", process.env.MONSOON_SESSION_SECRET ?? "").update(ip).digest("hex");
}
