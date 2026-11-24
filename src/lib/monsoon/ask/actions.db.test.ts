import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOwner } from "../owners";
import { testDb } from "../testing/db";
import {
  addNote,
  moveStage,
  proposeNextAction,
  proposeNote,
  proposePriority,
  proposeRole,
  proposeStage,
  setNextAction,
  setPriority,
  setRole,
} from "./actions";
import { verifyProposal } from "./proposal";

const NOW = 1_800_000_000_000;
const CUSTOMER = "c0000000-0000-4000-8000-00000000000a";
const ZEROONE = { customer: CUSTOMER, estate: "zeroone" };
const TRAXO = { customer: CUSTOMER, estate: "traxo" };

describe.skipIf(!testDb.available)("Ask writes (real Postgres)", () => {
  let db: Client;
  const id = {
    nw: randomUUID(),
    acme: randomUUID(),
    orphan: randomUUID(),
    jane: randomUUID(),
    liwei: randomUUID(),
    sam: randomUUID(),
    mNw: randomUUID(),
    mLi: randomUUID(),
  };

  async function count(table: string, where = "TRUE"): Promise<number> {
    const r = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
    return r.rows[0].n;
  }
  async function snapshot() {
    const tables = ["orgs", "people", "members", "touches"];
    const out: Record<string, unknown> = {};
    for (const t of tables) out[t] = (await db.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
    return out;
  }

  beforeEach(async () => {
    vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
    await testDb.reset();
    db = await testDb.connect();
    await db.query(
      `INSERT INTO orgs (id, name, name_key, source) VALUES
         ($1, 'Northwind Capital', 'northwind capital', 'test'),
         ($2, 'Acme Capital', 'acme capital', 'test'),
         ($3, 'Orphan Co', 'orphan co', 'test')`,
      [id.nw, id.acme, id.orphan],
    );
    await db.query(
      `INSERT INTO people (id, org_id, name, name_key, source) VALUES
         ($1, $4, 'Jane Tan', 'jane tan', 'test'),
         ($2, $5, 'Li Wei', 'li wei', 'test'),
         ($3, $6, 'Sam Ortiz', 'sam ortiz', 'test')`,
      [id.jane, id.liwei, id.sam, id.nw, id.acme, id.orphan],
    );
    await db.query(
      `INSERT INTO members (id, org_id, person_id, role, stage, owner, source) VALUES
         ($1, $3, NULL, 'investor', 'engaged', 'VF', 'test'),
         ($2, NULL, $4, 'investor', 'contacted', 'VF', 'test')`,
      [id.mNw, id.mLi, id.nw, id.liwei],
    );
  });
  afterEach(async () => {
    await db.end();
    vi.unstubAllEnvs();
  });

  describe("proposeNote", () => {
    it("proposes for a person member", async () => {
      const r = await proposeNote(db, ZEROONE, { memberId: id.mLi }, "  called back  ", NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.signed.proposal).toEqual({
        kind: "add_note",
        customer: CUSTOMER,
        estate: "zeroone",
        memberId: id.mLi,
        memberKind: "person",
        memberName: "Li Wei",
        company: "Acme Capital",
        about: null,
        expires: NOW + 30 * 60 * 1000,
      });
      expect(r.signed.text).toBe("called back");
      expect(verifyProposal(r.signed.proposal, r.signed.signature, NOW)).toBe(true);
    });

    it("proposes for a company member", async () => {
      const r = await proposeNote(db, TRAXO, { memberId: id.mNw }, "review in March", NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.signed.proposal).toMatchObject({
        memberKind: "company",
        memberName: "Northwind Capital",
        company: null,
        about: null,
      });
    });

    it("applies a note about a person to the company member and prefixes the name", async () => {
      const r = await proposeNote(db, ZEROONE, { personId: id.jane }, "wants the deck in January", NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.signed.proposal).toMatchObject({ memberId: id.mNw, memberName: "Northwind Capital", about: "Jane Tan" });
      expect(r.signed.text).toBe("Jane Tan: wants the deck in January");
    });

    it("does not double-prefix text that already starts with the name", async () => {
      const r = await proposeNote(db, ZEROONE, { personId: id.jane }, "Jane Tan: wants the deck", NOW);
      expect(r.ok && r.signed.text).toBe("Jane Tan: wants the deck");
    });

    it("matches the name on a word boundary and without regard to case when prefixing", async () => {
      const text = async (t: string) => {
        const r = await proposeNote(db, ZEROONE, { personId: id.jane }, t, NOW);
        return r.ok ? r.signed.text : null;
      };
      expect(await text("Jane Tanaka wants the deck")).toBe("Jane Tan: Jane Tanaka wants the deck");
      expect(await text("jane tan: wants the deck")).toBe("jane tan: wants the deck");
      expect(await text("JANE TAN wants the deck")).toBe("JANE TAN wants the deck");
      expect(await text("Jane Tan, wants the deck")).toBe("Jane Tan, wants the deck");
      expect(await text("Jane Tan")).toBe("Jane Tan");
      expect(await text("Jane Tanner called")).toBe("Jane Tan: Jane Tanner called");
      expect(await text("Not Jane Tan")).toBe("Jane Tan: Not Jane Tan");
    });

    it("uses the person's own member when there is one", async () => {
      const r = await proposeNote(db, ZEROONE, { personId: id.liwei }, "hello", NOW);
      const proposal = r.ok ? r.signed.proposal : undefined;
      expect(proposal?.kind === "add_note" && proposal.memberId).toBe(id.mLi);
      expect(proposal?.kind === "add_note" && proposal.about).toBeNull();
    });

    it("explains a person who is on file but not on the pipeline", async () => {
      const r = await proposeNote(db, ZEROONE, { personId: id.sam }, "hello", NOW);
      expect(r).toEqual({
        ok: false,
        reason: "Sam Ortiz is on file but not on the pipeline, so there is no timeline to change. Capture can add them.",
      });
    });

    it("refuses an unknown or malformed target", async () => {
      for (const target of [{}, { memberId: "nope" }, { memberId: randomUUID() }, { personId: randomUUID() }, { personId: "x" }]) {
        expect(await proposeNote(db, ZEROONE, target, "hello", NOW)).toEqual({ ok: false, reason: "No such contact." });
      }
    });

    it("refuses blank and over-long text, accepts exactly 2,000", async () => {
      expect((await proposeNote(db, ZEROONE, { memberId: id.mLi }, "   ", NOW)).ok).toBe(false);
      expect((await proposeNote(db, ZEROONE, { memberId: id.mLi }, "x".repeat(2001), NOW)).ok).toBe(false);
      expect((await proposeNote(db, ZEROONE, { memberId: id.mLi }, "x".repeat(2000), NOW)).ok).toBe(true);
    });
  });

  describe("proposeStage", () => {
    it("proposes a move with the current stage as from", async () => {
      const r = await proposeStage(db, ZEROONE, { memberId: id.mLi }, "client", NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.signed.proposal).toEqual({
        kind: "move_stage",
        customer: CUSTOMER,
        estate: "zeroone",
        memberId: id.mLi,
        memberKind: "person",
        memberName: "Li Wei",
        company: "Acme Capital",
        about: null,
        fromStage: "contacted",
        toStage: "client",
        expires: NOW + 30 * 60 * 1000,
      });
      expect(verifyProposal(r.signed.proposal, r.signed.signature, NOW)).toBe(true);
    });

    it("moves the company for a person filed under a company member", async () => {
      const r = await proposeStage(db, ZEROONE, { personId: id.jane }, "client", NOW);
      expect(r.ok && r.signed.proposal).toMatchObject({ memberId: id.mNw, about: "Jane Tan", fromStage: "engaged" });
    });

    it("lists the stages for an unknown stage", async () => {
      expect(await proposeStage(db, ZEROONE, { memberId: id.mLi }, "won", NOW)).toEqual({
        ok: false,
        reason: "Unknown stage. Stages are: uncontacted, contacted, engaged, client, passed.",
      });
    });

    it("refuses the stage the member is already in", async () => {
      expect(await proposeStage(db, ZEROONE, { memberId: id.mLi }, "contacted", NOW)).toEqual({
        ok: false,
        reason: "Li Wei is already in contacted.",
      });
    });

    it("refuses an unknown contact and a person not on the pipeline", async () => {
      expect(await proposeStage(db, ZEROONE, {}, "client", NOW)).toEqual({ ok: false, reason: "No such contact." });
      const r = await proposeStage(db, ZEROONE, { personId: id.sam }, "client", NOW);
      expect(!r.ok && r.reason).toContain("on file but not on the pipeline");
    });
  });

  it("a propose call writes nothing", async () => {
    const before = await snapshot();
    await proposeNote(db, ZEROONE, { memberId: id.mLi }, "hello", NOW);
    await proposeNote(db, ZEROONE, { personId: id.jane }, "hello", NOW);
    await proposeStage(db, ZEROONE, { memberId: id.mLi }, "client", NOW);
    await proposeStage(db, ZEROONE, { personId: id.sam }, "client", NOW);
    expect(await snapshot()).toEqual(before);
  });

  describe("next action", () => {
    const next = async (member: string) =>
      (await db.query("SELECT next_action, next_action_date::text AS d FROM members WHERE id = $1", [member])).rows[0];

    it("proposes a next action with or without a date, signed, and reads only", async () => {
      const before = await snapshot();
      const r = await proposeNextAction(db, ZEROONE, { memberId: id.mLi }, "  Send the deck  ", "2026-12-01", NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.signed.proposal).toMatchObject({
        kind: "set_next_action", memberId: id.mLi, fromAction: null, fromDate: null, toAction: "Send the deck", toDate: "2026-12-01",
      });
      expect(verifyProposal(r.signed.proposal, r.signed.signature, NOW)).toBe(true);
      const undated = await proposeNextAction(db, ZEROONE, { memberId: id.mLi }, "Call", null, NOW);
      expect(undated.ok && undated.signed.proposal).toMatchObject({ toAction: "Call", toDate: null });
      expect(await snapshot()).toEqual(before);
    });

    it("refuses a date that is not a real day, text that is too long, and no change", async () => {
      for (const bad of ["2026-02-30", "tomorrow", "2026-13-01"]) {
        expect(await proposeNextAction(db, ZEROONE, { memberId: id.mLi }, "Call", bad, NOW)).toEqual({ ok: false, reason: "That date is not a real day." });
      }
      expect((await proposeNextAction(db, ZEROONE, { memberId: id.mLi }, "x".repeat(301), null, NOW)).ok).toBe(false);
      // Nothing set and nothing asked: no change. A date with no action is no change either.
      expect(await proposeNextAction(db, ZEROONE, { memberId: id.mLi }, "   ", "2026-12-01", NOW)).toEqual({ ok: false, reason: "Nothing to change." });
      await db.query("UPDATE members SET next_action = 'Call', next_action_date = '2026-12-01' WHERE id = $1", [id.mLi]);
      expect(await proposeNextAction(db, ZEROONE, { memberId: id.mLi }, "Call", "2026-12-01", NOW)).toEqual({ ok: false, reason: "Nothing to change." });
      const cleared = await proposeNextAction(db, ZEROONE, { memberId: id.mLi }, "", null, NOW);
      expect(cleared.ok && cleared.signed.proposal).toMatchObject({ fromAction: "Call", fromDate: "2026-12-01", toAction: null, toDate: null });
    });

    it("sets, changes and clears it, logging each change as a system entry by that person", async () => {
      const none = { action: null, date: null };
      const first = { action: "Send the deck", date: "2026-12-01" };
      const second = { action: "Send the deck", date: null };
      expect((await setNextAction(db, id.mLi, none, first, "VF")).status).toBe("set");
      expect(await next(id.mLi)).toEqual({ next_action: "Send the deck", d: "2026-12-01" });
      expect((await setNextAction(db, id.mLi, first, second, "VF")).status).toBe("set");
      expect(await next(id.mLi)).toEqual({ next_action: "Send the deck", d: null });
      expect((await setNextAction(db, id.mLi, second, none, "VF")).status).toBe("set");
      expect(await next(id.mLi)).toEqual({ next_action: null, d: null });
      const log = await db.query("SELECT kind, by_whom, summary FROM touches WHERE member_id = $1 ORDER BY at", [id.mLi]);
      expect(log.rows).toEqual([
        { kind: "system", by_whom: "VF", summary: "Next action: Send the deck (due 2026-12-01)" },
        { kind: "system", by_whom: "VF", summary: "Next action: Send the deck" },
        { kind: "system", by_whom: "VF", summary: "Next action cleared" },
      ]);
    });

    it("writes nothing when it is already so, changed in the meantime, or the member is gone", async () => {
      await db.query("UPDATE members SET next_action = 'Call', next_action_date = '2026-12-01' WHERE id = $1", [id.mLi]);
      const before = await snapshot();
      const none = { action: null, date: null };
      expect((await setNextAction(db, id.mLi, none, { action: "Email", date: null }, "VF")).status).toBe("changed");
      expect((await setNextAction(db, id.mLi, none, { action: "Call", date: "2026-12-01" }, "VF")).status).toBe("already");
      expect((await setNextAction(db, randomUUID(), none, { action: "Call", date: null }, "VF")).status).toBe("missing");
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("contact type", () => {
    const role = async (member: string) => (await db.query("SELECT role FROM members WHERE id = $1", [member])).rows[0].role;

    it("proposes another of the estate's types, signed, and reads only", async () => {
      const before = await snapshot();
      const r = await proposeRole(db, ZEROONE, { memberId: id.mLi }, "introducer", NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.signed.proposal).toMatchObject({ kind: "set_role", memberId: id.mLi, fromRole: "investor", toRole: "introducer" });
      expect(verifyProposal(r.signed.proposal, r.signed.signature, NOW)).toBe(true);
      expect(await snapshot()).toEqual(before);
    });

    it("refuses an unknown type and the type it already is", async () => {
      const unknown = await proposeRole(db, ZEROONE, { memberId: id.mLi }, "wizard", NOW);
      expect(unknown.ok).toBe(false);
      expect(!unknown.ok && unknown.reason).toContain("Unknown contact type");
      expect(await proposeRole(db, ZEROONE, { memberId: id.mLi }, "investor", NOW)).toEqual({ ok: false, reason: "Li Wei is already investor." });
    });

    it("sets it and logs the change as a system entry by that person; writes nothing when it moved meanwhile", async () => {
      expect(await setRole(db, id.mLi, "investor", "introducer", "VF")).toEqual({ status: "set", role: "introducer" });
      expect(await role(id.mLi)).toBe("introducer");
      const log = await db.query("SELECT kind, by_whom, summary FROM touches WHERE member_id = $1", [id.mLi]);
      expect(log.rows).toEqual([{ kind: "system", by_whom: "VF", summary: "Type: investor → introducer" }]);
      const before = await snapshot();
      expect(await setRole(db, id.mLi, "investor", "client", "VF")).toEqual({ status: "changed", role: "introducer" });
      expect(await setRole(db, id.mLi, "investor", "introducer", "VF")).toEqual({ status: "already", role: "introducer" });
      expect(await setRole(db, randomUUID(), "investor", "introducer", "VF")).toEqual({ status: "missing", role: null });
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("high priority", () => {
    const priority = async (member: string) => (await db.query("SELECT priority FROM members WHERE id = $1", [member])).rows[0].priority;

    it("proposes turning it on for a member, signed, and reads only", async () => {
      const before = await snapshot();
      const r = await proposePriority(db, ZEROONE, { memberId: id.mLi }, "high", NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.signed.proposal).toMatchObject({ kind: "set_priority", memberId: id.mLi, memberName: "Li Wei", fromPriority: null, toPriority: "high" });
      expect(verifyProposal(r.signed.proposal, r.signed.signature, NOW)).toBe(true);
      expect(await snapshot()).toEqual(before);
    });

    it("a person filed under a member company sets the company's priority, and says who it is about", async () => {
      const r = await proposePriority(db, ZEROONE, { personId: id.jane }, "medium", NOW);
      expect(r.ok && r.signed.proposal).toMatchObject({ memberId: id.mNw, memberName: "Northwind Capital", about: "Jane Tan" });
    });

    it("refuses when nothing would change, or the contact is not on the pipeline", async () => {
      expect(await proposePriority(db, ZEROONE, { memberId: id.mLi }, null, NOW)).toEqual({ ok: false, reason: "Li Wei has no priority set." });
      await db.query("UPDATE members SET priority = 'high' WHERE id = $1", [id.mLi]);
      expect(await proposePriority(db, ZEROONE, { memberId: id.mLi }, "high", NOW)).toEqual({ ok: false, reason: "Li Wei is already high priority." });
      const down = await proposePriority(db, ZEROONE, { memberId: id.mLi }, "low", NOW);
      expect(down.ok && down.signed.proposal).toMatchObject({ fromPriority: "high", toPriority: "low" });
      expect((await proposePriority(db, ZEROONE, { personId: id.sam }, "high", NOW)).ok).toBe(false);
    });

    it("sets and clears it, logging each change on the timeline as a system entry by that person", async () => {
      expect(await setPriority(db, id.mLi, null, "high", "VF")).toEqual({ status: "set", priority: "high" });
      expect(await priority(id.mLi)).toBe("high");
      expect(await setPriority(db, id.mLi, "high", null, "VF")).toEqual({ status: "set", priority: null });
      expect(await priority(id.mLi)).toBeNull();
      const log = await db.query("SELECT kind, by_whom, summary FROM touches WHERE member_id = $1 ORDER BY at", [id.mLi]);
      expect(log.rows).toEqual([
        { kind: "system", by_whom: "VF", summary: "Priority: (none) → high" },
        { kind: "system", by_whom: "VF", summary: "Priority: high → (none)" },
      ]);
    });

    it("writes nothing when it is already so, was changed in the meantime, or the member is gone", async () => {
      await db.query("UPDATE members SET priority = 'medium' WHERE id = $1", [id.mLi]);
      const before = await snapshot();
      expect(await setPriority(db, id.mLi, null, "high", "VF")).toEqual({ status: "changed", priority: "medium" });
      expect(await setPriority(db, id.mLi, "low", "medium", "VF")).toEqual({ status: "already", priority: "medium" });
      expect(await setPriority(db, randomUUID(), null, "high", "VF")).toEqual({ status: "missing", priority: null });
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("addNote", () => {
    it("inserts exactly one note stamped VF and changes nothing else", async () => {
      const before = await snapshot();
      expect(await addNote(db, id.mLi, "called back", "VF")).toEqual({ status: "added" });
      const after = await snapshot();
      expect(after.orgs).toEqual(before.orgs);
      expect(after.people).toEqual(before.people);
      expect(after.members).toEqual(before.members);
      const rows = (after.touches as Record<string, unknown>[]).filter((t) => t.member_id === id.mLi);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "note", by_whom: "VF", summary: "called back" });
      expect(await count("touches")).toBe(1);
    });

    it("a repeated note is reported as done once", async () => {
      expect(await addNote(db, id.mLi, "same", "VF")).toEqual({ status: "added" });
      expect(await addNote(db, id.mLi, "same", "VF")).toEqual({ status: "duplicate" });
      expect(await count("touches", `member_id = '${id.mLi}'`)).toBe(1);
    });

    it("a different text, or another member, is not a duplicate", async () => {
      await addNote(db, id.mLi, "one", "VF");
      expect(await addNote(db, id.mLi, "two", "VF")).toEqual({ status: "added" });
      expect(await addNote(db, id.mNw, "one", "VF")).toEqual({ status: "added" });
    });

    it("the same text after three minutes inserts a second note", async () => {
      await addNote(db, id.mLi, "again", "VF");
      await db.query("UPDATE touches SET at = now() - interval '3 minutes' WHERE member_id = $1", [id.mLi]);
      expect(await addNote(db, id.mLi, "again", "VF")).toEqual({ status: "added" });
      expect(await count("touches", `member_id = '${id.mLi}'`)).toBe(2);
    });

    it("two taps on two connections at once insert one note", async () => {
      const other = await testDb.connect();
      try {
        const results = await Promise.all([addNote(db, id.mLi, "double", "VF"), addNote(other, id.mLi, "double", "VF")]);
        expect(results.map((r) => r.status).sort()).toEqual(["added", "duplicate"]);
        expect(await count("touches", `member_id = '${id.mLi}'`)).toBe(1);
      } finally {
        await other.end();
      }
    });

    it("rejects for a missing member and leaves the connection usable", async () => {
      await expect(addNote(db, randomUUID(), "x", "VF")).rejects.toThrow();
      expect(await count("touches")).toBe(0);
      expect(await addNote(db, id.mLi, "after", "VF")).toEqual({ status: "added" });
    });
  });

  describe("moveStage", () => {
    it("moves the stage and leaves one stage entry stamped VF", async () => {
      await db.query("INSERT INTO owners (key, display_name) VALUES ('BM', 'Bea')");
      await db.query("UPDATE members SET owner = 'BM' WHERE id = $1", [id.mLi]);
      expect(await moveStage(db, id.mLi, "contacted", "engaged", "VF")).toEqual({ status: "moved", stage: "engaged" });
      const m = await db.query("SELECT stage, owner FROM members WHERE id = $1", [id.mLi]);
      expect(m.rows[0]).toEqual({ stage: "engaged", owner: "BM" });
      const t = await db.query("SELECT kind, by_whom, summary FROM touches WHERE member_id = $1", [id.mLi]);
      expect(t.rows).toEqual([{ kind: "stage", by_whom: "VF", summary: "contacted -> engaged" }]);
    });

    it("stamps only the newest stage entry", async () => {
      await moveStage(db, id.mLi, "contacted", "engaged", "VF");
      await db.query("UPDATE touches SET by_whom = NULL WHERE member_id = $1", [id.mLi]);
      await moveStage(db, id.mLi, "engaged", "client", "VF");
      const t = await db.query("SELECT summary, by_whom FROM touches WHERE member_id = $1 ORDER BY at, id", [id.mLi]);
      expect(t.rows).toEqual([
        { summary: "contacted -> engaged", by_whom: null },
        { summary: "engaged -> client", by_whom: "VF" },
      ]);
    });

    it("stamps only this move's entry, never another stage entry", async () => {
      await db.query(
        `INSERT INTO touches (member_id, at, kind, by_whom, summary)
         VALUES ($1, now() + interval '1 hour', 'stage', NULL, 'passed -> uncontacted')`,
        [id.mLi],
      );
      await moveStage(db, id.mLi, "contacted", "engaged", "VF");
      const t = await db.query("SELECT summary, by_whom FROM touches WHERE member_id = $1 ORDER BY summary", [id.mLi]);
      expect(t.rows).toEqual([
        { summary: "contacted -> engaged", by_whom: "VF" },
        { summary: "passed -> uncontacted", by_whom: null },
      ]);
    });

    it("a stale from-stage writes nothing", async () => {
      const before = await snapshot();
      expect(await moveStage(db, id.mLi, "uncontacted", "client", "VF")).toEqual({ status: "changed", stage: "contacted" });
      expect(await snapshot()).toEqual(before);
    });

    it("reports already when the member is in the target stage", async () => {
      const before = await snapshot();
      expect(await moveStage(db, id.mLi, "uncontacted", "contacted", "VF")).toEqual({ status: "already", stage: "contacted" });
      expect(await snapshot()).toEqual(before);
    });

    it("reports missing for an unknown member", async () => {
      expect(await moveStage(db, randomUUID(), "a", "contacted", "VF")).toEqual({ status: "missing", stage: null });
    });

    it("two concurrent identical moves give one moved and one already", async () => {
      const other = await testDb.connect();
      try {
        const results = await Promise.all([
          moveStage(db, id.mLi, "contacted", "engaged", "VF"),
          moveStage(other, id.mLi, "contacted", "engaged", "VF"),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual(["already", "moved"]);
        expect(await count("touches", `member_id = '${id.mLi}' AND kind = 'stage'`)).toBe(1);
      } finally {
        await other.end();
      }
    });

    it("an unknown target stage rejects and writes nothing", async () => {
      await expect(moveStage(db, id.mLi, "contacted", "won", "VF")).rejects.toThrow();
      expect(await count("touches")).toBe(0);
      expect(await moveStage(db, id.mLi, "contacted", "engaged", "VF")).toMatchObject({ status: "moved" });
    });
  });

  it("addNote and moveStage stamp the touch with the given owner key", async () => {
    await ensureOwner(db, "AB", "Ana B");
    expect(await addNote(db, id.mLi, "hello from ana", "AB")).toEqual({ status: "added" });
    expect(await moveStage(db, id.mLi, "contacted", "engaged", "AB")).toEqual({ status: "moved", stage: "engaged" });
    const t = await db.query("SELECT kind, by_whom FROM touches WHERE member_id = $1 ORDER BY kind", [id.mLi]);
    expect(t.rows).toEqual([
      { kind: "note", by_whom: "AB" },
      { kind: "stage", by_whom: "AB" },
    ]);
  });
});
