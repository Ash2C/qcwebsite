import { NextResponse } from "next/server";
import { requireSession } from "@/lib/monsoon/auth";
import { getProfile } from "@/lib/monsoon/contacts";
import { withEstateDb } from "@/lib/monsoon/db";
import { estateByKey } from "@/lib/monsoon/estates";
import { resolveToday } from "@/lib/monsoon/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ID_KEYS = ["memberId", "personId", "orgId"] as const;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const denied = requireSession(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const estate = estateByKey(params.get("estate"));
  if (!estate) return NextResponse.json({ error: "Unknown estate" }, { status: 400 });

  const given = ID_KEYS.filter((k) => (params.get(k) ?? "") !== "");
  if (given.length !== 1) return NextResponse.json({ error: "Give exactly one id" }, { status: 400 });
  const target = { [given[0]]: params.get(given[0]) as string };
  const today = resolveToday(params.get("today"), startedAt);

  try {
    const profile = await withEstateDb(estate, (db) => getProfile(db, target, today));
    if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ profile });
  } catch (err) {
    // Name and code only: the message can carry connection details or contact data.
    console.error(
      `monsoon: contact failed for ${estate.key}`,
      err instanceof Error ? err.name : "error",
      (err as { code?: string })?.code ?? "",
    );
    return NextResponse.json({ error: `Could not reach the ${estate.label} CRM` }, { status: 502 });
  }
}
