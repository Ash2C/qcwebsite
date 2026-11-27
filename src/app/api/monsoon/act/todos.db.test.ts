// Carrying out the four to-do proposals through the act route, against a real test CRM.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signProposal, type Proposal } from "@/lib/monsoon/ask/proposal";
import { addTodo, completeTodo, dropTodo, editTodo, type Viewer } from "@/lib/monsoon/todos";
import { testDb } from "@/lib/monsoon/testing/db";

vi.mock("@/lib/monsoon/accounts/account", async () => (await import("@/lib/monsoon/testing/account")).mockRequireAccount());

import { fakeAccount, signInAs } from "@/lib/monsoon/testing/account";
import { POST } from "./route";

const CUSTOMER = "00000000-0000-4000-8000-000000000001";
const TODAY = "2026-11-26";
const VF: Viewer = { ownerKey: "DL", solo: true, appOwnerKeys: ["DL"] };

describe.skipIf(!testDb.available)("/api/monsoon/act to-do proposals (real Postgres)", () => {
  let db: Client;
  let account: ReturnType<typeof fakeAccount>;
  const id = { raf: randomUUID(), mia: randomUUID(), mRaf: randomUUID() };

  const base = () => ({ customer: CUSTOMER, estate: "main", expires: Date.now() + 600_000 });
  function act(proposal: Proposal, over: Record<string, unknown> = {}) {
    return POST(
      new Request("http://localhost/api/monsoon/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estate: "main", proposal, signature: signProposal(proposal), ...over }),
      }),
    );
  }
  async function todo(title: string, dueDate: string | null) {
    const r = await addTodo(db, { title, dueDate, target: { memberId: id.mRaf }, source: "app" }, VF, TODAY);
    if (r.status !== "ok") throw new Error("setup failed");
    return r.todo;
  }
  const rows = async (where = "TRUE") => (await db.query(`SELECT * FROM todos WHERE ${where} ORDER BY created_at`)).rows;
  const touches = async () => (await db.query("SELECT kind, summary FROM touches WHERE member_id = $1 ORDER BY at, id", [id.mRaf])).rows;

  beforeEach(async () => {
    vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
    await testDb.reset();
    db = await testDb.connect();
    await db.query("INSERT INTO orgs (id, name, name_key, source) VALUES ($1, 'Raffles', 'raffles', 'test')", [id.raf]);
    await db.query("INSERT INTO people (id, org_id, name, name_key, source) VALUES ($1, $2, 'Mia Chen', 'mia chen', 'test')", [id.mia, id.raf]);
    await db.query("INSERT INTO members (id, org_id, role, stage, source) VALUES ($1, $2, 'investor', 'engaged', 'test')", [id.mRaf, id.raf]);
    account = fakeAccount({ db, person: { name: "Dana Lee", ownerKey: "DL" } });
    signInAs(account);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.end();
  });

  it("add_todo creates a to-do with source ask, owned by the person and filed under the contact", async () => {
    const res = await act({
      kind: "add_todo", ...base(), title: "Send deck", dueDate: "2026-12-01",
      memberId: id.mRaf, memberKind: "company", memberName: "Raffles", company: null, aboutPersonId: id.mia, about: "Mia Chen",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("Done. To-do added: Send deck.");
    const [t] = await rows();
    expect(t).toMatchObject({ title: "Send deck", source: "ask", owner: "DL", member_id: id.mRaf, about_person_id: id.mia, status: "open" });
    expect(String(t.due_date)).toContain("2026");
    expect((await db.query("SELECT display_name FROM owners WHERE key = 'DL'")).rows[0].display_name).toBe("Dana Lee");
  });

  it("add_todo without a contact is a loose to-do, and a contact gone from the pipeline changes nothing", async () => {
    const loose = await act({
      kind: "add_todo", ...base(), title: "Renew licence", dueDate: null,
      memberId: null, memberKind: null, memberName: null, company: null, aboutPersonId: null, about: null,
    });
    expect(loose.status).toBe(200);
    expect((await rows())[0]).toMatchObject({ member_id: null, source: "ask" });

    const gone = await act({
      kind: "add_todo", ...base(), title: "Call", dueDate: null,
      memberId: randomUUID(), memberKind: "person", memberName: "Ghost", company: null, aboutPersonId: null, about: null,
    });
    expect(gone.status).toBe(200);
    expect((await gone.json()).message).toBe("Ghost is no longer on the pipeline; nothing changed.");
    expect(await rows()).toHaveLength(1);
  });

  it("complete_todo with an outcome writes the system entry and the note entry, and ticks it off", async () => {
    const t = await todo("Send deck", "2026-12-01");
    const res = await act({ kind: "complete_todo", ...base(), todoId: t.id, title: "Send deck", memberName: "Raffles", outcome: "Sent, she liked it" });
    expect((await res.json()).message).toBe("Done. Send deck is ticked off.");
    const [row] = await rows();
    expect(row).toMatchObject({ status: "done", outcome: "Sent, she liked it" });
    const log = await touches();
    expect(log.map((e) => e.kind)).toEqual(["system", "note"]);
    expect(log[0].summary).toBe("To-do done: Send deck");
    expect(log[1].summary).toBe("Send deck: Sent, she liked it");
  });

  it("complete_todo without an outcome only ticks it", async () => {
    const t = await todo("Send deck", null);
    await act({ kind: "complete_todo", ...base(), todoId: t.id, title: "Send deck", memberName: "Raffles", outcome: null });
    expect((await rows())[0]).toMatchObject({ status: "done", outcome: null });
    expect((await touches()).map((e) => e.kind)).toEqual(["system"]);
  });

  it("answers for a stale change the way the other kinds do, and changes nothing", async () => {
    const done = await todo("Ticked", "2026-12-01");
    await completeTodo(db, done.id, VF, TODAY);
    const r1 = await act({ kind: "complete_todo", ...base(), todoId: done.id, title: "Ticked", memberName: null, outcome: "x" });
    expect((await r1.json()).message).toBe("Ticked is already done; nothing changed.");

    const dropped = await todo("Dropped", "2026-12-01");
    await dropTodo(db, dropped.id, VF, TODAY);
    const r2 = await act({ kind: "drop_todo", ...base(), todoId: dropped.id, title: "Dropped", memberName: null });
    expect((await r2.json()).message).toBe("Dropped is already dropped; nothing changed.");
    const r3 = await act({ kind: "complete_todo", ...base(), todoId: dropped.id, title: "Dropped", memberName: null, outcome: null });
    expect((await r3.json()).message).toBe("Dropped was changed in the meantime; nothing changed.");

    const edited = await todo("Old title", "2026-12-01");
    await editTodo(db, edited.id, { title: "New title" }, VF, TODAY);
    const r4 = await act({ kind: "drop_todo", ...base(), todoId: edited.id, title: "Old title", memberName: null });
    expect((await r4.json()).message).toBe("Old title was changed in the meantime; nothing changed.");
    expect((await db.query("SELECT status FROM todos WHERE id = $1", [edited.id])).rows[0].status).toBe("open");

    const r5 = await act({ kind: "drop_todo", ...base(), todoId: randomUUID(), title: "Nope", memberName: null });
    expect((await r5.json()).message).toBe("That to-do is no longer there; nothing changed.");
    expect((await db.query("SELECT count(*)::int AS n FROM todos WHERE outcome IS NOT NULL")).rows[0].n).toBe(0);
  });

  it("move_todo moves the date, counts the move, and refuses when the date changed meanwhile", async () => {
    const t = await todo("Send deck", "2026-12-01");
    const res = await act({ kind: "move_todo", ...base(), todoId: t.id, title: "Send deck", memberName: null, fromDate: "2026-12-01", toDate: "2026-12-08" });
    expect((await res.json()).message).toBe("Done. Send deck moved to 2026-12-08.");
    expect((await rows())[0]).toMatchObject({ moved_count: 1 });

    const again = await act({ kind: "move_todo", ...base(), todoId: t.id, title: "Send deck", memberName: null, fromDate: "2026-12-01", toDate: "2026-12-08" });
    expect((await again.json()).message).toBe("Send deck is already due 2026-12-08; nothing changed.");
    const stale = await act({ kind: "move_todo", ...base(), todoId: t.id, title: "Send deck", memberName: null, fromDate: "2026-12-01", toDate: "2026-12-15" });
    expect((await stale.json()).message).toBe("Send deck was changed in the meantime; nothing changed.");

    const clear = await act({ kind: "move_todo", ...base(), todoId: t.id, title: "Send deck", memberName: null, fromDate: "2026-12-08", toDate: null });
    expect((await clear.json()).message).toBe("Done. Send deck now has no date.");
    expect((await rows())[0].due_date).toBeNull();
  });

  it("drop_todo drops the to-do and leaves a timeline entry", async () => {
    const t = await todo("Send deck", "2026-12-01");
    const res = await act({ kind: "drop_todo", ...base(), todoId: t.id, title: "Send deck", memberName: "Raffles" });
    expect((await res.json()).message).toBe("Done. Send deck dropped.");
    expect((await rows())[0].status).toBe("dropped");
    expect((await touches()).map((e) => e.summary)).toEqual(["To-do dropped: Send deck"]);
  });

  it("refuses a to-do proposal whose title was changed after signing", async () => {
    const t = await todo("Send deck", "2026-12-01");
    const p: Proposal = { kind: "drop_todo", ...base(), todoId: t.id, title: "Send deck", memberName: null };
    const res = await act({ ...p, title: "Something else" } as Proposal, { signature: signProposal(p) });
    expect(res.status).toBe(403);
    expect((await rows())[0].status).toBe("open");
  });
});
