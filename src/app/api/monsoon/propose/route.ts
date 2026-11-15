import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { proposeNote, proposeStage } from "@/lib/monsoon/ask/actions";
import { readJson } from "@/lib/monsoon/body";
import { DETAIL_LABELS, proposeDetails, type DetailInput } from "@/lib/monsoon/details";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 16_384;
const KINDS = ["add_note", "move_stage", "update_details"];

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only string ids are kept; anything else in the target is a malformed body. */
function parseTarget(value: unknown): { memberId?: string; personId?: string; orgId?: string } | undefined {
  if (!isObj(value)) return undefined;
  const out: { memberId?: string; personId?: string; orgId?: string } = {};
  for (const key of ["memberId", "personId", "orgId"] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== "string") return undefined;
    out[key] = v;
  }
  return out;
}

function parseChanges(value: unknown): DetailInput | undefined {
  if (!isObj(value)) return undefined;
  const out: DetailInput = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(DETAIL_LABELS, key) || (v !== null && typeof v !== "string")) return undefined;
    out[key as keyof DetailInput] = v as string | null;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function POST(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  if (!isObj(read.body)) return bad("Invalid body");
  const b = read.body;

  const estate = account.pipeline(b.estate);
  if (!estate) return bad("Unknown estate");
  if (typeof b.kind !== "string" || !KINDS.includes(b.kind)) return bad("Unknown kind");
  const target = parseTarget(b.target);
  if (!target) return bad("Invalid target");

  let text = "";
  let stage = "";
  let changes: DetailInput | undefined;
  if (b.kind === "add_note") {
    if (typeof b.text !== "string") return bad("Invalid text");
    text = b.text;
  } else if (b.kind === "move_stage") {
    if (typeof b.stage !== "string") return bad("Invalid stage");
    stage = b.stage;
  } else {
    changes = parseChanges(b.changes);
    if (!changes) return bad("Invalid changes");
  }

  try {
    const nowMs = Date.now();
    // Bound to the signed-in customer; the body never names the customer.
    const bind = { customer: account.customer.id, estate: estate.key };
    const result = await account.withDb(estate.key, async (db) => {
      if (b.kind === "add_note") return proposeNote(db, bind, { memberId: target.memberId, personId: target.personId }, text, nowMs);
      if (b.kind === "move_stage") return proposeStage(db, bind, { memberId: target.memberId, personId: target.personId }, stage, nowMs);
      return proposeDetails(db, bind, target, changes as DetailInput, {
        nowMs,
        defaultRole: estate.defaultRole,
        newCompany: b.newCompany === true,
      });
    });
    return NextResponse.json(result);
  } catch (err) {
    // Name and code only: the message can carry connection details or contact data.
    console.error(
      `monsoon: propose failed for ${estate.key}`,
      err instanceof Error ? err.name : "error",
      (err as { code?: string })?.code ?? "",
    );
    return NextResponse.json({ error: `Could not reach the ${estate.label} CRM` }, { status: 502 });
  }
}
