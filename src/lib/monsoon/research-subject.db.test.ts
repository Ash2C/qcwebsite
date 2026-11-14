import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSubject } from "./research-subject";
import { testDb } from "./testing/db";

describe.skipIf(!testDb.available)("readSubject (real Postgres)", () => {
  let db: Client;
  const id = {
    nw: randomUUID(),
    jane: randomUUID(), // at Northwind, no own member (Northwind has one)
    liwei: randomUUID(), // at Northwind, own member
    pat: randomUUID(), // no company, no membership
    mNw: randomUUID(),
    mLi: randomUUID(),
  };

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query(`INSERT INTO orgs (id, name, name_key, website, source) VALUES ($1, 'Northwind Capital', 'northwind capital', 'nw.example', 'test')`, [id.nw]);
    await db.query(
      `INSERT INTO people (id, org_id, name, name_key, title, email, phone, linkedin_url, country, source) VALUES
         ($1, $4, 'Jane Tan', 'jane tan', 'Analyst', 'jane@nw.example', NULL, NULL, 'Singapore', 'test'),
         ($2, $4, 'Li Wei', 'li wei', NULL, NULL, '+65 2222 0000', 'https://www.linkedin.com/in/liwei', NULL, 'test'),
         ($3, NULL, 'Pat Lee', 'pat lee', NULL, NULL, NULL, NULL, NULL, 'test')`,
      [id.jane, id.liwei, id.pat, id.nw],
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
  });

  it("reads a person member with a company", async () => {
    const r = await readSubject(db, { memberId: id.mLi });
    expect(r).toEqual({
      ok: true,
      subject: {
        name: "Li Wei",
        company: "Northwind Capital",
        companyWebsite: "nw.example",
        title: null,
        email: null,
        phone: "+65 2222 0000",
        linkedin: "https://www.linkedin.com/in/liwei",
        country: null,
      },
      person: { id: id.liwei, name: "Li Wei" },
      company: { id: id.nw, name: "Northwind Capital" },
      logMemberId: id.mLi,
    });
  });

  it("uses the company's member as log member for a person filed under it", async () => {
    const r = await readSubject(db, { personId: id.jane });
    expect(r.ok && r.logMemberId).toBe(id.mNw);
    expect(r.ok && r.subject.title).toBe("Analyst");
  });

  it("has no log member and no company for a person with no membership", async () => {
    const r = await readSubject(db, { personId: id.pat });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.logMemberId).toBeNull();
    expect(r.company).toBeNull();
    expect(r.subject.company).toBeNull();
    expect(r.subject.companyWebsite).toBeNull();
  });

  it("refuses a company member id", async () => {
    expect(await readSubject(db, { memberId: id.mNw })).toEqual({ ok: false, reason: "company" });
  });

  it("reports unknown and malformed ids as missing", async () => {
    expect(await readSubject(db, { personId: randomUUID() })).toEqual({ ok: false, reason: "missing" });
    expect(await readSubject(db, { memberId: randomUUID() })).toEqual({ ok: false, reason: "missing" });
    expect(await readSubject(db, { personId: "nope" })).toEqual({ ok: false, reason: "missing" });
    expect(await readSubject(db, {})).toEqual({ ok: false, reason: "missing" });
  });

  it("runs inside a read-only transaction and writes nothing", async () => {
    const seen: string[] = [];
    const spy = { query: (sql: string, p?: unknown[]) => (seen.push(sql), db.query(sql, p)) } as unknown as Client;
    await readSubject(spy, { personId: id.jane });
    expect(seen[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(seen[seen.length - 1]).toBe("COMMIT");
    expect(seen.some((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s))).toBe(false);
  });
});
