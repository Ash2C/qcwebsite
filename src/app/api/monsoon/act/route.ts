import { NextResponse } from "next/server";
import { addNote, moveStage } from "@/lib/monsoon/ask/actions";
import { verifyProposal } from "@/lib/monsoon/ask/proposal";
import { vocabulary } from "@/lib/monsoon/ask/queries";
import { requireSession } from "@/lib/monsoon/auth";
import { readJson } from "@/lib/monsoon/body";
import { withEstateDb } from "@/lib/monsoon/db";
import { applyDetails, DETAIL_LABELS } from "@/lib/monsoon/details";
import { estateByKey } from "@/lib/monsoon/estates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 65_536;
const MAX_NOTE = 2000;
// The member foreign key on touches (unnamed in the schema, so Postgres names it this). A 23503 on
// any other constraint, such as the by_whom owner reference, is not a missing contact.
const MEMBER_FK = "touches_member_id_fkey";

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  const body = read.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Invalid body");
  const b = body as Record<string, unknown>;

  const estate = estateByKey(b.estate);
  if (!estate) return bad("Unknown estate");

  const proposal = b.proposal;
  if (!verifyProposal(proposal, b.signature, Date.now()) || proposal.estate !== estate.key) {
    return NextResponse.json({ error: "This change has expired. Ask again." }, { status: 403 });
  }

  let text = "";
  if (proposal.kind === "add_note") {
    text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) return bad("Note text is required");
    if (text.length > MAX_NOTE) return bad("Note is too long");
  }

  try {
    const result = await withEstateDb(estate, async (db) => {
      if (proposal.kind === "add_note") {
        try {
          const { status } = await addNote(db, proposal.memberId, text);
          return { status, message: `Done. Note added to ${proposal.memberName}.` };
        } catch (err) {
          // The contact was removed after the change was offered: a violation of the member foreign
          // key, not an outage. Any other foreign-key violation is rethrown.
          const e = err as { code?: unknown; constraint?: unknown };
          if (e?.code === "23503" && e.constraint === MEMBER_FK) {
            return { status: "missing" as const, message: `${proposal.memberName} is no longer on the pipeline; nothing changed.` };
          }
          throw err;
        }
      }
      if (proposal.kind === "update_details") {
        const done = await applyDetails(db, proposal);
        const labels = (fields: string[]) => fields.map((f) => DETAIL_LABELS[f as keyof typeof DETAIL_LABELS]).join(", ");
        const messages = {
          updated: `Done. ${done.name} updated.`,
          partly: `Updated ${labels(done.written)}. ${labels(done.skipped)} changed in the meantime and was left alone.`,
          unchanged: `Nothing changed. ${done.name} was already up to date.`,
          missing: `${proposal.targetName} is no longer on file; nothing changed.`,
          unlogged: `${proposal.targetName} is no longer on the pipeline, so the change could not be logged; nothing changed.`,
          collision: `Another ${done.name} is already on file there; nothing changed.`,
        };
        return { status: done.status, message: messages[done.status] };
      }
      const { stages } = await vocabulary(db);
      const label = (key: string | null) => stages.find((s) => s.key === key)?.label ?? key ?? "";
      const who = proposal.memberName;
      const moved = await moveStage(db, proposal.memberId, proposal.fromStage, proposal.toStage);
      const messages = {
        moved: `Done. ${who} moved to ${label(proposal.toStage)}.`,
        already: `${who} is already in ${label(proposal.toStage)}; nothing changed.`,
        changed: `${who} is now in ${label(moved.stage)}; nothing changed.`,
        missing: `${who} is no longer on the pipeline; nothing changed.`,
      };
      return { status: moved.status, message: messages[moved.status] };
    });
    return NextResponse.json(result);
  } catch (err) {
    // Name and code only: the message can carry connection details or note text.
    console.error(
      `monsoon: act failed for ${estate.key}`,
      err instanceof Error ? err.name : "error",
      (err as { code?: string })?.code ?? "",
    );
    return NextResponse.json({ error: `Could not reach the ${estate.label} CRM` }, { status: 502 });
  }
}
