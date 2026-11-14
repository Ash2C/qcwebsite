import { recordAlphaSignup } from "@/lib/monsoon/alpha";
import { readJson } from "@/lib/monsoon/body";
import { withEstateDb } from "@/lib/monsoon/db";
import { estateByKey } from "@/lib/monsoon/estates";

// Public route behind the quantcloud.com home page: saves a Monsoon alpha sign-up to the Zero One CRM.
// No session (visitors are not signed in), so it is kept narrow: same-site origin only, a small body,
// a hidden honeypot field, a strict email check, and an answer that never says whether the email was
// already on file.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 2_048;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ALLOWED_ORIGIN = /^(https:\/\/(www\.)?quantcloud\.com|http:\/\/localhost(:\d+)?)$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Paused 2026-11-13 until email and phone verification are built: nothing is saved.
const SIGNUPS_OPEN = false;

export async function POST(request: Request): Promise<Response> {
  if (!SIGNUPS_OPEN) return json({ error: "Sign-ups open soon." }, 503);
  const origin = request.headers.get("origin");
  if (origin !== null && !ALLOWED_ORIGIN.test(origin)) return json({ error: "Not allowed" }, 403);

  const read = await readJson(request, MAX_BYTES);
  if (!read.ok) return read.response;
  const body = read.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Enter a valid email address." }, 400);
  }
  const input = body as Record<string, unknown>;

  // Bots fill every field; people never see this one.
  if (typeof input.website === "string" && input.website.trim() !== "") return json({ ok: true });

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);

  const estate = estateByKey("zeroone");
  if (!estate) return json({ error: "Could not save your email. Try again in a moment." }, 502);
  try {
    await withEstateDb(estate, (db) => recordAlphaSignup(db, email));
    return json({ ok: true });
  } catch (err) {
    const e = err as { name?: unknown; code?: unknown };
    const code = typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined;
    console.error("monsoon: alpha sign-up failed", typeof e?.name === "string" ? e.name : "Error", code ?? "");
    return json({ error: "Could not save your email. Try again in a moment." }, 502);
  }
}
