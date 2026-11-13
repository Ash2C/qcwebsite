import { NextResponse } from "next/server";
import { requireSession } from "@/lib/monsoon/auth";
import {
  MAX_FIELD,
  MAX_NOTES,
  MAX_SPOKEN,
  refineContact,
  type ContactFields,
} from "@/lib/monsoon/refine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const KEYS: (keyof ContactFields)[] = ["name", "title", "org", "email", "phone", "linkedin"];

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Invalid body");
  const b = body as Record<string, unknown>;
  const f = b.fields;
  if (typeof f !== "object" || f === null || Array.isArray(f)) return bad("fields must be an object");
  const raw = f as Record<string, unknown>;
  const fields = {} as ContactFields;
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v !== "string") return bad(`${k} must be a string`);
    fields[k] = v;
  }
  if (typeof b.notes !== "string") return bad("notes must be a string");
  if (typeof b.spoken !== "string") return bad("spoken must be a string");
  if (b.spoken.trim() === "") return bad("Nothing to tidy");
  if (b.spoken.length > MAX_SPOKEN) return bad("Too long");
  if (KEYS.some((k) => fields[k].length > MAX_FIELD) || b.notes.length > MAX_NOTES) {
    return bad("Field too long");
  }

  try {
    const out = await refineContact({ fields, notes: b.notes, spoken: b.spoken });
    return NextResponse.json(out);
  } catch (err) {
    // Error name only: never the dictated text, the notes or any field value.
    const status = (err as { status?: unknown })?.status;
    console.error(
      "monsoon: refine failed",
      err instanceof Error ? err.name : "error",
      typeof status === "number" ? status : "",
    );
    return NextResponse.json({ error: "Could not tidy the notes" }, { status: 502 });
  }
}
