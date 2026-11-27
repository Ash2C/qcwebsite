import { NextResponse } from "next/server";
import { ensureOwner } from "@/lib/monsoon/owners";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import type { ActivityAction } from "@/lib/monsoon/accounts/store";
import { addNote, moveStage, setNextAction, setPriority, setRole } from "@/lib/monsoon/ask/actions";
import { verifyProposal, type Proposal } from "@/lib/monsoon/ask/proposal";
import { vocabulary } from "@/lib/monsoon/ask/queries";
import { carryOutTodo } from "@/lib/monsoon/ask/todo-actions";
import { resolveToday } from "@/lib/monsoon/today";
import { readJson } from "@/lib/monsoon/body";
import { applyDetails, DETAIL_LABELS } from "@/lib/monsoon/details";
import { applyResearch } from "@/lib/monsoon/research-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 65_536;
const MAX_NOTE = 2000;
const MAX_SUMMARY = 2000;
// The member foreign key on touches (unnamed in the schema, so Postgres names it this). A 23503 on
// any other constraint, such as the by_whom owner reference, is not a missing contact.
const MEMBER_FK = "touches_member_id_fkey";

const ACTIVITY: Record<Proposal["kind"], ActivityAction> = {
  add_note: "act_note",
  move_stage: "act_stage",
  // A priority change is a detail of the contact; the accounts activity log has no kind of its own for it.
  set_priority: "act_details",
  set_role: "act_details",
  set_next_action: "act_details",
  update_details: "act_details",
  apply_research: "act_research",
  add_todo: "act_details",
  complete_todo: "act_details",
  move_todo: "act_details",
  drop_todo: "act_details",
};

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  const body = read.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Invalid body");
  const b = body as Record<string, unknown>;

  const estate = account.pipeline(b.estate);
  if (!estate) return bad("Unknown estate");

  // Only a change offered to this customer, for one of its pipelines, and for the pipeline named here.
  const proposal = b.proposal;
  if (
    !verifyProposal(proposal, b.signature, Date.now()) ||
    proposal.customer !== account.customer.id ||
    !account.pipeline(proposal.estate) ||
    proposal.estate !== estate.key
  ) {
    return NextResponse.json({ error: "This change has expired. Ask again." }, { status: 403 });
  }
  let text = "";
  if (proposal.kind === "add_note") {
    text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) return bad("Note text is required");
    if (text.length > MAX_NOTE) return bad("Note is too long");
  }

  let ticked: string[] = [];
  if (proposal.kind === "apply_research") {
    const ids = proposal.findings.map((f) => f.id);
    const t = b.ticked;
    if (!Array.isArray(t) || !t.every((x) => typeof x === "string" && ids.includes(x)) || new Set(t).size !== t.length) {
      return bad("Invalid selection");
    }
    ticked = t as string[];
    if (b.text !== undefined && typeof b.text !== "string") return bad("Summary is too long");
    text = typeof b.text === "string" ? b.text.trim() : "";
    if (text.length > MAX_SUMMARY) return bad("Summary is too long");
    if (ticked.length === 0 && !text) return bad("Nothing selected");
    if (text && proposal.summarySources.length === 0) return bad("Nothing selected");
  }

  try {
    const owner = account.person.ownerKey;
    const result = await account.withDb(estate.key, async (db) => {
      // The owner key may never have reached this CRM (connected after sign-in, or that ensure failed).
      await ensureOwner(db, owner, account.person.name);
      if (proposal.kind === "add_note") {
        try {
          const { status } = await addNote(db, proposal.memberId, text, owner);
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
      if (proposal.kind === "add_todo" || proposal.kind === "complete_todo" || proposal.kind === "move_todo" || proposal.kind === "drop_todo") {
        return carryOutTodo(db, proposal, await account.viewer(), resolveToday(undefined, Date.now()));
      }
      if (proposal.kind === "apply_research") {
        const done = await applyResearch(db, proposal, ticked, text, owner);
        const messages = {
          saved: `Done. Research saved for ${done.name}.`,
          partly: `Saved ${done.written.length > 0 ? done.written.join(", ") : "the summary"}. ${done.skipped.join(", ")} changed in the meantime and ${done.skipped.length === 1 ? "was" : "were"} left alone.`,
          // Nothing written and no summary: either truly empty, or every ticked finding went stale.
          unchanged:
            done.skipped.length > 0
              ? `Nothing saved. ${done.skipped.join(", ")} changed in the meantime.`
              : `Nothing changed. ${done.name} was already up to date.`,
          missing: `${proposal.person.name} is no longer on file; nothing changed.`,
          unlogged: `${proposal.person.name} is no longer on the pipeline, so the research could not be logged; nothing changed.`,
        };
        return { status: done.status, message: messages[done.status] };
      }
      if (proposal.kind === "update_details") {
        const done = await applyDetails(db, proposal, owner);
        const labels = (fields: string[]) => fields.map((f) => DETAIL_LABELS[f as keyof typeof DETAIL_LABELS]).join(", ");
        const messages = {
          updated: `Done. ${done.name} updated.`,
          partly: `Updated ${labels(done.written)}. ${labels(done.skipped)} changed in the meantime and ${done.skipped.length === 1 ? "was" : "were"} left alone.`,
          unchanged: `Nothing changed. ${done.name} was already up to date.`,
          missing: `${proposal.targetName} is no longer on file; nothing changed.`,
          unlogged: `${proposal.targetName} is no longer on the pipeline, so the change could not be logged; nothing changed.`,
          collision: `Another ${done.name} is already on file there; nothing changed.`,
        };
        return { status: done.status, message: messages[done.status] };
      }
      if (proposal.kind === "set_next_action") {
        const who = proposal.memberName;
        const done = await setNextAction(
          db,
          proposal.memberId,
          { action: proposal.fromAction, date: proposal.fromDate },
          { action: proposal.toAction, date: proposal.toDate },
          owner,
        );
        const messages = {
          set: proposal.toAction ? `Done. Next action set for ${who}.` : `Done. Next action cleared for ${who}.`,
          already: `${who} already has that next action; nothing changed.`,
          changed: `The next action for ${who} changed in the meantime; nothing changed.`,
          missing: `${who} is no longer on the pipeline; nothing changed.`,
        };
        return { status: done.status, message: messages[done.status] };
      }
      if (proposal.kind === "set_role") {
        const who = proposal.memberName;
        const { roles } = await vocabulary(db);
        const label = (key: string | null) => roles.find((r) => r.key === key)?.label ?? key ?? "";
        const done = await setRole(db, proposal.memberId, proposal.fromRole, proposal.toRole, owner);
        const messages = {
          set: `Done. ${who} is now ${label(proposal.toRole)}.`,
          already: `${who} is already ${label(proposal.toRole)}; nothing changed.`,
          changed: `${who} is now ${label(done.role)}; nothing changed.`,
          missing: `${who} is no longer on the pipeline; nothing changed.`,
        };
        return { status: done.status, message: messages[done.status] };
      }
      if (proposal.kind === "set_priority") {
        const who = proposal.memberName;
        const done = await setPriority(db, proposal.memberId, proposal.fromPriority, proposal.toPriority, owner);
        const words = (v: string | null) => (v ? `${v} priority` : "without a priority");
        const messages = {
          set: `Done. ${who} is now ${words(proposal.toPriority)}.`,
          already: `${who} is already ${words(done.priority)}; nothing changed.`,
          changed: `${who} is now ${words(done.priority)}; nothing changed.`,
          missing: `${who} is no longer on the pipeline; nothing changed.`,
        };
        return { status: done.status, message: messages[done.status] };
      }
      const { stages } = await vocabulary(db);
      const label = (key: string | null) => stages.find((s) => s.key === key)?.label ?? key ?? "";
      const who = proposal.memberName;
      const moved = await moveStage(db, proposal.memberId, proposal.fromStage, proposal.toStage, owner);
      const messages = {
        moved: `Done. ${who} moved to ${label(proposal.toStage)}.`,
        already: `${who} is already in ${label(proposal.toStage)}; nothing changed.`,
        changed: `${who} is now in ${label(moved.stage)}; nothing changed.`,
        missing: `${who} is no longer on the pipeline; nothing changed.`,
      };
      return { status: moved.status, message: messages[moved.status] };
    });
    await account.record(ACTIVITY[proposal.kind], estate.key);
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
