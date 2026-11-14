// Reads the contact a research run is about. Read-only: one read-only transaction, nothing written.
import type { ClientBase } from "pg";
import { readOnly } from "./ask/queries";
import { logMemberFor } from "./details";
import type { ResearchSubject } from "./research";

export type SubjectRead =
  | {
      ok: true;
      subject: ResearchSubject;
      person: { id: string; name: string };
      company: { id: string; name: string } | null;
      logMemberId: string | null;
    }
  | { ok: false; reason: "missing" | "company" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** Read-only. memberId of a company member → "company". */
export function readSubject(db: ClientBase, target: { memberId?: string; personId?: string }): Promise<SubjectRead> {
  return readOnly(db, async (): Promise<SubjectRead> => {
    let personId: string | undefined;
    if (isUuid(target.personId)) {
      personId = target.personId;
    } else if (isUuid(target.memberId)) {
      const m = (await db.query("SELECT person_id FROM members WHERE id = $1", [target.memberId])).rows[0];
      if (!m) return { ok: false, reason: "missing" };
      if (!m.person_id) return { ok: false, reason: "company" };
      personId = m.person_id;
    }
    if (!personId) return { ok: false, reason: "missing" };

    const p = (
      await db.query(
        "SELECT id, name, org_id, title, email, phone, linkedin_url, country FROM people WHERE id = $1",
        [personId],
      )
    ).rows[0];
    if (!p) return { ok: false, reason: "missing" };
    const org = p.org_id
      ? (await db.query("SELECT id, name, website FROM orgs WHERE id = $1", [p.org_id])).rows[0]
      : undefined;
    const logMemberId = await logMemberFor(db, { type: "person", id: p.id, orgId: p.org_id ?? null });
    return {
      ok: true,
      subject: {
        name: p.name,
        company: org?.name ?? null,
        companyWebsite: org?.website ?? null,
        title: p.title ?? null,
        email: p.email ?? null,
        phone: p.phone ?? null,
        linkedin: p.linkedin_url ?? null,
        country: p.country ?? null,
      },
      person: { id: p.id, name: p.name },
      company: org ? { id: org.id, name: org.name } : null,
      logMemberId,
    };
  });
}
