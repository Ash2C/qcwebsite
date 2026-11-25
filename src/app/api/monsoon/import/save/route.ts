import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { withImportLock } from "@/lib/monsoon/import/guard";
import { invalid, logFailure, readObject } from "@/lib/monsoon/import/http";
import { cleanContact, type ImportContact } from "@/lib/monsoon/import/mapping";
import { ImportInputError, cleanLabel, noteCompanyImports, saveImportRows } from "@/lib/monsoon/import/save";
import { ensureOwner } from "@/lib/monsoon/owners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 262_144;
const MAX_ROWS = 100;
const MAX_ROW_NUMBER = 10_000_000;
// No row is started after this long, so the answer is sent well inside maxDuration. Rows not
// started come back as `failed` and can be sent again.
const BUDGET_MS = 45_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Saves one batch of an import: up to 100 rows, each with its row number in the file. A row sent
 * again (same importId and row number) is answered with what happened the first time. One import
 * runs per person at a time: a second request while one is running answers 409. The request that
 * carries `first: true` records the import as one activity.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readObject(request, MAX_BODY);
  if (!read.ok) return read.response;
  const b = read.body;
  const estate = account.pipeline(b.pipeline);
  if (!estate) return invalid("Unknown pipeline");
  if (typeof b.importId !== "string" || !UUID_RE.test(b.importId)) return invalid("importId must be a UUID");
  const label = cleanLabel(b.label);
  if (label === "") return invalid("label is required");
  if (typeof b.role !== "string") return invalid("role must be a string");
  if (typeof b.includePossible !== "boolean") return invalid("includePossible must be true or false");
  if (!Array.isArray(b.rows) || b.rows.length === 0 || b.rows.length > MAX_ROWS) return invalid("rows must be a list of 1 to 100");

  const rows: { rowNumber: number; contact: ImportContact | null }[] = [];
  const seen = new Set<number>();
  for (const raw of b.rows as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalid("each row must be an object");
    const { rowNumber, contact } = raw as { rowNumber?: unknown; contact?: unknown };
    if (typeof rowNumber !== "number" || !Number.isInteger(rowNumber) || rowNumber < 0 || rowNumber > MAX_ROW_NUMBER) {
      return invalid("rowNumber must be a whole number");
    }
    if (seen.has(rowNumber)) return invalid("rowNumber must not repeat");
    seen.add(rowNumber);
    if (contact !== null && contact !== undefined && (typeof contact !== "object" || Array.isArray(contact))) {
      return invalid("contact must be an object or null");
    }
    rows.push({ rowNumber, contact: cleanContact(contact) });
  }

  const owner = account.person.ownerKey;
  try {
    // The guard holds a connection of its own for as long as the batch runs.
    const guarded = await account.withDb(estate.key, (guardDb) =>
      withImportLock(guardDb, account.person.id, () =>
        account.withDb(estate.key, async (db) => {
          // The owner key may never have reached this CRM, as in the save route.
          await ensureOwner(db, owner, account.person.name);
          const results = await saveImportRows(
            db,
            { importId: b.importId as string, label, role: b.role as string, owner, includePossible: b.includePossible as boolean, rows },
            { deadline: started + BUDGET_MS },
          );
          try {
            await noteCompanyImports(db, { label, owner, results });
          } catch (err) {
            // The rows are saved; a missing summary entry must not turn them into a failure.
            logFailure(`import company note failed for ${estate.key}`, err);
          }
          return results;
        }),
      ),
    );
    if (!guarded.locked) return NextResponse.json({ error: "import_running" }, { status: 409 });
    if (b.first === true) await account.record("batch_save", estate.key);
    return NextResponse.json({ results: guarded.value.map((r) => ({ rowNumber: r.rowNumber, outcome: r.outcome })) });
  } catch (err) {
    if (err instanceof ImportInputError) return invalid(err.message);
    logFailure(`import save failed for ${estate.key}`, err);
    return NextResponse.json({ error: `Could not reach the ${estate.label} CRM` }, { status: 502 });
  }
}
