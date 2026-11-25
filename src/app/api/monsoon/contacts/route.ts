import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { recentContacts, searchContacts } from "@/lib/monsoon/contacts";
import { listImported, listImports, listMembers, sortHits, withWork, SORTS, type Sort } from "@/lib/monsoon/sift";
import { resolveToday } from "@/lib/monsoon/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MIN_QUERY = 2;
const MAX_QUERY = 100;
const MAX_LABEL = 80;

/**
 * The Contacts list. `q` (2+ characters) searches; without it the pipeline is listed. `high=1`
 * keeps only high-priority members and `sort` orders the rows (`recent`, `next`, `last`, `stage`).
 * Every row carries `work`: its priority, next action and last action (null off the pipeline).
 *
 * The Imports filter: `imports=1` answers `{ imports }` instead, the bulk imports with their label
 * and count, newest first. `import=<label>` lists the contacts that came in with that import
 * (`high` and `sort` apply; `q` does not).
 */
export async function GET(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const params = new URL(request.url).searchParams;
  const estate = account.pipeline(params.get("estate"));
  if (!estate) return NextResponse.json({ error: "Unknown estate" }, { status: 400 });
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const high = params.get("high") === "1";
  const asked = params.get("sort");
  const sort: Sort = (SORTS as readonly string[]).includes(asked ?? "") ? (asked as Sort) : "recent";
  const today = resolveToday(params.get("today"), Date.now());
  const imports = params.get("imports") === "1";
  const label = (params.get("import") ?? "").trim().slice(0, MAX_LABEL).trim();

  try {
    const body = await account.withDb(estate.key, async (db) => {
      if (imports) return { imports: await listImports(db) };
      if (label !== "") return listImported(db, { label, high, sort, today });
      if (q.length >= MIN_QUERY) {
        // A search keeps its own order (best match first) unless a sort was asked for.
        const found = await withWork(db, await searchContacts(db, q), today);
        const kept = high ? found.filter((h) => h.work?.priority === "high") : found;
        return { contacts: sort === "recent" ? kept : sortHits(kept, sort), total: kept.length };
      }
      if (!high && sort === "recent") {
        const recent = await withWork(db, await recentContacts(db), today);
        return { contacts: recent, total: recent.length };
      }
      return listMembers(db, { high, sort, today });
    });
    return NextResponse.json(body);
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
