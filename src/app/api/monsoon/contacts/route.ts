import { NextResponse } from "next/server";
import { requireSession } from "@/lib/monsoon/auth";
import { recentContacts, searchContacts } from "@/lib/monsoon/contacts";
import { withEstateDb } from "@/lib/monsoon/db";
import { estateByKey } from "@/lib/monsoon/estates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MIN_QUERY = 2;

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const estate = estateByKey(params.get("estate"));
  if (!estate) return NextResponse.json({ error: "Unknown estate" }, { status: 400 });
  const q = (params.get("q") ?? "").trim();

  try {
    const contacts = await withEstateDb(estate, (db) => (q.length >= MIN_QUERY ? searchContacts(db, q) : recentContacts(db)));
    return NextResponse.json({ contacts });
  } catch (err) {
    // Name and code only: the message can carry connection details or contact data.
    console.error(
      `monsoon: contacts failed for ${estate.key}`,
      err instanceof Error ? err.name : "error",
      (err as { code?: string })?.code ?? "",
    );
    return NextResponse.json({ error: `Could not reach the ${estate.label} CRM` }, { status: 502 });
  }
}
