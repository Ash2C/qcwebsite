// The assistant's toolbox: ten fixed tools. Eight read the CRM; two only prepare a change and
// return a signed proposal. Nothing in this file writes to the database.
import type { ClientBase } from "pg";
import type { EstateKey } from "../estates";
import { proposeNote, proposeStage, type Target } from "./actions";
import type { SignedProposal } from "./proposal";
import {
  chaseList,
  findContacts,
  getContact,
  getPerson,
  listPipeline,
  pipelineSummary,
  recentActivity,
  searchNotes,
  type MemberKind,
} from "./queries";

export type Ref = { memberId: string; name: string; company: string | null; kind: MemberKind };
export type ToolContext = { db: ClientBase; estate: EstateKey; today: string; nowMs: number };
export type ToolOutcome = { result: unknown; refs: Ref[]; proposal?: SignedProposal };

type Prop = { type: "string" | "integer"; description: string; enum?: string[] };
type ToolDef = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, Prop>; required: string[] };
};

const DUE = ["overdue", "today", "week", "later", "undated", "none"];
const MEMBER_ID: Prop = { type: "string", description: "A member id taken from an earlier tool result." };
const PERSON_ID: Prop = { type: "string", description: "A person id taken from an earlier tool result." };

function tool(name: string, description: string, properties: Record<string, Prop>, required: string[] = []): ToolDef {
  return { name, description, input_schema: { type: "object", properties, required } };
}

export const TOOLS: ToolDef[] = [
  tool(
    "find_contacts",
    "Find people and companies by part of a name or email. Use it first whenever the user names someone, to get their ids.",
    { query: { type: "string", description: "Part of a name or email, at least two characters." } },
    ["query"],
  ),
  tool(
    "get_contact",
    "Get the full record of one pipeline member: stage, owner, next action, notes, people and recent timeline. Use it to answer questions about one contact.",
    { member_id: MEMBER_ID },
    ["member_id"],
  ),
  tool(
    "get_person",
    "Get one person's details and the pipeline member they belong to, if any. Use it when you only have a person id.",
    { person_id: PERSON_ID },
    ["person_id"],
  ),
  tool(
    "list_pipeline",
    "List pipeline members, at most 50, optionally filtered by stage key, role key, owner key or due bucket. Use it for questions about who is in a stage, role or due window.",
    {
      stage: { type: "string", description: "A stage key." },
      role: { type: "string", description: "A role key." },
      owner: { type: "string", description: "An owner key." },
      due: { type: "string", description: "A due bucket.", enum: DUE },
    },
  ),
  tool("pipeline_summary", "Count pipeline members by stage, role and due bucket. Use it for how-many and overview questions.", {}),
  tool(
    "chase_list",
    "List members whose next action is due or that have gone quiet, optionally for one owner (that owner plus unowned). Use it for who to chase or follow up.",
    { owner: { type: "string", description: "An owner key." } },
  ),
  tool(
    "search_notes",
    "Search the text of notes and timeline entries. Use it to find what was said or noted about a topic.",
    { text: { type: "string", description: "Text to look for, at least two characters." } },
    ["text"],
  ),
  tool(
    "recent_activity",
    "List the latest timeline entries across the CRM over the last number of days, at most 50. Use it for what happened recently.",
    { days: { type: "integer", description: "How many days back, 1 to 90." } },
    ["days"],
  ),
  tool(
    "propose_note",
    "Prepare a timeline note on a contact for the user to confirm. Nothing is saved until the user confirms. Use it only when the user asks in their current message to add or log a note.",
    { member_id: MEMBER_ID, person_id: PERSON_ID, text: { type: "string", description: "The note text, 1 to 2,000 characters." } },
    ["text"],
  ),
  tool(
    "propose_stage",
    "Prepare moving a contact to another stage for the user to confirm. Nothing changes until the user confirms. Use it only when the user asks in their current message to move or change a stage.",
    { member_id: MEMBER_ID, person_id: PERSON_ID, stage: { type: "string", description: "The target stage key." } },
    ["stage"],
  ),
];

const SCHEMAS = new Map(TOOLS.map((t) => [t.name, t.input_schema]));

const FAILED = "That lookup failed.";
const fail = (error: string): ToolOutcome => ({ result: { error }, refs: [] });

/** Hand validation against the tool's schema: required keys present, types right, enums respected. */
function validate(name: string, input: unknown): { ok: true; args: Record<string, string | number> } | { ok: false; error: string } {
  const schema = SCHEMAS.get(name);
  if (!schema) return { ok: false, error: "Unknown tool." };
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "Input must be an object." };
  const src = input as Record<string, unknown>;
  const args: Record<string, string | number> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = src[key];
    if (v === undefined || v === null) {
      if (schema.required.includes(key)) return { ok: false, error: `Missing required input: ${key}.` };
      continue;
    }
    if (prop.type === "string") {
      if (typeof v !== "string") return { ok: false, error: `${key} must be a string.` };
      if (schema.required.includes(key) && v.trim() === "") return { ok: false, error: `${key} must not be empty.` };
      if (v.length > 4000) return { ok: false, error: `${key} is too long.` };
      if (prop.enum && !prop.enum.includes(v)) return { ok: false, error: `${key} must be one of: ${prop.enum.join(", ")}.` };
    } else if (typeof v !== "number" || !Number.isInteger(v)) {
      return { ok: false, error: `${key} must be a whole number.` };
    }
    args[key] = v as string | number;
  }
  return { ok: true, args };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Members named in a result, in order: objects with memberId + name, or a `member` object beside a name. */
export function extractRefs(result: unknown): Ref[] {
  const out: Ref[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isObj(node)) return;
    const company = typeof node.company === "string" ? node.company : null;
    if (typeof node.memberId === "string" && typeof node.name === "string") {
      // Activity rows carry no memberKind; a person always has a company on file there, a company member never does.
      const kind: MemberKind =
        node.memberKind === "company" || node.memberKind === "person" ? node.memberKind : company !== null ? "person" : "company";
      out.push({ memberId: node.memberId, name: node.name, company, kind });
    } else if (isObj(node.member) && typeof node.member.memberId === "string" && typeof node.name === "string") {
      const k = node.member.memberKind;
      out.push({
        memberId: node.member.memberId,
        name: node.name,
        company,
        kind: k === "company" || k === "person" ? k : (node.kind as MemberKind) === "company" ? "company" : "person",
      });
    }
    Object.values(node).forEach(visit);
  };
  visit(result);
  return out;
}

function describeChange(p: SignedProposal): string {
  const x = p.proposal;
  const who = x.company ? `${x.memberName} (${x.company})` : x.memberKind === "company" ? `${x.memberName} (company)` : x.memberName;
  const via = x.about ? ` for ${x.about}` : "";
  return x.kind === "add_note"
    ? `Add a note to ${who}${via}: ${p.text ?? ""}`
    : `Move ${who} from ${x.fromStage} to ${x.toStage}`;
}

async function dispatch(ctx: ToolContext, name: string, a: Record<string, string | number>): Promise<ToolOutcome> {
  const { db, today } = ctx;
  const read = (result: unknown): ToolOutcome => ({ result, refs: extractRefs(result) });
  const target: Target = {
    ...(typeof a.member_id === "string" ? { memberId: a.member_id } : {}),
    ...(typeof a.person_id === "string" ? { personId: a.person_id } : {}),
  };
  switch (name) {
    case "find_contacts":
      return read(await findContacts(db, a.query as string));
    case "get_contact": {
      const r = await getContact(db, a.member_id as string, today);
      return read(r ?? { error: "No such contact." });
    }
    case "get_person": {
      const r = await getPerson(db, a.person_id as string);
      return read(r ?? { error: "No such person." });
    }
    case "list_pipeline":
      return read(
        await listPipeline(
          db,
          {
            ...(a.stage !== undefined ? { stage: a.stage as string } : {}),
            ...(a.role !== undefined ? { role: a.role as string } : {}),
            ...(a.owner !== undefined ? { owner: a.owner as string } : {}),
            ...(a.due !== undefined ? { due: a.due as "overdue" } : {}),
          },
          today,
        ),
      );
    case "pipeline_summary":
      return read(await pipelineSummary(db, today));
    case "chase_list":
      return read(await chaseList(db, a.owner !== undefined ? { owner: a.owner as string } : {}, today));
    case "search_notes":
      return read(await searchNotes(db, a.text as string));
    case "recent_activity":
      return read(await recentActivity(db, a.days as number, today));
    case "propose_note":
    case "propose_stage": {
      const r =
        name === "propose_note"
          ? await proposeNote(db, ctx.estate, target, a.text as string, ctx.nowMs)
          : await proposeStage(db, ctx.estate, target, a.stage as string, ctx.nowMs);
      if (!r.ok) return fail(r.reason);
      return {
        result: { status: "shown to the user for confirmation; not done yet", change: describeChange(r.signed) },
        refs: [],
        proposal: r.signed,
      };
    }
    default:
      return fail("Unknown tool.");
  }
}

/** Runs one tool. Never throws; a failure is returned as `{ error }` and never carries the thrown message. */
export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome> {
  const v = validate(name, input);
  if (!v.ok) return fail(v.error);
  try {
    return await dispatch(ctx, name, v.args);
  } catch {
    return fail(FAILED);
  }
}
