import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { recentContacts, searchContacts } from "@/lib/monsoon/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MIN_QUERY = 2;
const MAX_QUERY = 100;

export async function GET(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const params = new URL(request.url).searchParams;
  const estate = account.pipeline(params.get("estate"));
  if (!estate) return NextResponse.json({ error: "Unknown estate" }, { status: 400 });
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY);

  try {
    const contacts = await account.withDb(estate.key, (db) => (q.length >= MIN_QUERY ? searchContacts(db, q) : recentContacts(db)));
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
