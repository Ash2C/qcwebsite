import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capture, type CaptureInput } from "./capture";
import { ensureOwner } from "./owners";
import { makeV1TestDb, testDb } from "./testing/db";

function input(over: Partial<CaptureInput> = {}): CaptureInput {
  return { captureId: randomUUID(), name: "Jane Tan", role: "investor", ...over };
}

describe.skipIf(!testDb.available)("capture transaction (real Postgres)", () => {
  let db: Client;
  const extra: Client[] = [];

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
  });
  afterEach(async () => {
    await db.end();
    while (extra.length) await extra.pop()!.end();
  });

  async function count(table: string): Promise<number> {
    const r = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    return r.rows[0].n;
  }
  async function counts() {
    return [await count("orgs"), await count("people"), await count("members"), await count("captures"), await count("touches")];
  }
  async function touchSummaries(): Promise<string[]> {
    return (await db.query("SELECT summary FROM touches ORDER BY at")).rows.map((r) => r.summary);
  }

  it("opens a READ COMMITTED transaction and sets a local statement timeout first", async () => {
    const seen: string[] = [];
    const orig = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
    (db as unknown as { query: unknown }).query = (...a: unknown[]) => {
      if (typeof a[0] === "string") seen.push(a[0]);
      return orig(...a);
    };
    await capture(db, input(), "VF");
    expect(seen[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(seen[1]).toBe("SET LOCAL statement_timeout = '10s'");
  });

  it("adds a new person, org, member, capture row and meeting touch", async () => {
    const r = await capture(db, input({ org: "Acme Capital", email: "jane@acme.com", notes: "met at SFF" }), "VF");
    expect(r.outcome).toBe("added");
    if (r.outcome !== "added") return;
    expect(r.org).toBe("Acme Capital");
    expect(await counts()).toEqual([1, 1, 1, 1, 1]);
    const m = (await db.query("SELECT * FROM members")).rows[0];
    expect(m.person_id).toBe(r.person);
    expect(m.org_id).toBeNull();
    expect(m).toMatchObject({ stage: "uncontacted", owner: "VF", source: "monsoon-app", notes: "met at SFF" });
    const c = (await db.query("SELECT * FROM captures")).rows[0];
    expect(c).toMatchObject({ channel: "monsoon-app", status: "written", image_ref: null });
    expect(c.person_id).toBe(r.person);
    expect(c.org_id).not.toBeNull();
    const t = (await db.query("SELECT * FROM touches")).rows[0];
    expect(t).toMatchObject({ kind: "meeting", by_whom: "VF", summary: "Added by hand: met at SFF" });
  });

  it('touch summary without notes is exactly "Added by hand"', async () => {
    await capture(db, input({ org: "Acme Capital" }), "VF");
    expect(await touchSummaries()).toEqual(["Added by hand"]);
  });

  it("stores rawText and extracted on the capture row", async () => {
    await capture(db, input({ rawText: "JANE TAN\nAcme", extracted: { name: "Jane Tan", n: 1 } }), "VF");
    const c = (await db.query("SELECT raw_text, extracted FROM captures")).rows[0];
    expect(c.raw_text).toBe("JANE TAN\nAcme");
    expect(c.extracted).toEqual({ name: "Jane Tan", n: 1 });
  });

  it("existing person at the same org: fills only empty fields, leaves the member alone", async () => {
    await capture(db, input({ org: "Acme Capital", email: "jane@acme.com" }), "VF");
    const r = await capture(db, input({ org: "Acme Capital", email: "other@acme.com", phone: "123", role: "introducer" }), "VF");
    expect(r).toMatchObject({ outcome: "existing", role: "investor", filled: ["phone"] });
    const p = (await db.query("SELECT email, phone FROM people")).rows[0];
    expect(p).toEqual({ email: "jane@acme.com", phone: "123" });
    expect(await count("members")).toBe(1);
    expect(await count("touches")).toBe(2);
  });

  it("matches names regardless of case and spacing", async () => {
    await capture(db, input({ org: "Acme Capital" }), "VF");
    const r = await capture(db, input({ name: "  jane   TAN ", org: "Acme Capital" }), "VF");
    expect(r.outcome).toBe("existing");
    expect(await count("people")).toBe(1);
  });

  it("lookalike org is refused, then accepted with newOrg", async () => {
    await capture(db, input({ org: "Northwind Capital" }), "VF");
    const before = await counts();
    const r = await capture(db, input({ name: "Bob Lee", org: "Northwind Capital Management" }), "VF");
    expect(r).toEqual({ outcome: "org_lookalike", similar: ["Northwind Capital"] });
    expect(await counts()).toEqual(before);
    const again = await capture(db, input({ name: "Bob Lee", org: "Northwind Capital Management", newOrg: true }), "VF");
    expect(again.outcome).toBe("added");
    expect(await count("orgs")).toBe(2);
  });

  it("lookalike org resolved by re-saving with the existing name", async () => {
    await capture(db, input({ org: "Northwind Capital" }), "VF");
    const r = await capture(db, input({ name: "Bob Lee", org: "Northwind Capital" }), "VF");
    expect(r.outcome).toBe("added");
    expect(await count("orgs")).toBe(1);
  });

  it("several lookalikes are all returned", async () => {
    await capture(db, input({ name: "A One", org: "Acme Capital Partners Asia" }), "VF");
    await capture(db, input({ name: "B Two", org: "Acme Capital Pte Ltd", newOrg: true }), "VF");
    const r = await capture(db, input({ name: "C Three", org: "Acme Capital" }), "VF");
    expect(r).toEqual({ outcome: "org_lookalike", similar: ["Acme Capital Partners Asia", "Acme Capital Pte Ltd"] });
  });

  describe("same name under another company", () => {
    let personId: string;
    beforeEach(async () => {
      const r = await capture(db, input({ org: "Acme Capital" }), "VF");
      if (r.outcome !== "added") throw new Error("seed failed");
      personId = r.person;
    });

    it("asks first", async () => {
      const before = await counts();
      const r = await capture(db, input({ org: "Borealis Partners" }), "VF");
      expect(r).toEqual({ outcome: "same_name", matches: [{ personId, org: "Acme Capital" }] });
      expect(await counts()).toEqual(before);
    });

    it("same person keeps the company on file and notes the card's company", async () => {
      const r = await capture(db, input({ org: "Borealis Partners", samePerson: personId, phone: "123" }), "VF");
      expect(r).toMatchObject({ outcome: "existing", org: "Acme Capital", filled: ["phone"] });
      expect(await count("orgs")).toBe(1);
      const s = await touchSummaries();
      expect(s[s.length - 1]).toBe("Added by hand (card shows Borealis Partners)");
    });

    it("different person creates a second one", async () => {
      const r = await capture(db, input({ org: "Borealis Partners", samePerson: false }), "VF");
      expect(r).toMatchObject({ outcome: "added", org: "Borealis Partners" });
      expect(await count("people")).toBe(2);
    });

    it("samePerson naming a person who is not a match is invalid", async () => {
      const other = await capture(db, input({ name: "Bob Lee", org: "Acme Capital" }), "VF");
      if (other.outcome !== "added") throw new Error("seed failed");
      const before = await counts();
      const r = await capture(db, input({ org: "Borealis Partners", samePerson: other.person }), "VF");
      expect(r.outcome).toBe("invalid");
      expect(await counts()).toEqual(before);
    });
  });

  it("choosing a match by email", async () => {
    const jon = await capture(db, input({ name: "Jonathan Poe", org: "Acme Capital", email: "jon@acme.com" }), "VF");
    if (jon.outcome !== "added") throw new Error("seed failed");
    const r = await capture(db, input({ name: "Jon Poe", email: "JON@acme.com", phone: "5", samePerson: jon.person }), "VF");
    expect(r).toMatchObject({ outcome: "existing", person: jon.person, filled: ["phone"] });
    expect(await count("people")).toBe(1);
  });

  describe("choosing a match by email (re-check)", () => {
    async function seed(email: string | null, withMember = false): Promise<string> {
      const org = (
        await db.query("INSERT INTO orgs (name, name_key, source) VALUES ('Northwind Capital', 'northwind capital', 'test') RETURNING id")
      ).rows[0];
      const p = (
        await db.query(
          "INSERT INTO people (org_id, name, name_key, email, source) VALUES ($1, 'Jonathan Poe', 'jonathan poe', $2, 'test') RETURNING id",
          [org.id, email],
        )
      ).rows[0];
      if (withMember) {
        await db.query(
          "INSERT INTO members (org_id, role, stage, owner, source) VALUES ($1, 'investor', 'uncontacted', 'VF', 'test')",
          [org.id],
        );
      }
      return p.id;
    }

    it("a stored email with stray spaces and capitals still matches", async () => {
      const id = await seed("  Jon@Acme.COM 	", true);
      const r = await capture(db, input({ name: "Jon Poe", email: " jon@acme.com ", samePerson: id }), "VF");
      expect(r).toMatchObject({ outcome: "filed", person: id, created: false });
      expect(await count("people")).toBe(1);
    });

    it("filed under the company when the name differs: the timeline and the result use the name on file", async () => {
      const id = await seed("jon@acme.com", true);
      const r = await capture(db, input({ name: "Jon Poe", email: "jon@acme.com", samePerson: id }), "VF");
      expect(r).toMatchObject({ outcome: "filed", name: "Jonathan Poe" });
      expect(await touchSummaries()).toEqual(["Jonathan Poe: Added by hand"]);
    });

    it("a stored email with no email on the card is invalid and writes nothing", async () => {
      const id = await seed("jon@acme.com");
      const before = await counts();
      const r = await capture(db, input({ name: "Jon Poe", samePerson: id }), "VF");
      expect(r.outcome).toBe("invalid");
      expect(await counts()).toEqual(before);
    });

    it("an email on the card but none stored is invalid and writes nothing", async () => {
      const id = await seed(null);
      const before = await counts();
      const r = await capture(db, input({ name: "Jon Poe", email: "jon@acme.com", samePerson: id }), "VF");
      expect(r.outcome).toBe("invalid");
      expect(await counts()).toEqual(before);
    });
  });

  it("existing and added results carry the name on file", async () => {
    const first = await capture(db, input({ org: "Acme Capital" }), "VF");
    expect(first).toMatchObject({ outcome: "added", name: "Jane Tan" });
    const again = await capture(db, input({ name: "  jane   tan ", org: "Acme Capital" }), "VF");
    expect(again).toMatchObject({ outcome: "existing", name: "Jane Tan" });
  });

  it("an odd kind such as toString falls back to the card wording", async () => {
    await capture(db, input({ kind: "toString" as unknown as "card" }), "VF");
    expect(await touchSummaries()).toEqual(["Added by hand"]);
  });

  it("samePerson with a different name and a different email is invalid", async () => {
    const other = await capture(db, input({ name: "Bob Lee", org: "Acme Capital", email: "bob@acme.com" }), "VF");
    if (other.outcome !== "added") throw new Error("seed failed");
    const before = await counts();
    const r = await capture(db, input({ email: "jane@x.com", samePerson: other.person }), "VF");
    expect(r.outcome).toBe("invalid");
    expect(await counts()).toEqual(before);
  });

  describe("a person at a member company", () => {
    let memberId: string;
    beforeEach(async () => {
      const org = (
        await db.query("INSERT INTO orgs (name, name_key, source) VALUES ('Northwind Capital', 'northwind capital', 'test') RETURNING id")
      ).rows[0];
      memberId = (
        await db.query(
          "INSERT INTO members (org_id, role, stage, owner, notes, source) VALUES ($1, 'investor', 'uncontacted', 'VF', 'company note', 'test') RETURNING id",
          [org.id],
        )
      ).rows[0].id;
    });

    it("a new person is filed under it", async () => {
      const r = await capture(db, input({ name: "Omar Reyes", org: "Northwind Capital", role: "introducer" }), "VF");
      expect(r).toMatchObject({ outcome: "filed", org: "Northwind Capital", role: "investor", created: true, filled: [] });
      expect(await count("people")).toBe(1);
      expect(await count("members")).toBe(1);
      const t = (await db.query("SELECT member_id, summary FROM touches")).rows;
      expect(t).toEqual([{ member_id: memberId, summary: "Omar Reyes: Added by hand" }]);
      expect((await db.query("SELECT notes FROM members")).rows[0].notes).toBe("company note");
      const c = (await db.query("SELECT person_id, org_id FROM captures")).rows[0];
      expect(c.person_id).toBe((r as { person: string }).person);
      expect(c.org_id).not.toBeNull();
    });

    it("an existing person is filed again, with kind and notes", async () => {
      await capture(db, input({ name: "Omar Reyes", org: "Northwind Capital" }), "VF");
      const r = await capture(
        db,
        input({ name: "Omar Reyes", org: "Northwind Capital", kind: "badge", notes: "met at SFF", phone: "7" }), "VF"
      );
      expect(r).toMatchObject({ outcome: "filed", created: false, filled: ["phone"] });
      expect(await count("people")).toBe(1);
      expect(await count("members")).toBe(1);
      const s = await touchSummaries();
      expect(s[s.length - 1]).toBe("Omar Reyes: Added from a photo of a badge: met at SFF");
      expect((await db.query("SELECT notes FROM members")).rows[0].notes).toBe("company note");
    });

    it("a person with their own membership still logs on their own member", async () => {
      const p = (
        await db.query("INSERT INTO people (org_id, name, name_key, source) SELECT id, 'Omar Reyes', 'omar reyes', 'test' FROM orgs RETURNING id")
      ).rows[0];
      const own = (
        await db.query(
          "INSERT INTO members (person_id, role, stage, owner, source) VALUES ($1, 'introducer', 'uncontacted', 'VF', 'test') RETURNING id",
          [p.id],
        )
      ).rows[0];
      const r = await capture(db, input({ name: "Omar Reyes", org: "Northwind Capital" }), "VF");
      expect(r).toMatchObject({ outcome: "existing", role: "introducer" });
      expect((await db.query("SELECT member_id, summary FROM touches")).rows).toEqual([
        { member_id: own.id, summary: "Added by hand" },
      ]);
    });

    it("a repeat of the same captureId is a duplicate", async () => {
      const i = input({ name: "Omar Reyes", org: "Northwind Capital" });
      expect((await capture(db, i, "VF")).outcome).toBe("filed");
      expect((await capture(db, i, "VF")).outcome).toBe("duplicate");
      expect(await count("touches")).toBe(1);
    });
  });

  describe("different person with no company", () => {
    beforeEach(async () => {
      await capture(db, input(), "VF");
    });

    it("needs a company and writes nothing", async () => {
      const before = await counts();
      const r = await capture(db, input({ samePerson: false }), "VF");
      expect(r).toEqual({ outcome: "needs_company", orgs: [null] });
      expect(await counts()).toEqual(before);
    });

    it("with a company it creates a second person", async () => {
      const r = await capture(db, input({ samePerson: false, org: "Borealis Partners" }), "VF");
      expect(r.outcome).toBe("added");
      expect(await count("people")).toBe(2);
    });
  });

  it.each([
    ["badge", "Added from a photo of a badge"],
    ["screen", "Added from a screenshot"],
    ["other", "Added from a photo"],
    ["card", "Added from a photo of a business card"],
    [undefined, "Added by hand"],
  ] as const)("timeline wording for kind %s", async (kind, text) => {
    await capture(db, input({ org: "Acme Capital", kind }), "VF");
    expect(await touchSummaries()).toEqual([text]);
  });

  it("no company, one match: reused", async () => {
    const first = await capture(db, input({ org: "Acme Capital" }), "VF");
    const r = await capture(db, input({ phone: "9" }), "VF");
    expect(r).toMatchObject({ outcome: "existing", org: "Acme Capital", filled: ["phone"] });
    expect(first.outcome).toBe("added");
    if (first.outcome === "added" && r.outcome === "existing") expect(r.person).toBe(first.person);
    expect(await count("people")).toBe(1);
  });

  it("no company, no match: orgless person added", async () => {
    const r = await capture(db, input(), "VF");
    expect(r).toMatchObject({ outcome: "added", org: null });
    expect(await count("orgs")).toBe(0);
  });

  it("no company, several matches: ambiguous", async () => {
    await capture(db, input({ org: "Acme Capital" }), "VF");
    await capture(db, input({ org: "Borealis Partners", samePerson: false }), "VF");
    const r = await capture(db, input(), "VF");
    expect(r).toEqual({ outcome: "ambiguous", orgs: ["Acme Capital", "Borealis Partners"] });
  });

  it("unknown role is invalid and writes nothing", async () => {
    const r = await capture(db, input({ role: "wizard", org: "Acme Capital" }), "VF");
    expect(r.outcome).toBe("invalid");
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
  });

  it("blank name is invalid", async () => {
    expect((await capture(db, input({ name: "   " }), "VF")).outcome).toBe("invalid");
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
  });

  it("captureId that is not a UUID is invalid", async () => {
    expect((await capture(db, input({ captureId: "nope" }), "VF")).outcome).toBe("invalid");
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
  });

  it("repeat capture_id writes nothing", async () => {
    const i = input({ org: "Acme Capital" });
    const first = await capture(db, i, "VF");
    const second = await capture(db, i, "VF");
    expect(second.outcome).toBe("duplicate");
    expect(first.outcome).toBe("added");
    if (first.outcome === "added" && second.outcome === "duplicate") {
      expect(second.person).toBe(first.person);
      expect(second.org).toBe("Acme Capital");
    }
    expect(await count("captures")).toBe(1);
    expect(await count("touches")).toBe(1);
  });

  it("two concurrent saves of one capture_id write once", async () => {
    const other = await testDb.connect();
    extra.push(other);
    const i = input({ org: "Acme Capital" });
    const results = await Promise.all([capture(db, i, "VF"), capture(other, i, "VF")]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["added", "duplicate"]);
    expect(await count("captures")).toBe(1);
    expect(await count("touches")).toBe(1);
  });

  it("a thrown error rolls everything back", async () => {
    await db.query("DELETE FROM owners WHERE key = 'VF'");
    await expect(capture(db, input({ org: "Acme Capital" }), "VF")).rejects.toThrow();
    expect(await count("orgs")).toBe(0);
    expect(await count("people")).toBe(0);
    expect(await count("members")).toBe(0);
  });

  it("stamps the new member and the meeting touch with the given owner key", async () => {
    await ensureOwner(db, "AB", "Ana B");
    const r = await capture(db, input({ org: "Acme Capital" }), "AB");
    expect(r.outcome).toBe("added");
    expect((await db.query("SELECT owner FROM members")).rows).toEqual([{ owner: "AB" }]);
    expect((await db.query("SELECT by_whom FROM touches")).rows).toEqual([{ by_whom: "AB" }]);
  });

  describe("offered to-dos", () => {
    const offered = [
      { title: "Send her the deck", due: "2026-12-01" },
      { title: "Intro her to Sam", due: null },
    ];
    const todoRows = async () =>
      (await db.query("SELECT t.title, t.due_date::text AS due, t.status, t.source, t.owner, t.member_id, t.about_person_id FROM todos t ORDER BY t.created_at, t.id")).rows;

    it("writes them as open to-dos on the new contact's member, source notes, owned by the capture's owner", async () => {
      const r = await capture(db, input({ org: "Acme Capital", todos: offered }), "VF");
      expect(r.outcome).toBe("added");
      const m = (await db.query("SELECT id, next_action, next_action_date::text AS d FROM members")).rows[0];
      expect(await todoRows()).toEqual([
        { title: "Send her the deck", due: "2026-12-01", status: "open", source: "notes", owner: "VF", member_id: m.id, about_person_id: null },
        { title: "Intro her to Sam", due: null, status: "open", source: "notes", owner: "VF", member_id: m.id, about_person_id: null },
      ]);
      // The trigger sets the member's next action; no timeline entry beyond the meeting touch.
      expect(m.next_action).toBe("Send her the deck");
      expect(m.d).toBe("2026-12-01");
      expect(await count("touches")).toBe(1);
    });

    it("sets about_person_id when the person sits under a member company", async () => {
      const org = (
        await db.query("INSERT INTO orgs (name, name_key, source) VALUES ('Northwind Capital', 'northwind capital', 'test') RETURNING id")
      ).rows[0];
      const memberId = (
        await db.query("INSERT INTO members (org_id, role, stage, owner, source) VALUES ($1, 'investor', 'uncontacted', 'VF', 'test') RETURNING id", [org.id])
      ).rows[0].id;
      const r = await capture(db, input({ name: "Omar Reyes", org: "Northwind Capital", todos: [offered[0]] }), "VF");
      expect(r.outcome).toBe("filed");
      expect(await todoRows()).toEqual([
        { title: "Send her the deck", due: "2026-12-01", status: "open", source: "notes", owner: "VF", member_id: memberId, about_person_id: (r as { person: string }).person },
      ]);
    });

    it("writes none for a duplicate capture", async () => {
      const i = input({ org: "Acme Capital", todos: [offered[0]] });
      await capture(db, i, "VF");
      expect((await capture(db, i, "VF")).outcome).toBe("duplicate");
      expect(await count("todos")).toBe(1);
    });

    it("writes none when the capture is not saved", async () => {
      const r = await capture(db, input({ role: "nope", todos: offered }), "VF");
      expect(r.outcome).toBe("invalid");
      expect(await count("todos")).toBe(0);
    });

    it("a failing to-do insert never loses the contact: the capture commits with no to-do", async () => {
      // A real database error inside the transaction, with no trigger: every to-do row breaks a check.
      await db.query("ALTER TABLE todos ADD CONSTRAINT no_todos_for_this_test CHECK (false) NOT VALID");
      const logged: unknown[][] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a));
      try {
        const r = await capture(db, input({ org: "Acme Capital", todos: offered }), "VF");
        expect(r.outcome).toBe("added");
      } finally {
        spy.mockRestore();
      }
      expect(await counts()).toEqual([1, 1, 1, 1, 1]);
      expect(await count("todos")).toBe(0);
      expect((await db.query("SELECT next_action FROM members")).rows).toEqual([{ next_action: null }]);
      // Only the error's name and code, never a title or the contact's details.
      expect(logged).toEqual([["monsoon: capture to-dos skipped", "error", "23514"]]);
    });

    it("on a CRM still at schema version 1 the capture succeeds and writes none", async () => {
      const v1 = makeV1TestDb("capture_v1");
      await v1.reset();
      const old = await v1.connect();
      try {
        const r = await capture(old, input({ org: "Acme Capital", todos: offered }), "VF");
        expect(r.outcome).toBe("added");
        expect((await old.query("SELECT count(*)::int AS n FROM members")).rows[0].n).toBe(1);
      } finally {
        await old.end();
      }
    });
  });
});
