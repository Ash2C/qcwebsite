import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { claudeFailureResponse } from "@/lib/monsoon/claude-failure";
import { PROPOSAL_TTL_MS, signProposal, verifyProposal, type Proposal, type SignedProposal } from "@/lib/monsoon/ask/proposal";
import { readJson } from "@/lib/monsoon/body";
import { hasAnchor, runResearch, type ResearchRun } from "@/lib/monsoon/research";
import { readSubject, type SubjectRead } from "@/lib/monsoon/research-subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 2048;
const RESEARCH_TIMEOUT_MS = 45_000;
const MAX_FINDINGS = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MSG = {
  noAnchor: "Add a company or email first so I research the right person.",
  notPerson: "Research works on a person. Open a person's profile.",
  notIdentified: "I found several people with this name and can't tell which is yours.",
  nothing: "Nothing I'd trust. No changes suggested.",
  timeout: "Research took too long. Try again.",
};

type ResearchProposal = Extract<Proposal, { kind: "apply_research" }>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

function none(outcome: string, message: string) {
  console.log(`monsoon: research ${outcome}`);
  return NextResponse.json({ status: "none", message });
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
  const target: { memberId?: string; personId?: string } = {};
  for (const key of ["memberId", "personId"] as const) {
    const v = b[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !UUID_RE.test(v)) return bad("Invalid id");
    target[key] = v;
  }
  if (!target.memberId && !target.personId) return bad("Invalid id");

  // The connection is used for this read only and is closed before the model is called.
  let subjectRead: SubjectRead;
  try {
    subjectRead = await account.withDb(estate.key, (db) => readSubject(db, target));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error(
      `monsoon: research read failed for ${estate.key}`,
      err instanceof Error ? err.name : "error",
      typeof code === "string" && code.length === 5 ? code : "",
    );
    return NextResponse.json({ error: `Could not reach the ${estate.label} CRM` }, { status: 502 });
  }
  if (!subjectRead.ok) {
    if (subjectRead.reason === "company") return none("not_person", MSG.notPerson);
    return NextResponse.json({ error: "No such contact." }, { status: 404 });
  }
  const { subject, person, company, logMemberId } = subjectRead;
  if (!hasAnchor(subject)) return none("no_anchor", MSG.noAnchor);

  let run: ResearchRun;
  try {
    // One AI use. The customer's own key (or its free trial) and model (a missing key is named to
    // the app; a refused model is a 502).
    await account.beginAi("research");
    const client = account.anthropic({ timeout: RESEARCH_TIMEOUT_MS });
    run = await runResearch(client, account.model(), subject, { timeoutMs: RESEARCH_TIMEOUT_MS });
    await account.noteClaude();
  } catch (err) {
    // Class name and status only: the message can carry the query or contact data.
    const status = (err as { status?: unknown })?.status;
    console.error("monsoon: research failed", (err as object)?.constructor?.name ?? "error", typeof status === "number" ? status : "");
    await account.noteClaude(err);
    return (
      claudeFailureResponse(account.aiError(err)) ??
      NextResponse.json({ error: "Could not run research. Check signal and try again." }, { status: 502 })
    );
  }

  // The model answered: from here every outcome but a 5xx counts as a research run.
  const ran = (outcome: string, message: string) => account.record("research", estate.key).then(() => none(outcome, message));
  if ("failed" in run) {
    if (run.failed === "timeout") return ran("timeout", MSG.timeout);
    return ran(run.failed, MSG.nothing);
  }
  const v = run.vetted;
  if (v.outcome === "not_identified") return ran("not_identified", MSG.notIdentified);
  if (v.outcome === "nothing") return ran("nothing", MSG.nothing);

  const nowMs = Date.now();
  const proposal: ResearchProposal = {
    kind: "apply_research",
    customer: account.customer.id,
    estate: estate.key,
    person,
    company,
    identity: v.identity,
    findings: v.findings.slice(0, MAX_FINDINGS).map((f, i) => ({ id: `f${i + 1}`, ...f })),
    summarySources: v.summarySources,
    logMemberId,
    addsToPipeline: logMemberId === null ? estate.defaultRole : null,
    expires: nowMs + PROPOSAL_TTL_MS,
  };
  let signed: SignedProposal;
  try {
    signed = { proposal, signature: signProposal(proposal) };
  } catch {
    console.error("monsoon: research unusable");
    return NextResponse.json({ error: "Could not run research. Check signal and try again." }, { status: 502 });
  }
  // Never return what the confirm route would refuse.
  if (!verifyProposal(signed.proposal, signed.signature, nowMs)) {
    console.error("monsoon: research unusable");
    return ran("unusable", MSG.nothing);
  }

  await account.record("research", estate.key);
  console.log("monsoon: research findings");
  return NextResponse.json({ status: "findings", signed, summary: v.summary });
}
