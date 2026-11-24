// The assistant's toolbox: twelve fixed tools. Eight read the CRM; three only prepare a change and
// return a signed proposal; one offers research, which the user starts with a button. Nothing in this
// file writes to the database, searches the web or calls a model.
// A person who has connected their own Granola key gets three more, which only read their meetings
// through the Granola client. They exist for nobody else: not in the list sent to the model and not
// in runTool.
import type { ClientBase } from "pg";
import { DETAIL_LABELS, proposeDetails, type DetailInput } from "../details";
import { GRANOLA_TIMEOUT_MS, getGranolaNote, searchGranolaNotes, searchGranolaTranscripts, type GranolaFailure } from "../granola/client";
import { readSubject } from "../research-subject";
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
/** The signed-in person's own Granola key, and where a refusal of it is reported. */
export type GranolaAccess = {
  key: string;
  onStatus?: (status: "key_rejected" | "no_access") => void;
  /** Set once Granola fails to answer in this request; later meeting calls then skip it. */
  down?: boolean;
};
export type ToolContext = {
  db: ClientBase;
  /** The signed-in customer's id; every proposal is bound to it. Never from a request body. */
  customerId: string;
  /** The pipeline key. */
  estate: string;
  /** The pipeline's default role, for a details change that adds a person to the pipeline. */
  defaultRole: string;
  today: string;
  nowMs: number;
  /** Milliseconds left in the request; bounds each query's statement timeout. */
  remainingMs?: () => number;
  /** Set only when the person has a Granola key on file; without it the meeting tools do not exist. */
  granola?: GranolaAccess;
};
/** An offer to research one person; the user runs it from the profile. */
export type ResearchOffer = { personId: string; name: string; company: string | null };
export type ToolOutcome = { result: unknown; refs: Ref[]; proposal?: SignedProposal; research?: ResearchOffer };

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
  tool(
    "propose_research",
    "Offer to research a person on the web. It searches nothing: the user sees a button and runs the research from the person's profile. Use it only when the user asks in their current message for research on a person. Give member_id or person_id. It does not work on a company.",
    { member_id: MEMBER_ID, person_id: PERSON_ID },
  ),
];

const MEETING_ID: Prop = { type: "string", description: "A meeting id taken from an earlier meeting tool result." };
const PARTICIPANT: Prop = {
  type: "string",
  description: "A name, email address, company or email domain of someone invited to the meeting.",
};
const FROM_DATE: Prop = { type: "string", description: "Only meetings on or after this day, written YYYY-MM-DD." };
const TO_DATE: Prop = { type: "string", description: "Only meetings on or before this day, written YYYY-MM-DD." };

/** Offered only to a person with a Granola key on file. They read that person's meetings and nothing else. */
export const GRANOLA_TOOLS: ToolDef[] = [
  tool(
    "search_meetings",
    "Search the user's own Granola meeting notes by topic, participant or date. Returns at most 10 meetings with id, title and date. Use it when the user asks about a meeting or a call, or about what was discussed or agreed.",
    {
      keywords: { type: "string", description: "Words or short phrases to look for in meeting notes, separated by commas; at most five." },
      participant: PARTICIPANT,
      from_date: FROM_DATE,
      to_date: TO_DATE,
    },
  ),
  tool(
    "get_meeting",
    "Get one Granola meeting: its title, date, attendees, summary and a link. Use it after a search to read what a meeting was about.",
    { meeting_id: MEETING_ID },
    ["meeting_id"],
  ),
  tool(
    "search_meeting_transcripts",
    "Find where given words were said in the user's Granola meeting transcripts. Returns at most 10 meetings, each with short matching passages. Use it for what was actually said: a number, a name, a reason or a commitment.",
    {
      keywords: { type: "string", description: "Words or short phrases likely to have been spoken, separated by commas; at most five." },
      participant: PARTICIPANT,
      meeting_id: MEETING_ID,
      from_date: FROM_DATE,
      to_date: TO_DATE,
    },
    ["keywords"],
  ),
];
const GRANOLA_NAMES = new Set(GRANOLA_TOOLS.map((t) => t.name));
const WITH_GRANOLA: ToolDef[] = [...TOOLS, ...GRANOLA_TOOLS];

/** The tools sent to the model: the twelve, unchanged, or the twelve and the three meeting tools. */
export function toolsFor(granola: boolean): ToolDef[] {
  return granola ? WITH_GRANOLA : TOOLS;
}

const SCHEMAS = new Map(WITH_GRANOLA.map((t) => [t.name, t.input_schema]));
const DATE_KEYS = new Set(["from_date", "to_date"]);
const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

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
      if (DATE_KEYS.has(key)) {
        if (v.trim() === "") continue; // a blank date is a date left out
        if (!isDay(v)) return { ok: false, error: `${key} must be a date written YYYY-MM-DD.` };
      }
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
  if (x.kind === "set_next_action") {
    return clip(x.toAction ? `Set the next action for ${who}${via}: ${x.toAction}${x.toDate ? ` (due ${x.toDate})` : ""}` : `Clear the next action for ${who}${via}`, 600) as string;
  }
  if (x.kind === "set_role") return `Change the type of ${who}${via} from ${x.fromRole} to ${x.toRole}`;
  if (x.kind === "set_priority") return `Change the priority of ${who}${via} from ${x.fromPriority ?? "none"} to ${x.toPriority ?? "none"}`;
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
  const bind = { customer: ctx.customerId, estate: ctx.estate };
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
          ? await proposeNote(db, bind, target, a.text as string, ctx.nowMs)
          : await proposeStage(db, bind, target, a.stage as string, ctx.nowMs);
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
      // One id only, the most specific: the person, then the company, then the member.
      const only: Target & { orgId?: string } =
        typeof a.person_id === "string"
          ? { personId: a.person_id }
          : typeof a.org_id === "string"
            ? { orgId: a.org_id }
            : typeof a.member_id === "string"
              ? { memberId: a.member_id }
              : {};
      const r = await proposeDetails(db, bind, only, input, {
        nowMs: ctx.nowMs,
        defaultRole: ctx.defaultRole,
        newCompany: a.new_company === "yes",
      });
      if (!r.ok) return fail(r.reason);
      return {
        result: { status: "shown to the user for confirmation; not done yet", change: describeChange(r.signed) },
        refs: [],
        proposal: r.signed,
      };
    }
    case "propose_research": {
      const r = await readSubject(db, target);
      if (!r.ok) return fail(r.reason === "company" ? "Research works on a person. Open a person's profile." : "No such contact.");
      return {
        result: { offered: true, status: "the user sees a Run research button; nothing has been searched" },
        refs: [],
        research: { personId: r.person.id, name: r.person.name, company: r.company?.name ?? null },
      };
    }
    default:
      return fail("Unknown tool.");
  }
}

const GRANOLA_REFUSED = "The Granola key was refused.";
const GRANOLA_DOWN = "Granola could not be reached.";
const NO_MEETING = "No such meeting.";
const MAX_KEYWORDS = 5;
const MAX_KEYWORD_CHARS = 100;
// Ten meetings of three passages always fit the loop's cap on one result.
const PASSAGES_PER_MEETING = 3;

/**
 * The three meeting tools. They read the person's own Granola and nothing else: no CRM query, no
 * contact refs, never a proposal. Every failure is a plain sentence the model can relay.
 */
async function meetingTool(ctx: ToolContext, granola: GranolaAccess, name: string, a: Record<string, string | number>): Promise<ToolOutcome> {
  // A Granola that did not answer once is not waited on again in this request: the time is the CRM's.
  if (granola.down) return fail(GRANOLA_DOWN);
  // Eight seconds, or what is left of the request less three; with none left the client asks nothing.
  const opts = { timeoutMs: Math.min(GRANOLA_TIMEOUT_MS, (ctx.remainingMs ? ctx.remainingMs() : Infinity) - 3000) };
  const given = (key: string): string | undefined => {
    const v = a[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  const keywords = (given("keywords") ?? "")
    .split(",")
    .map((k) => k.trim().slice(0, MAX_KEYWORD_CHARS))
    .filter((k) => k !== "")
    .slice(0, MAX_KEYWORDS);
  const participant = given("participant");
  const fromDate = given("from_date");
  const toDate = given("to_date");
  const filters = {
    ...(participant !== undefined ? { participant } : {}),
    ...(fromDate !== undefined ? { fromDate } : {}),
    ...(toDate !== undefined ? { toDate } : {}),
  };
  /** `one`: the call named a single meeting, so "not found" is about that meeting. */
  const refused = (failure: GranolaFailure, one: boolean): ToolOutcome => {
    if (failure === "busy") {
      granola.down = true;
      return fail(GRANOLA_DOWN);
    }
    if (failure === "not_found") return fail(one ? NO_MEETING : GRANOLA_REFUSED);
    try {
      granola.onStatus?.(failure);
    } catch {
      // Recording the refusal is a courtesy to the person's page; it must not cost the answer.
    }
    return fail(GRANOLA_REFUSED);
  };
  const done = (result: Record<string, unknown>): ToolOutcome => ({ result: { source: "Granola", ...result }, refs: [] });

  switch (name) {
    case "search_meetings": {
      const r = await searchGranolaNotes(granola.key, { ...(keywords.length > 0 ? { keywords } : {}), ...filters }, opts);
      if (!r.ok) return refused(r.failure, false);
      return done({ meetings: r.meetings.map((m) => ({ meeting_id: m.id, title: m.title, date: m.date })) });
    }
    case "get_meeting": {
      const r = await getGranolaNote(granola.key, a.meeting_id as string, opts);
      if (!r.ok) return refused(r.failure, true);
      const n = r.note;
      return done({
        meeting: {
          title: n.title,
          date: n.date,
          attendees: n.attendees.map((p) => ({ name: p.name, email: p.email })),
          ...(n.moreAttendees > 0 ? { attendees_not_shown: n.moreAttendees } : {}),
          summary: n.summary,
          link: n.url,
        },
      });
    }
    case "search_meeting_transcripts": {
      if (keywords.length === 0) return fail("keywords must not be empty.");
      const meetingId = given("meeting_id");
      const r = await searchGranolaTranscripts(
        granola.key,
        { keywords, ...(meetingId !== undefined ? { noteIds: [meetingId] } : {}), ...filters },
        opts,
      );
      if (!r.ok) return refused(r.failure, meetingId !== undefined);
      return done({
        meetings: r.meetings.map((m) => ({
          meeting_id: m.id,
          title: m.title,
          date: m.date,
          passages: m.passages.slice(0, PASSAGES_PER_MEETING).map((p) => ({ text: p.text, start_time: p.start_time })),
        })),
      });
    }
    default:
      return fail("Unknown tool.");
  }
}

/** Runs one tool. Never throws; a failure is returned as `{ error }` and never carries the thrown message. */
export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome> {
  // Without a key the meeting tools are not tools at all, whatever the model asks for.
  const granola = GRANOLA_NAMES.has(name) ? (ctx.granola?.key ? ctx.granola : null) : undefined;
  if (granola === null) return fail("Unknown tool.");
  const v = validate(name, input);
  if (!v.ok) return fail(v.error);
  try {
    return granola ? await meetingTool(ctx, granola, name, v.args) : await dispatch(ctx, name, v.args);
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
