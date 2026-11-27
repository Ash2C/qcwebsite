import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../testing/db";
import { addTodo, completeTodo, dropTodo, type Viewer } from "../todos";
import { verifyProposal } from "./proposal";
import { carryOutTodo, proposeAddTodo, proposeCompleteTodo, proposeDropTodo, proposeMoveTodo } from "./todo-actions";

const NOW = Date.parse("2026-11-26T09:00:00Z");
const TODAY = "2026-11-26";
const CUSTOMER_A = "c0000000-0000-4000-8000-00000000000a";
const CUSTOMER_B = "c0000000-0000-4000-8000-00000000000b";
const A = { customer: CUSTOMER_A, estate: "main" };
const VF: Viewer = { ownerKey: "VF", solo: true, appOwnerKeys: ["VF"] };

describe.skipIf(!testDb.available)("Ask to-do proposals (real Postgres)", () => {
  let db: Client;
  const id = { raf: randomUUID(), mia: randomUUID(), sam: randomUUID(), mRaf: randomUUID(), mSam: randomUUID() };

  async function todo(title: string, dueDate: string | null, member?: string) {
    const r = await addTodo(db, { title, dueDate, target: member ? { memberId: member } : undefined, source: "app" }, VF, TODAY);
    if (r.status !== "ok") throw new Error("setup failed");
    return r.todo;
  }

  beforeEach(async () => {
    vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
    await testDb.reset();
    db = await testDb.connect();
    await db.query("INSERT INTO orgs (id, name, name_key, source) VALUES ($1, 'Raffles Family Office', 'raffles family office', 'test')", [id.raf]);
    await db.query(
      `INSERT INTO people (id, org_id, name, name_key, source) VALUES
         ($1, $3, 'Mia Chen', 'mia chen', 'test'), ($2, NULL, 'Sam Ortiz', 'sam ortiz', 'test')`,
      [id.mia, id.sam, id.raf],
    );
    await db.query(
      `INSERT INTO members (id, org_id, person_id, role, stage, source) VALUES
         ($1, $3, NULL, 'investor', 'engaged', 'test'), ($2, NULL, $4, 'investor', 'contacted', 'test')`,
      [id.mRaf, id.mSam, id.raf, id.sam],
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.end();
  });

  it("proposes adding a to-do, signed and bound to the customer, with and without a contact", async () => {
    const r = await proposeAddTodo(db, A, { memberId: id.mSam }, "  Send deck ", "2026-12-01", NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(r.signed.proposal).toMatchObject({
      kind: "add_todo", customer: CUSTOMER_A, estate: "main", title: "Send deck", dueDate: "2026-12-01",
      memberId: id.mSam, memberKind: "person", memberName: "Sam Ortiz", aboutPersonId: null,
    });
    expect(verifyProposal(r.signed.proposal, r.signed.signature, NOW)).toBe(true);

    const filed = await proposeAddTodo(db, A, { personId: id.mia }, "Call her", null, NOW);
    if (!filed.ok) throw new Error(filed.reason);
    expect(filed.signed.proposal).toMatchObject({ memberId: id.mRaf, memberKind: "company", aboutPersonId: id.mia, about: "Mia Chen" });

    const loose = await proposeAddTodo(db, A, undefined, "Renew licence", null, NOW);
    if (!loose.ok) throw new Error(loose.reason);
    expect(loose.signed.proposal).toMatchObject({ memberId: null, memberKind: null, memberName: null });
  });

  it("a confirmed add for a person moved to another company since the card was shown writes nothing", async () => {
    const r = await proposeAddTodo(db, A, { personId: id.mia }, "Call her", null, NOW);
    if (!r.ok) throw new Error("propose failed");
    const p = r.signed.proposal;
    if (p.kind !== "add_todo") throw new Error("wrong kind");
    expect(p.memberId).toBe(id.mRaf);
    const nor = randomUUID();
    await db.query("INSERT INTO orgs (id, name, name_key, source) VALUES ($1, 'Norvik AG', 'norvik ag', 'test')", [nor]);
    await db.query("INSERT INTO members (org_id, role, stage, source) VALUES ($1, 'investor', 'engaged', 'test')", [nor]);
    await db.query("UPDATE people SET org_id = $1 WHERE id = $2", [nor, id.mia]);
    expect(await carryOutTodo(db, p, VF, TODAY)).toEqual({ status: "changed", message: "Mia Chen was moved in the meantime; nothing changed." });
    expect((await db.query("SELECT count(*)::int AS n FROM todos")).rows[0].n).toBe(0);
  });

  it("a confirmed add for a person still under the company the card showed is filed there", async () => {
    const r = await proposeAddTodo(db, A, { personId: id.mia }, "Call her", null, NOW);
    if (!r.ok || r.signed.proposal.kind !== "add_todo") throw new Error("propose failed");
    expect((await carryOutTodo(db, r.signed.proposal, VF, TODAY)).status).toBe("added");
    expect((await db.query("SELECT member_id, about_person_id FROM todos")).rows).toEqual([{ member_id: id.mRaf, about_person_id: id.mia }]);
  });

  it("refuses an empty title, a long title, a bad date and a missing contact", async () => {
    expect(await proposeAddTodo(db, A, undefined, "  ", null, NOW)).toEqual({ ok: false, reason: "The to-do is empty." });
    expect((await proposeAddTodo(db, A, undefined, "x".repeat(301), null, NOW)).ok).toBe(false);
    expect(await proposeAddTodo(db, A, undefined, "x", "2026-02-30", NOW)).toEqual({ ok: false, reason: "That date is not a real day." });
    expect(await proposeAddTodo(db, A, { memberId: randomUUID() }, "x", null, NOW)).toEqual({ ok: false, reason: "No such contact." });
  });

  it("proposes ticking off, moving and dropping an open to-do, naming it and its contact", async () => {
    const t = await todo("Send deck", "2026-12-01", id.mSam);
    const c = await proposeCompleteTodo(db, A, VF, t.id, " Sent ", NOW);
    if (!c.ok) throw new Error(c.reason);
    expect(c.signed.proposal).toMatchObject({ kind: "complete_todo", todoId: t.id, title: "Send deck", memberName: "Sam Ortiz", outcome: "Sent" });
    const m = await proposeMoveTodo(db, A, VF, t.id, "2026-12-08", NOW);
    if (!m.ok) throw new Error(m.reason);
    expect(m.signed.proposal).toMatchObject({ kind: "move_todo", todoId: t.id, fromDate: "2026-12-01", toDate: "2026-12-08" });
    const cleared = await proposeMoveTodo(db, A, VF, t.id, null, NOW);
    if (!cleared.ok) throw new Error(cleared.reason);
    expect(cleared.signed.proposal).toMatchObject({ toDate: null });
    const d = await proposeDropTodo(db, A, VF, t.id, NOW);
    if (!d.ok) throw new Error(d.reason);
    expect(d.signed.proposal).toMatchObject({ kind: "drop_todo", todoId: t.id, title: "Send deck", memberName: "Sam Ortiz" });
    for (const s of [c, m, cleared, d]) expect(verifyProposal(s.signed.proposal, s.signed.signature, NOW)).toBe(true);
    const plain = await proposeCompleteTodo(db, A, VF, t.id, undefined, NOW);
    if (!plain.ok) throw new Error(plain.reason);
    expect(plain.signed.proposal).toMatchObject({ outcome: null });
  });

  it("says why when the to-do is already done, dropped, gone, or nothing would change", async () => {
    const t = await todo("Send deck", "2026-12-01");
    await completeTodo(db, t.id, VF, TODAY);
    expect(await proposeCompleteTodo(db, A, VF, t.id, null, NOW)).toEqual({ ok: false, reason: "That to-do is already done." });
    expect(await proposeDropTodo(db, A, VF, t.id, NOW)).toEqual({ ok: false, reason: "That to-do is already done." });
    expect(await proposeMoveTodo(db, A, VF, t.id, "2026-12-08", NOW)).toEqual({ ok: false, reason: "That to-do is already done." });
    const u = await todo("Other", "2026-12-01");
    await dropTodo(db, u.id, VF, TODAY);
    expect(await proposeCompleteTodo(db, A, VF, u.id, null, NOW)).toEqual({ ok: false, reason: "That to-do was dropped." });
    expect(await proposeDropTodo(db, A, VF, u.id, NOW)).toEqual({ ok: false, reason: "That to-do was dropped." });
    const w = await todo("Same", "2026-12-01");
    expect(await proposeMoveTodo(db, A, VF, w.id, "2026-12-01", NOW)).toEqual({ ok: false, reason: "Nothing to change." });
    expect(await proposeMoveTodo(db, A, VF, w.id, "2026-13-01", NOW)).toEqual({ ok: false, reason: "That date is not a real day." });
    expect(await proposeDropTodo(db, A, VF, randomUUID(), NOW)).toEqual({ ok: false, reason: "That to-do is no longer there." });
    expect(await proposeDropTodo(db, A, VF, "not-an-id", NOW)).toEqual({ ok: false, reason: "That to-do is no longer there." });
    expect((await proposeCompleteTodo(db, A, VF, w.id, "x".repeat(2001), NOW)).ok).toBe(false);
  });

  it("a proposal signed for customer A fails verification once it is bound to customer B", async () => {
    const t = await todo("Send deck", "2026-12-01");
    const r = await proposeDropTodo(db, A, VF, t.id, NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(verifyProposal({ ...r.signed.proposal, customer: CUSTOMER_B }, r.signed.signature, NOW)).toBe(false);
    expect(verifyProposal({ ...r.signed.proposal, estate: "other" }, r.signed.signature, NOW)).toBe(false);
  });
});
