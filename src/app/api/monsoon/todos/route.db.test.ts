// The to-do route against a real test CRM, through the test account helper.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeV1TestDb, testDb } from "@/lib/monsoon/testing/db";

vi.mock("@/lib/monsoon/accounts/account", async () => (await import("@/lib/monsoon/testing/account")).mockRequireAccount());

import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { GET, POST } from "./route";

const TODAY = "2026-11-26";
const mia = randomUUID();
const raf = randomUUID();
const mMia = randomUUID();

function get(query: Record<string, string>) {
  const params = new URLSearchParams({ estate: "main", today: TODAY, ...query });
  return GET(new Request(`http://localhost/api/monsoon/todos?${params}`));
}
function post(body: unknown, raw?: string) {
  return POST(
    new Request("http://localhost/api/monsoon/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify({ estate: "main", today: TODAY, ...(body as object) }),
    }),
  );
}

describe.skipIf(!testDb.available)("/api/monsoon/todos (real Postgres)", () => {
  let db: Client;
  let account: ReturnType<typeof fakeAccount>;

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query("INSERT INTO orgs (id, name, name_key, source) VALUES ($1, 'Raffles', 'raffles', 'test')", [raf]);
    await db.query("INSERT INTO people (id, org_id, name, name_key, source) VALUES ($1, $2, 'Mia Chen', 'mia chen', 'test')", [mia, raf]);
    await db.query(
      "INSERT INTO members (id, person_id, role, stage, priority, source) VALUES ($1, $2, 'investor', 'engaged', 'high', 'test')",
      [mMia, mia],
    );
    account = fakeAccount({ db, person: { name: "Dana Lee", ownerKey: "DL" } });
    signInAs(account);
  });
  afterEach(async () => {
    await db.end();
    vi.restoreAllMocks();
  });

  it("answers 401 when signed out", async () => {
    signOut();
    expect((await get({})).status).toBe(401);
    expect((await post({ action: "add", title: "x", dueDate: null })).status).toBe(401);
  });

  it("answers { ready: false } on a CRM below version 2, and 409 on a write", async () => {
    const v1 = makeV1TestDb("todos_route_v1");
    await v1.reset();
    const old = await v1.connect();
    try {
      signInAs(fakeAccount({ db: old }));
      const res = await get({});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ready: false });
      const w = await post({ action: "add", title: "Call", dueDate: TODAY });
      expect(w.status).toBe(409);
      expect(await w.json()).toEqual({ error: "To do is being set up for this CRM." });
    } finally {
      await old.end();
    }
  });

  it("adds a to-do under its real owner name and lists it in the right bucket", async () => {
    const res = await post({ action: "add", title: "  Call Mia  ", dueDate: TODAY, target: { memberId: mMia } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.todo.title).toBe("Call Mia");
    expect(body.todo.contact.name).toBe("Mia Chen");
    expect((await db.query("SELECT display_name FROM owners WHERE key = 'DL'")).rows[0].display_name).toBe("Dana Lee");
    expect((await db.query("SELECT source FROM todos")).rows[0].source).toBe("app");
    expect(account.record).toHaveBeenCalledWith("act_details", "main");

    const list = await (await get({})).json();
    expect(list.ready).toBe(true);
    expect(list.open.map((t: { title: string; due: string }) => [t.title, t.due])).toEqual([["Call Mia", "today"]]);
    expect(list.done).toEqual([]);
    expect(list.nudges).toBeDefined();
  });

  it("keeps the source to app or next, and refuses ask and notes", async () => {
    expect((await post({ action: "add", title: "A", dueDate: null, source: "next" })).status).toBe(200);
    expect((await post({ action: "add", title: "B", dueDate: null, source: "ask" })).status).toBe(400);
    expect((await post({ action: "add", title: "C", dueDate: null, source: "notes" })).status).toBe(400);
    expect((await db.query("SELECT title, source FROM todos ORDER BY title")).rows).toEqual([{ title: "A", source: "next" }]);
  });

  it("complete then outcome leaves two timeline entries, and complete twice is 'already'", async () => {
    const added = await (await post({ action: "add", title: "Send deck", dueDate: TODAY, target: { memberId: mMia } })).json();
    const id = added.todo.id;
    expect((await (await post({ action: "complete", id })).json()).status).toBe("ok");
    expect((await (await post({ action: "complete", id })).json()).status).toBe("already");
    const out = await post({ action: "outcome", id, outcome: "She liked it" });
    expect((await out.json()).todo.outcome).toBe("She liked it");
    const kinds = (await db.query("SELECT kind FROM touches WHERE member_id = $1 ORDER BY at, id", [mMia])).rows.map((r) => r.kind);
    expect(kinds).toEqual(["system", "note"]);
    const list = await (await get({})).json();
    expect(list.open).toEqual([]);
    expect(list.done.map((t: { title: string }) => t.title)).toEqual(["Send deck"]);
  });

  it("edit with target null detaches the contact; drop and reopen work", async () => {
    const added = await (await post({ action: "add", title: "Ping", dueDate: null, target: { memberId: mMia } })).json();
    const id = added.todo.id;
    const edited = await (await post({ action: "edit", id, target: null, title: "Ping Mia" })).json();
    expect(edited.todo.contact).toBeNull();
    expect(edited.todo.title).toBe("Ping Mia");
    expect((await (await post({ action: "drop", id })).json()).todo.status).toBe("dropped");
    expect((await (await post({ action: "reopen", id })).json()).todo.status).toBe("open");
  });

  it("answers 400 for a 301 character title, an unknown action and a malformed body", async () => {
    const long = await post({ action: "add", title: "x".repeat(301), dueDate: null });
    expect(long.status).toBe(400);
    expect(typeof (await long.json()).error).toBe("string");
    expect((await post({ action: "explode" })).status).toBe(400);
    expect((await post({ action: "add", title: 5, dueDate: null })).status).toBe(400);
    expect((await post({ action: "add", title: "ok", dueDate: 12 })).status).toBe(400);
    expect((await post({ action: "complete" })).status).toBe(400);
    expect((await post({ action: "edit", id: randomUUID(), target: "nope" })).status).toBe(400);
    expect((await post(null, "[1]")).status).toBe(400);
    expect((await post({ estate: "elsewhere", action: "add", title: "x", dueDate: null })).status).toBe(400);
    expect((await post({ action: "add", title: "x", dueDate: "2026-02-31" })).status).toBe(400);
  });

  it("answers 404 for a to-do that is not there", async () => {
    const res = await post({ action: "complete", id: randomUUID() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "That to-do is no longer there." });
    // Gone to-do and a contact off the pipeline: the to-do being gone is what the user needs to hear.
    const both = await post({ action: "edit", id: randomUUID(), target: { memberId: randomUUID() } });
    expect(both.status).toBe(404);
    expect(await both.json()).toEqual({ error: "That to-do is no longer there." });
  });

  it("answers 400 with its own wording when the contact is not on this pipeline, on add and on edit", async () => {
    const offPipeline = randomUUID();
    await db.query("INSERT INTO people (id, org_id, name, name_key, source) VALUES ($1, NULL, 'Ola Berg', 'ola berg', 'test')", [offPipeline]);
    const notOn = { error: "That contact is not on this pipeline yet." };
    for (const target of [{ personId: offPipeline }, { memberId: randomUUID() }]) {
      const add = await post({ action: "add", title: "Call Ola", dueDate: null, target });
      expect(add.status).toBe(400);
      expect(await add.json()).toEqual(notOn);
    }
    expect((await db.query("SELECT count(*)::int AS n FROM todos")).rows[0].n).toBe(0);
    const id = (await (await post({ action: "add", title: "Ping", dueDate: null })).json()).todo.id;
    const edit = await post({ action: "edit", id, target: { personId: offPipeline } });
    expect(edit.status).toBe(400);
    expect(await edit.json()).toEqual(notOn);
    expect((await db.query("SELECT member_id FROM todos WHERE id = $1", [id])).rows).toEqual([{ member_id: null }]);
  });

  it("does not trust the browser's today raw", async () => {
    const res = await get({ today: "not-a-date" });
    expect(res.status).toBe(200);
    expect((await res.json()).ready).toBe(true);
  });

  it("another customer's estate is unknown (400), not readable", async () => {
    signInAs(fakeAccount({ db, pipelines: [{ key: "other", label: "Other", defaultRole: "investor", connected: true }] }));
    expect((await get({})).status).toBe(400);
    expect((await post({ action: "add", title: "x", dueDate: null })).status).toBe(400);
  });

  it("snooze hides the nudge, and a profile read leaves nudges out", async () => {
    const before = await (await get({})).json();
    expect(before.nudges.noNextStep.map((n: { contact: { memberId: string } }) => n.contact.memberId)).toContain(mMia);
    const snoozed = await post({ action: "snooze", memberId: mMia });
    expect(snoozed.status).toBe(200);
    expect(account.record).toHaveBeenCalledWith("act_details", "main");
    const after = await (await get({})).json();
    expect(after.nudges.noNextStep).toEqual([]);
    expect((await post({ action: "snooze", memberId: randomUUID() })).status).toBe(404);
    expect((await post({ action: "snooze" })).status).toBe(400);

    const profile = await (await get({ member: mMia })).json();
    expect(profile.ready).toBe(true);
    expect(profile.nudges).toBeUndefined();
    expect((await (await get({ nudges: "all" })).json()).nudges).toBeDefined();
  });

  it("answers 502 naming only the CRM when the database fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = Object.assign(new Error("secret host"), { code: "ECONNREFUSED" });
    signInAs({ ...fakeAccount(), withDb: async () => Promise.reject(down) });
    const res = await get({});
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not reach the Main CRM" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret host");
  });
});
