// Applies the ticked findings of a signed `apply_research` proposal in one transaction. Field writes go
// through applyRowChanges (details.ts), so this file runs no SQL update of its own. Exactly one `system`
// touch records what was written.
import type { ClientBase } from "pg";
import type { DetailChange, Proposal, ResearchFinding } from "./ask/proposal";
import { addToPipeline, applyRowChanges, DETAIL_LABELS, isUniqueOn, logMemberFor, transaction } from "./details";

type ResearchProposal = Extract<Proposal, { kind: "apply_research" }>;
export type ResearchApplyResult = {
  status: "saved" | "partly" | "unchanged" | "missing" | "unlogged";
  written: string[]; // labels, e.g. "Title"
  skipped: string[]; // labels
  name: string;
};

const OWNER = "VF";
const display = (v: string | null) => v ?? "(empty)";
const change = (f: ResearchFinding): DetailChange => ({ field: f.field, from: f.from, to: f.to });

/**
 * One transaction. When the research adds the person to the pipeline and a concurrent capture added
 * them first (a unique violation on members), it runs once more in a fresh transaction, as applyDetails does.
 */
export async function applyResearch(
  db: ClientBase,
  proposal: ResearchProposal,
  ticked: string[],
  summary: string,
): Promise<ResearchApplyResult> {
  try {
    return await applyOnce(db, proposal, ticked, summary);
  } catch (err) {
    if (isUniqueOn(err, "members", "members_pkey") && proposal.addsToPipeline !== null) {
      return applyOnce(db, proposal, ticked, summary);
    }
    throw err;
  }
}

function applyOnce(db: ClientBase, proposal: ResearchProposal, ticked: string[], summary: string): Promise<ResearchApplyResult> {
  return transaction<ResearchApplyResult>(db, async () => {
    const out = (status: ResearchApplyResult["status"], written: string[], skipped: string[], name: string, commit = false) => ({
      value: { status, written, skipped, name },
      commit,
    });
    const chosen = proposal.findings.filter((f) => ticked.includes(f.id));
    const personFindings = chosen.filter((f) => f.target === "person");
    const companyFindings = chosen.filter((f) => f.target === "company");

    const person = await applyRowChanges(db, { type: "person", id: proposal.person.id }, personFindings.map(change));
    if (!person.found) return out("missing", [], [], proposal.person.name);

    const writtenFindings: ResearchFinding[] = [];
    const skippedLabels: string[] = [];
    const settle = (findings: ResearchFinding[], done: { written: DetailChange[] }) => {
      for (const f of findings) {
        if (done.written.some((c) => c.field === f.field)) writtenFindings.push(f);
        else skippedLabels.push(DETAIL_LABELS[f.field]);
      }
    };
    settle(personFindings, person);

    if (companyFindings.length > 0) {
      // Only the company the person was researched at, and only while they are still there.
      if (proposal.company && person.orgId === proposal.company.id) {
        const org = await applyRowChanges(db, { type: "company", id: proposal.company.id }, companyFindings.map(change));
        settle(companyFindings, org);
      } else {
        settle(companyFindings, { written: [] });
      }
    }
    // Findings in proposal order, whichever table they went to.
    writtenFindings.sort((a, b) => proposal.findings.indexOf(a) - proposal.findings.indexOf(b));
    const written = writtenFindings.map((f) => DETAIL_LABELS[f.field]);

    if (writtenFindings.length === 0 && summary === "") return out("unchanged", [], skippedLabels, person.name);

    const logMember =
      (await logMemberFor(db, { type: "person", id: proposal.person.id, orgId: person.orgId })) ??
      (proposal.addsToPipeline !== null ? await addToPipeline(db, proposal.person.id, proposal.addsToPipeline) : null);
    if (logMember === null) return out("unlogged", [], [], proposal.person.name);

    const sources = [...new Set([...writtenFindings.map((f) => f.source), ...(summary !== "" ? proposal.summarySources : [])])];
    const entries = writtenFindings.map((f) => `${DETAIL_LABELS[f.field]}: ${display(f.from)} → ${display(f.to)}`).join("; ");
    const lines = [`Research saved:${entries === "" ? "" : " " + entries}`];
    if (summary !== "") lines.push(summary);
    if (sources.length > 0) lines.push(`Sources: ${sources.join(", ")}`);
    await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'system', $2, $3)", [
      logMember,
      OWNER,
      lines.join("\n\n"),
    ]);
    return out(skippedLabels.length > 0 ? "partly" : "saved", written, skippedLabels, person.name, true);
  });
}
