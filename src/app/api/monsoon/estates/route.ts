import { NextResponse } from "next/server";
import { requireSession } from "@/lib/monsoon/auth";
import { withEstateDb } from "@/lib/monsoon/db";
import { ESTATES } from "@/lib/monsoon/estates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Role = { key: string; label: string };

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

  const estates = await Promise.all(
    ESTATES.map(async (estate) => {
      const base = {
        key: estate.key,
        label: estate.label,
        defaultRole: estate.defaultRole,
      };
      try {
        const roles = await withEstateDb(estate, async (db) => {
          const r = await db.query("SELECT key, label FROM roles ORDER BY key");
          return r.rows as Role[];
        });
        return { ...base, available: true, roles };
      } catch (err) {
        // Name and code only: the message can carry connection details.
        console.error(
          `monsoon: could not list roles for ${estate.key}`,
          err instanceof Error ? err.name : "error",
          (err as { code?: string })?.code ?? ""
        );
        return { ...base, available: false, roles: [] as Role[] };
      }
    })
  );

  return NextResponse.json({ estates });
}
