import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { claudeFailureResponse } from "@/lib/monsoon/claude-failure";
import { readJson } from "@/lib/monsoon/body";
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

const MAX_BODY = 32_768;

const KEYS: (keyof ContactFields)[] = ["name", "title", "org", "email", "phone", "linkedin"];

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  const body = read.body;
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
    const out = await refineContact(account.anthropic({ timeout: 25_000 }), account.model(), {
      fields,
      notes: b.notes,
      spoken: b.spoken,
    });
    await account.noteClaude();
    await account.record("tidy");
    return NextResponse.json(out);
  } catch (err) {
    // Error name only: never the dictated text, the notes or any field value.
    const status = (err as { status?: unknown })?.status;
    console.error(
      "monsoon: refine failed",
      err instanceof Error ? err.name : "error",
      typeof status === "number" ? status : "",
    );
    await account.noteClaude(err);
    return claudeFailureResponse(err) ?? NextResponse.json({ error: "Could not tidy the notes" }, { status: 502 });
  }
}
