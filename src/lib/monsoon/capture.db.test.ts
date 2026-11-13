import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture, type CaptureInput } from "./capture";
import { testDb } from "./testing/db";

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

  it("adds a new person, org, member, capture row and meeting touch", async () => {
    const r = await capture(db, input({ org: "Acme Capital", email: "jane@acme.com", notes: "met at SFF" }));
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
    expect(t).toMatchObject({ kind: "meeting", by_whom: "VF", summary: "Card captured in person: met at SFF" });
  });

  it('touch summary without notes is exactly "Card captured in person"', async () => {
    await capture(db, input({ org: "Acme Capital" }));
    expect(await touchSummaries()).toEqual(["Card captured in person"]);
  });

  it("stores rawText and extracted on the capture row", async () => {
    await capture(db, input({ rawText: "JANE TAN\nAcme", extracted: { name: "Jane Tan", n: 1 } }));
    const c = (await db.query("SELECT raw_text, extracted FROM captures")).rows[0];
    expect(c.raw_text).toBe("JANE TAN\nAcme");
    expect(c.extracted).toEqual({ name: "Jane Tan", n: 1 });
  });

  it("existing person at the same org: fills only empty fields, leaves the member alone", async () => {
    await capture(db, input({ org: "Acme Capital", email: "jane@acme.com" }));
    const r = await capture(db, input({ org: "Acme Capital", email: "other@acme.com", phone: "123", role: "introducer" }));
    expect(r).toMatchObject({ outcome: "existing", role: "investor", filled: ["phone"] });
    const p = (await db.query("SELECT email, phone FROM people")).rows[0];
    expect(p).toEqual({ email: "jane@acme.com", phone: "123" });
    expect(await count("members")).toBe(1);
    expect(await count("touches")).toBe(2);
  });

  it("matches names regardless of case and spacing", async () => {
    await capture(db, input({ org: "Acme Capital" }));
    const r = await capture(db, input({ name: "  jane   TAN ", org: "Acme Capital" }));
    expect(r.outcome).toBe("existing");
    expect(await count("people")).toBe(1);
  });

  it("lookalike org is refused, then accepted with newOrg", async () => {
    await capture(db, input({ org: "Northwind Capital" }));
    const before = await counts();
    const r = await capture(db, input({ name: "Bob Lee", org: "Northwind Capital Management" }));
    expect(r).toEqual({ outcome: "org_lookalike", similar: ["Northwind Capital"] });
    expect(await counts()).toEqual(before);
    const again = await capture(db, input({ name: "Bob Lee", org: "Northwind Capital Management", newOrg: true }));
    expect(again.outcome).toBe("added");
    expect(await count("orgs")).toBe(2);
  });

  it("lookalike org resolved by re-saving with the existing name", async () => {
    await capture(db, input({ org: "Northwind Capital" }));
    const r = await capture(db, input({ name: "Bob Lee", org: "Northwind Capital" }));
    expect(r.outcome).toBe("added");
    expect(await count("orgs")).toBe(1);
  });

  it("several lookalikes are all returned", async () => {
    await capture(db, input({ name: "A One", org: "Acme Capital Partners Asia" }));
    await capture(db, input({ name: "B Two", org: "Acme Capital Pte Ltd", newOrg: true }));
    const r = await capture(db, input({ name: "C Three", org: "Acme Capital" }));
    expect(r).toEqual({ outcome: "org_lookalike", similar: ["Acme Capital Partners Asia", "Acme Capital Pte Ltd"] });
  });

  describe("same name under another company", () => {
    let personId: string;
    beforeEach(async () => {
      const r = await capture(db, input({ org: "Acme Capital" }));
      if (r.outcome !== "added") throw new Error("seed failed");
      personId = r.person;
    });

    it("asks first", async () => {
      const before = await counts();
      const r = await capture(db, input({ org: "Borealis Partners" }));
      expect(r).toEqual({ outcome: "same_name", matches: [{ personId, org: "Acme Capital" }] });
      expect(await counts()).toEqual(before);
    });

    it("same person keeps the company on file and notes the card's company", async () => {
      const r = await capture(db, input({ org: "Borealis Partners", samePerson: personId, phone: "123" }));
      expect(r).toMatchObject({ outcome: "existing", org: "Acme Capital", filled: ["phone"] });
      expect(await count("orgs")).toBe(1);
      const s = await touchSummaries();
      expect(s[s.length - 1]).toBe("Card captured in person (card shows Borealis Partners)");
    });

    it("different person creates a second one", async () => {
      const r = await capture(db, input({ org: "Borealis Partners", samePerson: false }));
      expect(r).toMatchObject({ outcome: "added", org: "Borealis Partners" });
      expect(await count("people")).toBe(2);
    });

    it("samePerson naming a person who is not a match is invalid", async () => {
      const other = await capture(db, input({ name: "Bob Lee", org: "Acme Capital" }));
      if (other.outcome !== "added") throw new Error("seed failed");
      const before = await counts();
      const r = await capture(db, input({ org: "Borealis Partners", samePerson: other.person }));
      expect(r.outcome).toBe("invalid");
      expect(await counts()).toEqual(before);
    });
  });

  it("no company, one match: reused", async () => {
    const first = await capture(db, input({ org: "Acme Capital" }));
    const r = await capture(db, input({ phone: "9" }));
    expect(r).toMatchObject({ outcome: "existing", org: "Acme Capital", filled: ["phone"] });
    if (first.outcome === "added" && r.outcome === "existing") expect(r.person).toBe(first.person);
    expect(await count("people")).toBe(1);
  });

  it("no company, no match: orgless person added", async () => {
    const r = await capture(db, input());
    expect(r).toMatchObject({ outcome: "added", org: null });
    expect(await count("orgs")).toBe(0);
  });

  it("no company, several matches: ambiguous", async () => {
    await capture(db, input({ org: "Acme Capital" }));
    await capture(db, input({ org: "Borealis Partners", samePerson: false }));
    const r = await capture(db, input());
    expect(r).toEqual({ outcome: "ambiguous", orgs: ["Acme Capital", "Borealis Partners"] });
  });

  it("unknown role is invalid and writes nothing", async () => {
    const r = await capture(db, input({ role: "wizard", org: "Acme Capital" }));
    expect(r.outcome).toBe("invalid");
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
  });

  it("blank name is invalid", async () => {
    expect((await capture(db, input({ name: "   " }))).outcome).toBe("invalid");
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
  });

  it("captureId that is not a UUID is invalid", async () => {
    expect((await capture(db, input({ captureId: "nope" }))).outcome).toBe("invalid");
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
  });

  it("repeat capture_id writes nothing", async () => {
    const i = input({ org: "Acme Capital" });
    const first = await capture(db, i);
    const second = await capture(db, i);
    expect(second.outcome).toBe("duplicate");
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
    const results = await Promise.all([capture(db, i), capture(other, i)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["added", "duplicate"]);
    expect(await count("captures")).toBe(1);
    expect(await count("touches")).toBe(1);
  });

  it("a thrown error rolls everything back", async () => {
    await db.query("DELETE FROM owners WHERE key = 'VF'");
    await expect(capture(db, input({ org: "Acme Capital" }))).rejects.toThrow();
    expect(await count("orgs")).toBe(0);
    expect(await count("people")).toBe(0);
    expect(await count("members")).toBe(0);
  });
});
