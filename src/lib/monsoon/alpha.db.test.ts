import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOwner } from "./owners";
import { testDb } from "./testing/db";
import { ALPHA_NOTE, recordAlphaSignup } from "./alpha";

describe.skipIf(!testDb.available)("recordAlphaSignup (real Postgres)", () => {
  let db: Client;
  const count = async (table: string, where = "TRUE", params: unknown[] = []) =>
    (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n as number;

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query("INSERT INTO roles (key, label) VALUES ('reader', 'Reader')");
  });
  afterEach(async () => {
    await db.end();
  });

  it("adds a new person, a reader member owned by VF, and one note", async () => {
    expect(await recordAlphaSignup(db, "  Jane@Example.COM ", "VF")).toEqual({ status: "added" });
    const p = (await db.query("SELECT name, email, source, org_id FROM people")).rows;
    expect(p).toEqual([{ name: "jane@example.com", email: "jane@example.com", source: "monsoon-alpha", org_id: null }]);
    const m = (await db.query("SELECT role, stage, owner, source, org_id FROM members")).rows;
    expect(m).toEqual([{ role: "reader", stage: "uncontacted", owner: "VF", source: "monsoon-alpha", org_id: null }]);
    const t = (await db.query("SELECT kind, by_whom, summary FROM touches")).rows;
    expect(t).toEqual([{ kind: "note", by_whom: "VF", summary: ALPHA_NOTE }]);
  });

  it("signing up twice writes nothing the second time", async () => {
    await recordAlphaSignup(db, "jane@example.com", "VF");
    expect(await recordAlphaSignup(db, "JANE@example.com", "VF")).toEqual({ status: "repeat" });
    expect(await count("people")).toBe(1);
    expect(await count("members")).toBe(1);
    expect(await count("touches")).toBe(1);
  });

  it("two simultaneous sign-ups of one email write once", async () => {
    const other = await testDb.connect();
    try {
      const results = await Promise.all([recordAlphaSignup(db, "sam@example.com", "VF"), recordAlphaSignup(other, "sam@example.com", "VF")]);
      expect(results.map((r) => r.status).sort()).toEqual(["added", "repeat"]);
      expect(await count("people")).toBe(1);
      expect(await count("touches")).toBe(1);
    } finally {
      await other.end();
    }
  });

  it("someone already on file is reused, not duplicated or overwritten", async () => {
    const personId = randomUUID();
    const memberId = randomUUID();
    await db.query(
      "INSERT INTO people (id, name, name_key, email, title, source) VALUES ($1, 'Li Wei', 'li wei', 'Li.Wei@Acme.com', 'Partner', 'test')",
      [personId],
    );
    await db.query(
      "INSERT INTO members (id, person_id, role, stage, owner, notes, source) VALUES ($1, $2, 'investor', 'contacted', 'VF', 'Met in Taipei', 'test')",
      [memberId, personId],
    );
    expect(await recordAlphaSignup(db, "li.wei@acme.com", "VF")).toEqual({ status: "existing" });
    expect(await count("people")).toBe(1);
    expect(await count("members")).toBe(1);
    const m = (await db.query("SELECT role, stage, notes FROM members WHERE id = $1", [memberId])).rows[0];
    expect(m).toEqual({ role: "investor", stage: "contacted", notes: "Met in Taipei" });
    const p = (await db.query("SELECT name, title FROM people WHERE id = $1", [personId])).rows[0];
    expect(p).toEqual({ name: "Li Wei", title: "Partner" });
    expect(await count("touches", "member_id = $1 AND summary = $2", [memberId, ALPHA_NOTE])).toBe(1);
  });

  it("a person on file under a company member gets the note on the company's timeline", async () => {
    const orgId = randomUUID();
    const orgMember = randomUUID();
    await db.query("INSERT INTO orgs (id, name, name_key, source) VALUES ($1, 'Northwind', 'northwind', 'test')", [orgId]);
    await db.query("INSERT INTO people (name, name_key, email, org_id, source) VALUES ('Omar Reyes', 'omar reyes', 'omar@northwind.example', $1, 'test')", [orgId]);
    await db.query("INSERT INTO members (id, org_id, role, stage, source) VALUES ($1, $2, 'investor', 'engaged', 'test')", [orgMember, orgId]);
    expect(await recordAlphaSignup(db, "omar@northwind.example", "VF")).toEqual({ status: "existing" });
    expect(await count("members")).toBe(1);
    expect(await count("touches", "member_id = $1", [orgMember])).toBe(1);
  });

  it("a missing reader role rolls everything back", async () => {
    await db.query("DELETE FROM roles WHERE key = 'reader'");
    await expect(recordAlphaSignup(db, "kim@example.com", "VF")).rejects.toThrow();
    expect(await count("people")).toBe(0);
    expect(await count("members")).toBe(0);
    expect(await count("touches")).toBe(0);
  });

  it("stamps the member and the note with the given owner key", async () => {
    await ensureOwner(db, "AB", "Ana B");
    expect(await recordAlphaSignup(db, "ana@example.com", "AB")).toEqual({ status: "added" });
    expect((await db.query("SELECT owner FROM members")).rows).toEqual([{ owner: "AB" }]);
    expect((await db.query("SELECT by_whom FROM touches")).rows).toEqual([{ by_whom: "AB" }]);
  });
});
