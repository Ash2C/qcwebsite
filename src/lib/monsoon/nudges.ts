// Nudges: contacts that deserve a to-do. Two lists, "no next step" and "gone quiet", plus
// "Not now", which hides a contact's nudge for 14 days. Reads only, apart from the one
// members.nudge_after column the snooze sets. Nothing here deletes.
import type { ClientBase } from "pg";
import { actionTouches, readOnly, type QueryOptions } from "./ask/queries";
import { contactFromRow, type TodoContact, type Viewer } from "./todos";

export const NUDGE_PAGE = 10;
export const SNOOZE_DAYS = 14;
export const QUIET_DAYS = { high: 30, medium: 60 } as const;

export type Nudge = { kind: "no_next_step" | "quiet"; contact: TodoContact; quietDays: number | null };
export type Nudges = { noNextStep: Nudge[]; quiet: Nudge[]; noNextStepTotal: number; quietTotal: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parameters: $1 today, $2 solo, $3 owner key, $4 high days, $5 medium days. Days are whole UTC
// calendar days, from the day of the newest real contact (else the day the contact was added).
const CANDIDATES = `
  WITH base AS (
    SELECT m.id AS member_id, m.person_id, m.org_id, m.stage, s.ord, s.label AS stage_label, m.priority,
           CASE WHEN m.person_id IS NOT NULL THEN 'person' ELSE 'company' END AS kind,
           COALESCE(p.name, o.name) AS name,
           CASE WHEN m.person_id IS NOT NULL THEN po.name END AS company,
           NOT EXISTS (SELECT 1 FROM todos t WHERE t.member_id = m.id AND t.status = 'open') AS no_todo,
           ($1::date - (COALESCE(lt.last_at, m.created_at) AT TIME ZONE 'UTC')::date) AS quiet_days
      FROM members m
      JOIN stages s ON s.key = m.stage
      LEFT JOIN people p ON p.id = m.person_id
      LEFT JOIN orgs po ON po.id = p.org_id
      LEFT JOIN orgs o ON o.id = m.org_id
      LEFT JOIN LATERAL (
        SELECT max(t.at) AS last_at FROM touches t
         WHERE t.member_id = m.id AND t.kind IN ('note', 'email', 'call', 'meeting')
      ) lt ON true
     WHERE NOT s.terminal
       AND (m.nudge_after IS NULL OR m.nudge_after <= $1::date)
       AND ($2::boolean OR m.owner = $3)
  ), flagged AS (
    SELECT *,
           (no_todo AND (ord > (SELECT min(ord) FROM stages) OR priority = 'high')) AS needs_step,
           ((priority = 'high' AND quiet_days >= $4::int) OR (priority = 'medium' AND quiet_days >= $5::int)) AS is_quiet
      FROM base
  )`;

const ORDER = `
  ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
           ord DESC, name, member_id`;

async function page(
  db: ClientBase,
  which: "no_next_step" | "quiet",
  params: unknown[],
  limit: number,
): Promise<{ rows: Nudge[]; total: number }> {
  const filter = which === "no_next_step" ? "needs_step" : "is_quiet AND NOT needs_step";
  // LIMIT 0 would hide the total, so ask for at least one row and trim.
  const r = await db.query(
    `${CANDIDATES}
     SELECT *, count(*) OVER ()::int AS total FROM flagged WHERE ${filter} ${ORDER} LIMIT $6::int`,
    [...params, Math.max(limit, 1)],
  );
  const shown = r.rows.slice(0, limit);
  const touches = await actionTouches(db, shown.map((row) => row.member_id as string));
  return {
    rows: shown.map((row) => ({
      kind: which,
      contact: contactFromRow(row, touches.get(row.member_id) ?? []),
      quietDays: which === "quiet" ? (row.quiet_days as number) : null,
    })),
    total: r.rows.length > 0 ? (r.rows[0].total as number) : 0,
  };
}

/**
 * The two nudge lists for the viewer's contacts (every contact when solo): contacts with no open
 * to-do, and important contacts with no real contact for a while. A contact in both lists is in
 * the first only. Each list is cut to `limit` rows (default 10); the totals count them all.
 */
export function listNudges(
  db: ClientBase,
  viewer: Viewer,
  today: string,
  opts?: QueryOptions & { limit?: number },
): Promise<Nudges> {
  const wanted = opts?.limit;
  const limit = typeof wanted === "number" && Number.isFinite(wanted) ? Math.max(0, Math.trunc(wanted)) : NUDGE_PAGE;
  const params = [today, viewer.solo, viewer.ownerKey, QUIET_DAYS.high, QUIET_DAYS.medium];
  return readOnly(
    db,
    async () => {
      const first = await page(db, "no_next_step", params, limit);
      const second = await page(db, "quiet", params, limit);
      return { noNextStep: first.rows, quiet: second.rows, noNextStepTotal: first.total, quietTotal: second.total };
    },
    opts,
  );
}

/** "Not now": hides the contact's nudges for 14 days from `today`. Changes only members.nudge_after. */
export async function snoozeNudge(db: ClientBase, memberId: string, today: string): Promise<{ status: "ok" | "missing" }> {
  if (typeof memberId !== "string" || !UUID_RE.test(memberId)) return { status: "missing" };
  const r = await db.query("UPDATE members SET nudge_after = $2::date + $3::int WHERE id = $1 RETURNING id", [
    memberId,
    today,
    SNOOZE_DAYS,
  ]);
  return { status: r.rows.length > 0 ? "ok" : "missing" };
}
