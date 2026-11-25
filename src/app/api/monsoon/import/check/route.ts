import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { classifyRows } from "@/lib/monsoon/import/classify";
import { invalid, logFailure, readObject } from "@/lib/monsoon/import/http";
import { cleanContact } from "@/lib/monsoon/import/mapping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 524_288;
const MAX_ROWS = 200;

/**
 * The summary before an import: for each row, is it new, already in Monsoon, a possible match, a
 * repeat of an earlier row, or unreadable (no name)? Read-only. The answer carries the class only,
 * never a name or an id from the CRM.
 */
export async function POST(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readObject(request, MAX_BODY);
  if (!read.ok) return read.response;
  const b = read.body;
  const estate = account.pipeline(b.pipeline);
  if (!estate) return invalid("Unknown pipeline");
  const rows = b.rows;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return invalid("rows must be a list of at most 200");
  if (!rows.every((r) => r === null || (typeof r === "object" && !Array.isArray(r)))) return invalid("each row must be a contact or null");
  if (rows.length === 0) return NextResponse.json({ classes: [] });
  const contacts = rows.map(cleanContact);

  try {
    const verdicts = await account.withDb(estate.key, (db) => classifyRows(db, contacts));
    return NextResponse.json({ classes: verdicts.map((v) => v.class) });
  } catch (err) {
    logFailure(`import check failed for ${estate.key}`, err);
    return NextResponse.json({ error: `Could not reach the ${estate.label} CRM` }, { status: 502 });
  }
}
