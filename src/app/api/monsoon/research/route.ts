import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { PROPOSAL_TTL_MS, signProposal, verifyProposal, type Proposal, type SignedProposal } from "@/lib/monsoon/ask/proposal";
import { requireSession } from "@/lib/monsoon/auth";
import { readJson } from "@/lib/monsoon/body";
import { withEstateDb } from "@/lib/monsoon/db";
import { estateByKey } from "@/lib/monsoon/estates";
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
  const denied = requireSession(request);
  if (denied) return denied;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  if (!isObj(read.body)) return bad("Invalid body");
  const b = read.body;

  const estate = estateByKey(b.estate);
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
    subjectRead = await withEstateDb(estate, (db) => readSubject(db, target));
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
    const client = new Anthropic({ timeout: RESEARCH_TIMEOUT_MS, maxRetries: 0 });
    run = await runResearch(client, subject, { timeoutMs: RESEARCH_TIMEOUT_MS });
  } catch (err) {
    // Class name and status only: the message can carry the query or contact data.
    const status = (err as { status?: unknown })?.status;
    console.error("monsoon: research failed", (err as object)?.constructor?.name ?? "error", typeof status === "number" ? status : "");
    return NextResponse.json({ error: "Could not run research. Check signal and try again." }, { status: 502 });
  }

  if ("failed" in run) {
    if (run.failed === "timeout") return none("timeout", MSG.timeout);
    return none(run.failed, MSG.nothing);
  }
  const v = run.vetted;
  if (v.outcome === "not_identified") return none("not_identified", MSG.notIdentified);
  if (v.outcome === "nothing") return none("nothing", MSG.nothing);

  const nowMs = Date.now();
  const proposal: ResearchProposal = {
    kind: "apply_research",
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
    return NextResponse.json({ error: "Could not run research. Check signal and try again." }, { status: 502 });
  }
  // Never return what the confirm route would refuse.
  if (!verifyProposal(signed.proposal, signed.signature, nowMs)) return none("unusable", MSG.nothing);

  console.log("monsoon: research findings");
  return NextResponse.json({ status: "findings", signed, summary: v.summary });
}
