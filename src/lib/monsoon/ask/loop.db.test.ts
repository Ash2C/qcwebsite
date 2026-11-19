import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../testing/db";
import { runAsk, type AskMessage, type ModelClient } from "./loop";

// The loop with the real tools and a real database; only the model is scripted.
describe.skipIf(!testDb.available)("Ask loop follow-up about a person filed under a company (real Postgres)", () => {
  let db: Client;
  const id = { nw: randomUUID(), jane: randomUUID(), omar: randomUUID(), mNw: randomUUID() };

  beforeEach(async () => {
    vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
    await testDb.reset();
    db = await testDb.connect();
    await db.query("INSERT INTO orgs (id, name, name_key, source) VALUES ($1, 'Northwind Capital', 'northwind capital', 'test')", [id.nw]);
    await db.query(
      `INSERT INTO people (id, org_id, name, name_key, email, source) VALUES
         ($1, $3, 'Jane Tan', 'jane tan', 'jane@nw.example', 'test'), ($2, $3, 'Omar Reyes', 'omar reyes', 'omar@nw.example', 'test')`,
      [id.jane, id.omar, id.nw],
    );
    await db.query("INSERT INTO members (id, org_id, role, stage, source) VALUES ($1, $2, 'investor', 'engaged', 'test')", [id.mNw, id.nw]);
  });
  afterEach(async () => {
    await db.end();
    vi.unstubAllEnvs();
  });

  function client(script: Array<{ stop_reason: string; content: Array<{ type: string; [k: string]: unknown }> }>) {
    const requests: Record<string, unknown>[] = [];
    const c: ModelClient = {
      create: async (params) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        const next = script.shift();
        if (!next) throw new Error("script exhausted");
        return next;
      },
    };
    return { c, requests };
  }
  const deps = (c: ModelClient) => ({
    db,
    customerId: "c0000000-0000-4000-8000-00000000000a",
    estate: "traxo",
    estateLabel: "Traxo",
    defaultRole: "lp_prospect",
    person: { name: "Vincent", ownerKey: "VF" },
    model: "claude-haiku-5-5",
    today: "2026-11-13",
    client: c,
    now: () => Date.now(),
  });

  it("lists two people at one company as two refs, and a follow-up with person_id proposes a note about the person", async () => {
    const found = client([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "find_contacts", input: { query: "nw.example" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Jane Tan and Omar Reyes are at Northwind." }] },
    ]);
    const first = await runAsk(deps(found.c), [{ role: "user", content: "who is at northwind?" }]);
    const people = first.refs.filter((r) => r.personId);
    expect(people.map((r) => [r.name, r.personId, r.memberId, r.kind])).toEqual([
      ["Jane Tan", id.jane, id.mNw, "company"],
      ["Omar Reyes", id.omar, id.mNw, "company"],
    ]);

    const history: AskMessage[] = [
      { role: "user", content: "who is at northwind?" },
      { role: "assistant", content: first.answer, refs: first.refs },
      { role: "user", content: "add a note to Jane: wants the deck" },
    ];
    const follow = client([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "propose_note", input: { person_id: id.jane, text: "wants the deck" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Ready for you to confirm." }] },
    ]);
    const out = await runAsk(deps(follow.c), history);

    const seen = (follow.requests[0].messages as { content: string }[])[1].content;
    expect(seen).toContain(`Jane Tan (filed under Northwind Capital) = person ${id.jane}, company member ${id.mNw}`);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].proposal).toMatchObject({ kind: "add_note", memberId: id.mNw, memberName: "Northwind Capital", about: "Jane Tan" });
    expect(out.proposals[0].text).toBe("Jane Tan: wants the deck");
  });
});
