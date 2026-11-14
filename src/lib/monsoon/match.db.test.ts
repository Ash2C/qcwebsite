import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchCards } from "./match";
import { testDb } from "./testing/db";

describe.skipIf(!testDb.available)("matchCards (real Postgres)", () => {
  let db: Client;
  const id = {
    north: randomUUID(),
    acme: randomUUID(),
    orphan: randomUUID(),
    jane: randomUUID(),
    omar: randomUUID(),
    liwei: randomUUID(),
    janeSolo: randomUUID(),
    sam: randomUUID(),
    mNorth: randomUUID(),
    mLi: randomUUID(),
    mJaneSolo: randomUUID(),
  };

  async function addPerson(pid: string, name: string, org: string | null, email: string | null, createdAt: string) {
    await db.query(
      `INSERT INTO people (id, org_id, name, name_key, email, title, source, created_at)
       VALUES ($1, $2, $3, $4, $5, 'Partner', 'test', $6)`,
      [pid, org, name, name.toLowerCase(), email, createdAt],
    );
  }
  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of ["orgs", "people", "members", "touches"]) {
      out[t] = (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    }
    return out;
  }
  async function outsideTransaction() {
    expect((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
  }
  const card = (name: string, org = "", email = "") => ({ name, org, email });

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query(
      `INSERT INTO orgs (id, name, name_key, source) VALUES
         ($1, 'Northwind Capital', 'northwind capital', 'test'),
         ($2, 'Acme Capital', 'acme capital', 'test'),
         ($3, 'Orphan Co', 'orphan co', 'test')`,
      [id.north, id.acme, id.orphan],
    );
    await addPerson(id.jane, "Jane Tan", id.north, "jane@northwind.example", "2026-01-01T00:00:00Z");
    await addPerson(id.omar, "Omar Reyes", id.north, null, "2026-01-02T00:00:00Z");
    await addPerson(id.liwei, "Li Wei", id.acme, null, "2026-01-03T00:00:00Z");
    await addPerson(id.janeSolo, "Jane Tan", null, null, "2026-01-04T00:00:00Z");
    await addPerson(id.sam, "Sam Ortiz", id.orphan, null, "2026-01-05T00:00:00Z");
    await db.query(
      `INSERT INTO members (id, org_id, person_id, role, stage, source) VALUES
         ($1, $4, NULL, 'investor', 'engaged', 'test'),
         ($2, NULL, $5, 'investor', 'uncontacted', 'test'),
         ($3, NULL, $6, 'introducer', 'contacted', 'test')`,
      [id.mNorth, id.mLi, id.mJaneSolo, id.north, id.liwei, id.janeSolo],
    );
  });
  afterEach(async () => {
    await db.end();
  });

  it("matches name and company exactly, with the company's membership", async () => {
    const [m] = await matchCards(db, [card("Jane Tan", "Northwind Capital")]);
    expect(m.match).toBe("exact");
    expect(m.candidates).toEqual([
      {
        personId: id.jane,
        name: "Jane Tan",
        title: "Partner",
        company: "Northwind Capital",
        email: "jane@northwind.example",
        by: "name_company",
        memberOf: "company",
        member: { memberId: id.mNorth, memberKind: "company", role: "investor", stage: "engaged" },
      },
    ]);
    await outsideTransaction();
  });

  it("ignores case and spacing in the name and the company", async () => {
    const [m] = await matchCards(db, [card("  jane   TAN ", "NORTHWIND   capital")]);
    expect(m.match).toBe("exact");
    expect(m.candidates[0].personId).toBe(id.jane);
  });

  it("matches by email, case-insensitively, whatever the name", async () => {
    const [m] = await matchCards(db, [card("Jon Tan", "", " JANE@northwind.example ")]);
    expect(m.match).toBe("exact");
    expect(m.candidates).toMatchObject([{ personId: id.jane, by: "email" }]);
  });

  it("calls the same person one match when email and name+company agree", async () => {
    const [m] = await matchCards(db, [card("Jane Tan", "Northwind Capital", "jane@northwind.example")]);
    expect(m.match).toBe("exact");
    expect(m.candidates).toHaveLength(1);
  });

  it("lists every same-name person as several when no company narrows it", async () => {
    const [m] = await matchCards(db, [card("Jane Tan")]);
    expect(m.match).toBe("several");
    expect(m.candidates.map((c) => [c.personId, c.by])).toEqual([
      [id.jane, "name"],
      [id.janeSolo, "name"],
    ]);
    expect(m.candidates[1]).toMatchObject({ memberOf: "self", member: { memberId: id.mJaneSolo, memberKind: "person" } });
  });

  it("is a same-name match when the company differs", async () => {
    const [m] = await matchCards(db, [card("Li Wei", "Other Co")]);
    expect(m.match).toBe("same_name");
    expect(m.candidates).toMatchObject([{ personId: id.liwei, by: "name", memberOf: "self", member: { memberId: id.mLi, memberKind: "person" } }]);
  });

  it("gives member null for a person with no membership of their own or their company's", async () => {
    const [m] = await matchCards(db, [card("Sam Ortiz")]);
    expect(m.match).toBe("same_name");
    expect(m.candidates[0]).toMatchObject({ member: null, memberOf: null });
  });

  it("is several when the email is one person's and the name and company another's", async () => {
    await addPerson(randomUUID(), "Omar Reyes", id.acme, "omar@acme.example", "2026-01-06T00:00:00Z");
    const [m] = await matchCards(db, [card("Omar Reyes", "Northwind Capital", "omar@acme.example")]);
    expect(m.match).toBe("several");
    expect(m.candidates.map((c) => [c.by, c.company])).toEqual([
      ["email", "Acme Capital"],
      ["name_company", "Northwind Capital"],
    ]);
  });

  it("is none for an unknown person and for a blank name", async () => {
    const out = await matchCards(db, [
      card("Nobody Known", "Nowhere"),
      card("   ", "Northwind Capital", "jane@northwind.example"),
    ]);
    expect(out).toEqual([
      { match: "none", candidates: [] },
      { match: "none", candidates: [] },
    ]);
  });

  it("returns one verdict per card in order", async () => {
    const out = await matchCards(db, [
      card("Nobody"),
      card("Omar Reyes", "Northwind Capital"),
      card("Li Wei"),
      card("Jane Tan"),
    ]);
    expect(out.map((m) => m.match)).toEqual(["none", "exact", "same_name", "several"]);
  });

  it("caps candidates at five, oldest first", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const pid = randomUUID();
      const org = randomUUID();
      ids.push(pid);
      await db.query("INSERT INTO orgs (id, name, name_key, source) VALUES ($1, $2, $2, 'test')", [org, `chris co ${i}`]);
      await addPerson(pid, "Chris Lee", org, null, `2025-01-0${i + 1}T00:00:00Z`);
    }
    const [m] = await matchCards(db, [card("Chris Lee")]);
    expect(m.match).toBe("several");
    expect(m.candidates.map((c) => c.personId)).toEqual(ids.slice(0, 5));
  });

  it("finds a person whose stored email has stray whitespace", async () => {
    await db.query("UPDATE people SET email = '  Jane@Northwind.example ' WHERE id = $1", [id.jane]);
    const [m] = await matchCards(db, [card("Jon Tan", "", "jane@northwind.example")]);
    expect(m).toMatchObject({ match: "exact", candidates: [{ personId: id.jane, by: "email" }] });
  });

  it("does not match an empty card email to a stored empty or null email", async () => {
    await db.query("UPDATE people SET email = '' WHERE id = $1", [id.omar]);
    const [m] = await matchCards(db, [card("Someone Else", "", ""), card("Someone Else", "", "   ")]);
    expect(m).toEqual({ match: "none", candidates: [] });
    const out = await matchCards(db, [card("Li Wei", "", "")]);
    expect(out[0].candidates.map((c) => c.by)).toEqual(["name"]);
  });

  it("does not treat an empty org as a name-and-company match with a company-less person", async () => {
    const [m] = await matchCards(db, [card("Jane Tan", "  ", "")]);
    expect(m.candidates.every((c) => c.by === "name")).toBe(true);
    await db.query("DELETE FROM members WHERE id = $1", [id.mJaneSolo]);
    await db.query("DELETE FROM people WHERE id = $1", [id.jane]);
    const [solo] = await matchCards(db, [card("Jane Tan", "", "")]);
    expect(solo).toMatchObject({ match: "same_name", candidates: [{ personId: id.janeSolo, by: "name" }] });
  });

  it("copes with odd input and does not write", async () => {
    const before = await counts();
    const out = await matchCards(db, [
      card("%", "%", "%"),
      card("x".repeat(5000), "y".repeat(5000), "z".repeat(5000)),
      card("_ \\ '"),
    ]);
    expect(out.map((m) => m.match)).toEqual(["none", "none", "none"]);
    expect(await matchCards(db, [])).toEqual([]);
    expect(await counts()).toEqual(before);
    await outsideTransaction();
  });

  it("leaves the connection outside a transaction when the query fails", async () => {
    await db.query("ALTER TABLE people RENAME TO people_gone");
    await expect(matchCards(db, [card("Jane Tan")])).rejects.toThrow();
    await outsideTransaction();
  });
});
