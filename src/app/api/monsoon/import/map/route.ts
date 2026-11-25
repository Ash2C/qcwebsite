import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { invalid, logFailure, readObject } from "@/lib/monsoon/import/http";
import { MAX_SAMPLE_ROWS, claudeMapping } from "@/lib/monsoon/import/map-ai";
import { knownMapping, validateMapping, type Mapping } from "@/lib/monsoon/import/mapping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 131_072;
const MAX_COLUMNS = 200;

const isText = (v: unknown): v is string => typeof v === "string";

/**
 * Which column of an uploaded file holds which Monsoon field. A standard export is recognised in
 * code. Anything else gets one Claude call (one AI use) on the headings and up to five sample rows.
 * When Claude cannot be used or fails, the answer is `none` and the person maps the columns by hand.
 */
export async function POST(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readObject(request, MAX_BODY);
  if (!read.ok) return read.response;
  const { headers, samples } = read.body;
  if (!Array.isArray(headers) || headers.length === 0 || headers.length > MAX_COLUMNS || !headers.every(isText)) {
    return invalid("headers must be 1 to 200 strings");
  }
  if (
    !Array.isArray(samples) ||
    samples.length > MAX_SAMPLE_ROWS ||
    !samples.every((row) => Array.isArray(row) && row.length <= MAX_COLUMNS && row.every(isText))
  ) {
    return invalid("samples must be at most 5 rows of strings");
  }

  const known = knownMapping(headers);
  if (known) return NextResponse.json({ mapping: known, source: "known" });

  let mapping: Mapping | null = null;
  try {
    await account.beginAi("import"); // one AI use
    const proposed = await claudeMapping(account.anthropic({ timeout: 25_000 }), headers, samples as string[][]);
    await account.noteClaude();
    mapping = validateMapping(proposed, headers.length);
  } catch (err) {
    // No key, a paused trial, a refused key, a busy Claude: the columns can still be chosen by hand.
    logFailure("import map failed", err);
    await account.noteClaude(err);
  }
  return NextResponse.json({ mapping, source: mapping ? "claude" : "none" });
}
