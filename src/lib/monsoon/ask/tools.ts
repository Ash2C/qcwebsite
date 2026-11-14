// The assistant's toolbox: eleven fixed tools. Eight read the CRM; three only prepare a change and
// return a signed proposal. Nothing in this file writes to the database.
import type { ClientBase } from "pg";
import { DETAIL_LABELS, proposeDetails, type DetailInput } from "../details";
import { estateByKey, type EstateKey } from "../estates";
import { proposeNote, proposeStage, type Target } from "./actions";
import type { DetailField, SignedProposal } from "./proposal";
import {
  chaseList,
  findContacts,
  getContact,
  getPerson,
  listPipeline,
  pipelineSummary,
  recentActivity,
  searchNotes,
  clip,
  type MemberKind,
} from "./queries";

/**
 * A contact the conversation has named. A person filed under their company carries the company's
 * member id, the person's own name and, in `personId`, which person it is. A person always carries
 * their own `personId` where the result has it. `orgId` is a company's id: it is set on a company
 * and on a person filed under their company, never on a person with their own pipeline entry.
 */
export type Ref = { memberId: string; name: string; company: string | null; kind: MemberKind; personId?: string; orgId?: string };
export type ToolContext = {
  db: ClientBase;
  estate: EstateKey;
  today: string;
  nowMs: number;
  /** Milliseconds left in the request; bounds each query's statement timeout. */
  remainingMs?: () => number;
};
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
const ORG_ID: Prop = { type: "string", description: "A company id (orgId) taken from an earlier tool result." };
const DETAIL_FIELDS: readonly DetailField[] = ["name", "title", "email", "phone", "linkedin", "country", "company", "website"];
const detailProp = (what: string): Prop => ({
  type: "string",
  description: `${what}. Leave it out to keep it; pass an empty string to clear it.`,
});

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
    "List members whose next action is due or that have gone quiet, optionally for one owner. Passing owner includes unassigned contacts too (that owner plus unassigned); leave it out for the whole team. Use it for who to chase or follow up.",
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
  tool(
    "propose_update",
    "Prepare changes to a contact's details for the user to confirm. Nothing changes until the user confirms. Use it only when the user asks in their current message to change, correct or clear a detail. Give member_id, person_id or org_id, then only the fields to change. A person has name, title, email, phone, linkedin, country and company; a company has website and country.",
    {
      member_id: MEMBER_ID,
      person_id: PERSON_ID,
      org_id: ORG_ID,
      name: detailProp("The person's full name; it cannot be cleared"),
      title: detailProp("The person's job title"),
      email: detailProp("The person's email address"),
      phone: detailProp("The person's phone number"),
      linkedin: detailProp("The person's LinkedIn address"),
      country: detailProp("The country of the person or company"),
      company: detailProp("The name of the person's company"),
      website: detailProp("The company's website"),
      new_company: {
        type: "string",
        description: "Pass yes only when company names a company that is not yet on file and the user has said it is a different company from any similar one.",
        enum: ["yes"],
      },
    },
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

const orgIdOf = (node: Record<string, unknown>): { orgId?: string } =>
  typeof node.orgId === "string" ? { orgId: node.orgId } : {};
const personIdOf = (node: Record<string, unknown>): { personId?: string } =>
  typeof node.personId === "string" ? { personId: node.personId } : {};

/** Refs are unique by the person when there is one, else by the member. */
export const refKey = (r: Ref): string => r.personId ?? r.memberId;

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
      out.push({ memberId: node.memberId, name: node.name, company, kind, ...personIdOf(node), ...(kind === "company" ? orgIdOf(node) : {}) });
    } else if (isObj(node.member) && typeof node.member.memberId === "string" && typeof node.name === "string") {
      const k = node.member.memberKind;
      const personId = typeof node.personId === "string" ? node.personId : null;
      if (k === "company" && personId !== null) {
        // A person filed under their company: the company's member, labelled with the person.
        out.push({ memberId: node.member.memberId, name: node.name, company, kind: "company", personId, ...orgIdOf(node) });
      } else {
        const kind: MemberKind = k === "company" || k === "person" ? k : (node.kind as MemberKind) === "company" ? "company" : "person";
        out.push({
          memberId: node.member.memberId,
          name: node.name,
          company,
          kind,
          ...(personId !== null ? { personId } : {}),
          // Only a company row (no person on it) names a company id; a person's own entry does not.
          ...(kind === "company" && personId === null ? orgIdOf(node) : {}),
        });
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(result);
  return out;
}

function describeChange(p: SignedProposal): string {
  const x = p.proposal;
  if (x.kind === "update_details") {
    const list = x.changes.map((c) => `${DETAIL_LABELS[c.field]}: ${c.from ?? "(empty)"} → ${c.to ?? "(empty)"}`).join("; ");
    return clip(`Update the details of ${x.targetName}: ${list}`, 600) as string;
  }
  if (x.kind === "apply_research") return clip(`Save research about ${x.person.name}`, 600) as string;
  const who = x.company ? `${x.memberName} (${x.company})` : x.memberKind === "company" ? `${x.memberName} (company)` : x.memberName;
  const via = x.about ? ` for ${x.about}` : "";
  return x.kind === "add_note"
    ? `Add a note to ${who}${via}: ${p.text ?? ""}`
    : `Move ${who} from ${x.fromStage} to ${x.toStage}`;
}

const TEXT_MAX = 160;
const LIST_ROWS = 40;
const CHASE_DUE_ROWS = 25;
const CHASE_STALE_ROWS = 15;

/** A row for the model: null and empty fields omitted, free text clipped, ids kept. */
function slim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slim);
  if (typeof value === "string") return clip(value, TEXT_MAX);
  if (!isObj(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = slim(v);
  }
  return out;
}

/** List rows for the model: an owner that is null is said outright, not left out. */
function withOwner(rows: unknown[]): unknown[] {
  return rows.map((r) => (isObj(r) && !r.owner ? { ...r, owner: "unassigned" } : r));
}

async function dispatch(ctx: ToolContext, name: string, a: Record<string, string | number>): Promise<ToolOutcome> {
  const { db, today } = ctx;
  // Statement timeout for this lookup: what is left of the request minus 3 seconds, at least 1 second.
  const opts = ctx.remainingMs ? { timeoutMs: Math.max(1000, ctx.remainingMs() - 3000) } : undefined;
  const read = (result: unknown): ToolOutcome => ({ result, refs: extractRefs(result) });
  const target: Target = {
    ...(typeof a.member_id === "string" ? { memberId: a.member_id } : {}),
    ...(typeof a.person_id === "string" ? { personId: a.person_id } : {}),
  };
  switch (name) {
    case "find_contacts":
      return read(slim(await findContacts(db, a.query as string, opts)));
    case "get_contact": {
      const r = await getContact(db, a.member_id as string, today, opts);
      return read(r ?? { error: "No such contact." });
    }
    case "get_person": {
      const r = await getPerson(db, a.person_id as string, opts);
      return read(r ?? { error: "No such person." });
    }
    case "list_pipeline": {
      const r = await listPipeline(
        db,
        {
          ...(a.stage !== undefined ? { stage: a.stage as string } : {}),
          ...(a.role !== undefined ? { role: a.role as string } : {}),
          ...(a.owner !== undefined ? { owner: a.owner as string } : {}),
          ...(a.due !== undefined ? { due: a.due as "overdue" } : {}),
        },
        today,
        opts,
      );
      const rows = slim(withOwner(r.rows.slice(0, LIST_ROWS)));
      return read({
        rows,
        total: r.total,
        ...(r.total > LIST_ROWS ? { note: `Showing the first ${LIST_ROWS} of ${r.total}; ${r.total - LIST_ROWS} not shown.` } : {}),
      });
    }
    case "pipeline_summary":
      return read(await pipelineSummary(db, today, opts));
    case "chase_list": {
      const r = await chaseList(db, a.owner !== undefined ? { owner: a.owner as string } : {}, today, opts);
      const due = r.due.slice(0, CHASE_DUE_ROWS);
      const stale = r.stale.slice(0, CHASE_STALE_ROWS);
      const hidden = r.dueTotal - due.length + (r.staleTotal - stale.length);
      return read({
        due: slim(withOwner(due)),
        stale: slim(withOwner(stale)),
        dueTotal: r.dueTotal,
        staleTotal: r.staleTotal,
        ...(hidden > 0
          ? {
              note: `Showing the ${due.length} most urgent due and ${stale.length} longest-quiet of ${r.dueTotal} due and ${r.staleTotal} quiet; ${hidden} not shown.`,
            }
          : {}),
      });
    }
    case "search_notes": {
      const r = await searchNotes(db, a.text as string, opts);
      return read({
        hits: slim(r.hits),
        total: r.total,
        ...(r.total > r.hits.length
          ? { note: `Showing the ${r.hits.length} newest of ${r.total} matches; ${r.total - r.hits.length} not shown. Search for something narrower to see others.` }
          : {}),
      });
    }
    case "recent_activity":
      return read(slim(await recentActivity(db, a.days as number, today, opts)));
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
    case "propose_update": {
      const input: DetailInput = {};
      for (const f of DETAIL_FIELDS) if (typeof a[f] === "string") input[f] = a[f] as string;
      const defaults = estateByKey(ctx.estate);
      if (!defaults) return fail(FAILED);
      // One id only, the most specific: the person, then the company, then the member.
      const only: Target & { orgId?: string } =
        typeof a.person_id === "string"
          ? { personId: a.person_id }
          : typeof a.org_id === "string"
            ? { orgId: a.org_id }
            : typeof a.member_id === "string"
              ? { memberId: a.member_id }
              : {};
      const r = await proposeDetails(db, ctx.estate, only, input, {
        nowMs: ctx.nowMs,
        defaultRole: defaults.defaultRole,
        newCompany: a.new_company === "yes",
      });
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
  } catch (err) {
    // Tool name, error name and a numeric code or status only: never the message or the arguments.
    const e = err as { code?: unknown; status?: unknown };
    // A number, or a five-character Postgres code such as 57014; any other string could carry text.
    const num = [e?.status, e?.code].find(
      (x) => typeof x === "number" || (typeof x === "string" && /^[0-9A-Z]{5}$/.test(x)),
    );
    console.error("monsoon: ask tool failed", name, err instanceof Error ? err.name : "error", ...(num !== undefined ? [num] : []));
    return fail(FAILED);
  }
}
