import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyProposal, type Proposal } from "./ask/proposal";
import { applyDetails, proposeDetails, type DetailInput } from "./details";
import { testDb } from "./testing/db";

const NOW = 1_800_000_000_000;
type Details = Extract<Proposal, { kind: "update_details" }>;

describe.skipIf(!testDb.available)("Editing details (real Postgres)", () => {
  let db: Client;
  const id = {
    nw: randomUUID(),
    acme: randomUUID(),
    orphan: randomUUID(),
    jane: randomUUID(), // at Northwind, no own member (Northwind has one)
    liwei: randomUUID(), // at Acme, own member
    sam: randomUUID(), // at Orphan Co, no timeline at all
    pat: randomUUID(), // no company
    patty: randomUUID(), // no company
    janeAcme: randomUUID(), // another Jane Tan, at Acme
    mNw: randomUUID(),
    mLi: randomUUID(),
  };

  async function count(table: string, where = "TRUE"): Promise<number> {
    return (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;
  }
  async function snapshot() {
    const out: Record<string, unknown> = {};
    for (const t of ["orgs", "people", "members", "touches"]) out[t] = (await db.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
    return out;
  }
  async function propose(target: Parameters<typeof proposeDetails>[2], input: DetailInput, opts: { newCompany?: boolean } = {}) {
    return proposeDetails(db, "zeroone", target, input, { nowMs: NOW, defaultRole: "investor", ...opts });
  }
  async function proposed(target: Parameters<typeof proposeDetails>[2], input: DetailInput, opts: { newCompany?: boolean } = {}): Promise<Details> {
    const r = await propose(target, input, opts);
    if (!r.ok) throw new Error(`expected a proposal, got: ${r.reason}`);
    return r.signed.proposal as Details;
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
      `INSERT INTO people (id, org_id, name, name_key, title, phone, source) VALUES
         ($1, $5, 'Jane Tan', 'jane tan', 'Analyst', '+65 1111 0000', 'test'),
         ($2, $6, 'Li Wei', 'li wei', NULL, '+65 2222 0000', 'test'),
         ($3, $7, 'Sam Ortiz', 'sam ortiz', NULL, NULL, 'test'),
         ($4, NULL, 'Pat Lee', 'pat lee', NULL, NULL, 'test'),
         ($8, NULL, 'Patty Lee', 'patty lee', NULL, NULL, 'test'),
         ($9, $6, 'Jane Tan', 'jane tan', NULL, NULL, 'test')`,
      [id.jane, id.liwei, id.sam, id.pat, id.nw, id.acme, id.orphan, id.patty, id.janeAcme],
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

  describe("proposeDetails", () => {
    it("proposes only the fields that differ, signed, with the exact shape", async () => {
      const r = await propose({ personId: id.liwei }, { name: "Li Wei", title: " Director ", phone: "+65 2222 0000", email: "" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.signed.proposal).toEqual({
        kind: "update_details",
        estate: "zeroone",
        target: { type: "person", id: id.liwei },
        targetName: "Li Wei",
        company: "Acme Capital",
        changes: [{ field: "title", from: null, to: "Director" }],
        logMemberId: id.mLi,
        addsToPipeline: null,
        expires: NOW + 30 * 60 * 1000,
      });
      expect(verifyProposal(r.signed.proposal, r.signed.signature, NOW)).toBe(true);
    });

    it("resolves a member id to its person or its company", async () => {
      const p = await proposed({ memberId: id.mLi }, { title: "Director" });
      expect(p.target).toEqual({ type: "person", id: id.liwei });
      const c = await proposed({ memberId: id.mNw }, { website: "https://nw.example" });
      expect(c.target).toEqual({ type: "company", id: id.nw });
      expect(c.company).toBeNull();
      expect(c.logMemberId).toBe(id.mNw);
    });

    it("resolves the most specific id first: person, then company, then member", async () => {
      // The member is Northwind's, the person is Jane at Northwind: the person is meant.
      const p = await proposed({ memberId: id.mNw, personId: id.jane }, { title: "Director" });
      expect(p.target).toEqual({ type: "person", id: id.jane });
      const c = await proposed({ memberId: id.mLi, orgId: id.nw }, { country: "UK" });
      expect(c.target).toEqual({ type: "company", id: id.nw });
      const both = await proposed({ memberId: id.mLi, personId: id.jane, orgId: id.nw }, { title: "Director" });
      expect(both.target).toEqual({ type: "person", id: id.jane });
    });

    it("refuses when a stored value it would carry as the old value is over 2,000 characters", async () => {
      await db.query("UPDATE people SET title = $2 WHERE id = $1", [id.liwei, "x".repeat(2001)]);
      expect(await propose({ personId: id.liwei }, { title: "Director" })).toEqual({
        ok: false,
        reason: "Title is too long to edit here.",
      });
      // a field that is not being changed does not matter
      expect((await propose({ personId: id.liwei }, { phone: "+65 9999 0000" })).ok).toBe(true);
    });

    it("says Nothing to change. when every field matches, treating empty and null alike", async () => {
      const r = await propose({ personId: id.liwei }, { title: "  ", name: "Li Wei" });
      expect(r).toEqual({ ok: false, reason: "Nothing to change." });
      const same = await propose({ personId: id.jane }, { company: "northwind  capital" });
      expect(same).toEqual({ ok: false, reason: "Nothing to change." });
    });

    it("clears a phone with an empty string", async () => {
      const p = await proposed({ personId: id.liwei }, { phone: "" });
      expect(p.changes).toEqual([{ field: "phone", from: "+65 2222 0000", to: null }]);
    });

    it("refuses a blank name and an over-long value", async () => {
      expect(await propose({ personId: id.liwei }, { name: "  " })).toEqual({ ok: false, reason: "A name cannot be blank." });
      const r = await propose({ personId: id.liwei }, { title: "x".repeat(301) });
      expect(r).toEqual({ ok: false, reason: "Title is too long (limit 300 characters)." });
      expect((await propose({ personId: id.liwei }, { title: "x".repeat(300) })).ok).toBe(true);
    });

    it("refuses a field that does not belong to the target, and unknown targets", async () => {
      const w = await propose({ personId: id.liwei }, { website: "x.example" });
      expect(w.ok).toBe(false);
      const t = await propose({ orgId: id.nw }, { title: "x" });
      expect(t.ok).toBe(false);
      expect(await propose({ personId: randomUUID() }, { title: "x" })).toEqual({ ok: false, reason: "No such contact." });
      expect(await propose({ personId: "nope" }, { title: "x" })).toEqual({ ok: false, reason: "No such contact." });
      expect(await propose({}, { title: "x" })).toEqual({ ok: false, reason: "No such contact." });
    });

    it("refuses a rename that collides at the same company", async () => {
      const r = await propose({ personId: id.liwei }, { name: "jane  tan" });
      expect(r).toEqual({ ok: false, reason: "Another jane  tan is already on file there." });
      expect((await propose({ personId: id.liwei }, { name: "Li Wei Chen" })).ok).toBe(true);
    });

    it("refuses a rename that collides among company-less people", async () => {
      const r = await propose({ personId: id.patty }, { name: "Pat Lee" });
      expect(r).toEqual({ ok: false, reason: "Another Pat Lee is already on file there." });
    });

    it("refuses a company move onto an existing namesake", async () => {
      const r = await propose({ personId: id.jane }, { company: "Acme Capital" });
      expect(r).toEqual({ ok: false, reason: "Another Jane Tan is already on file there." });
    });

    it("refuses a lookalike company, then accepts it with newCompany", async () => {
      const r = await propose({ personId: id.liwei }, { company: "Northwind Partners" });
      expect(r).toEqual({
        ok: false,
        reason: "Northwind Partners looks like Northwind Capital, already on file. Use that name, or say it is a different company.",
      });
      const p = await proposed({ personId: id.liwei }, { company: "Northwind Partners" }, { newCompany: true });
      expect(p.changes).toEqual([{ field: "company", from: "Acme Capital", to: "Northwind Partners" }]);
    });

    it("uses an exact existing company as is", async () => {
      const p = await proposed({ personId: id.liwei }, { company: "NORTHWIND  capital" });
      expect(p.changes).toEqual([{ field: "company", from: "Acme Capital", to: "Northwind Capital" }]);
      const brand = await proposed({ personId: id.pat }, { company: "Totally New Ltd" });
      expect(brand.changes).toEqual([{ field: "company", from: null, to: "Totally New Ltd" }]);
    });

    it("picks the log member: own, the company's, or none with addsToPipeline", async () => {
      expect((await proposed({ personId: id.liwei }, { title: "x" })).logMemberId).toBe(id.mLi);
      const underCompany = await proposed({ personId: id.jane }, { title: "x" });
      expect(underCompany.logMemberId).toBe(id.mNw);
      expect(underCompany.addsToPipeline).toBeNull();
      const none = await proposed({ personId: id.sam }, { title: "x" });
      expect(none.logMemberId).toBeNull();
      expect(none.addsToPipeline).toBe("investor");
    });

    it("refuses a company that is not on the pipeline", async () => {
      expect(await propose({ orgId: id.acme }, { website: "https://acme.example" })).toEqual({
        ok: false,
        reason: "Acme Capital is not on the pipeline.",
      });
    });

    it("writes nothing", async () => {
      const before = await snapshot();
      await propose({ personId: id.liwei }, { title: "Director", company: "Brand New Ltd" }, { newCompany: true });
      await propose({ personId: id.sam }, { name: "Samuel" });
      await propose({ orgId: id.nw }, { website: "https://x.example" });
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("applyDetails", () => {
    it("writes the fields and exactly one system touch with the exact summary", async () => {
      const p = await proposed({ personId: id.liwei }, { title: "Director", phone: "", country: "Singapore" });
      const r = await applyDetails(db, p);
      expect(r).toEqual({ status: "updated", written: ["title", "phone", "country"], skipped: [], name: "Li Wei" });
      const row = (await db.query("SELECT title, phone, country FROM people WHERE id = $1", [id.liwei])).rows[0];
      expect(row).toEqual({ title: "Director", phone: null, country: "Singapore" });
      const touches = (await db.query("SELECT member_id, kind, by_whom, summary FROM touches")).rows;
      expect(touches).toEqual([
        {
          member_id: id.mLi,
          kind: "system",
          by_whom: "VF",
          summary: "Details updated: Title: (empty) → Director; Phone: +65 2222 0000 → (empty); Country: (empty) → Singapore",
        },
      ]);
    });

    it("updates name_key with the name", async () => {
      const r = await applyDetails(db, await proposed({ personId: id.liwei }, { name: "  Li Wei Chen " }));
      expect(r.status).toBe("updated");
      const row = (await db.query("SELECT name, name_key FROM people WHERE id = $1", [id.liwei])).rows[0];
      expect(row).toEqual({ name: "Li Wei Chen", name_key: "li wei chen" });
      expect(r.name).toBe("Li Wei Chen");
    });

    it("edits a company's website and logs to its member", async () => {
      const r = await applyDetails(db, await proposed({ orgId: id.nw }, { website: "https://nw.example", country: "UK" }));
      expect(r.status).toBe("updated");
      expect((await db.query("SELECT website, country FROM orgs WHERE id = $1", [id.nw])).rows[0]).toEqual({
        website: "https://nw.example",
        country: "UK",
      });
      const t = (await db.query("SELECT member_id, summary FROM touches")).rows;
      expect(t).toEqual([
        { member_id: id.mNw, summary: "Details updated: Country: (empty) → UK; Website: (empty) → https://nw.example" },
      ]);
    });

    it("sets a company, creating the org once and linking it", async () => {
      const p = await proposed({ personId: id.pat }, { company: "Brand New Ltd" });
      expect((await applyDetails(db, p)).status).toBe("updated");
      expect(await count("orgs", "name_key = 'brand new ltd' AND source = 'monsoon-app'")).toBe(1);
      const orgId = (await db.query("SELECT id FROM orgs WHERE name_key = 'brand new ltd'")).rows[0].id;
      expect((await db.query("SELECT org_id FROM people WHERE id = $1", [id.pat])).rows[0].org_id).toBe(orgId);
      // a second person moved to the same company reuses the org
      const q = await proposed({ personId: id.patty }, { company: "Brand New Ltd" });
      expect((await applyDetails(db, q)).status).toBe("updated");
      expect(await count("orgs", "name_key = 'brand new ltd'")).toBe(1);
    });

    it("clearing the company sets org_id to null", async () => {
      const p = await proposed({ personId: id.liwei }, { company: "" });
      expect((await applyDetails(db, p)).status).toBe("updated");
      expect((await db.query("SELECT org_id FROM people WHERE id = $1", [id.liwei])).rows[0].org_id).toBeNull();
      // logged on the member found from the state before the change
      expect((await db.query("SELECT member_id, summary FROM touches")).rows).toEqual([
        { member_id: id.mLi, summary: "Details updated: Company: Acme Capital → (empty)" },
      ]);
    });

    it("logs a company change on the company's member as it was before the change", async () => {
      // Jane Tan (Northwind) has no member of her own: the log goes to Northwind's member, not Acme's.
      const p = await proposed({ personId: id.jane }, { company: "Orphan Co" });
      expect(p.logMemberId).toBe(id.mNw);
      expect((await applyDetails(db, p)).status).toBe("updated");
      expect((await db.query("SELECT member_id FROM touches")).rows).toEqual([{ member_id: id.mNw }]);
    });

    it("a stale field is skipped and reported", async () => {
      const p = await proposed({ personId: id.jane }, { title: "Director", phone: "+65 9999 0000" });
      await db.query("UPDATE people SET title = 'Partner' WHERE id = $1", [id.jane]);
      const r = await applyDetails(db, p);
      expect(r).toEqual({ status: "partly", written: ["phone"], skipped: ["title"], name: "Jane Tan" });
      const row = (await db.query("SELECT title, phone FROM people WHERE id = $1", [id.jane])).rows[0];
      expect(row).toEqual({ title: "Partner", phone: "+65 9999 0000" });
      expect((await db.query("SELECT summary FROM touches")).rows).toEqual([
        { summary: "Details updated: Phone: +65 1111 0000 → +65 9999 0000" },
      ]);
    });

    it("all stale is unchanged, with no touch", async () => {
      const p = await proposed({ personId: id.jane }, { title: "Director" });
      await db.query("UPDATE people SET title = 'Partner' WHERE id = $1", [id.jane]);
      const before = await snapshot();
      expect(await applyDetails(db, p)).toEqual({ status: "unchanged", written: [], skipped: ["title"], name: "Jane Tan" });
      expect(await snapshot()).toEqual(before);
    });

    it("confirming twice writes once", async () => {
      const p = await proposed({ personId: id.liwei }, { title: "Director" });
      expect((await applyDetails(db, p)).status).toBe("updated");
      expect((await applyDetails(db, p)).status).toBe("unchanged");
      expect(await count("touches")).toBe(1);
    });

    it("confirming twice at once writes once", async () => {
      const other = await testDb.connect();
      try {
        const p = await proposed({ personId: id.liwei }, { title: "Director" });
        const [a, b] = await Promise.all([applyDetails(db, p), applyDetails(other, p)]);
        expect([a.status, b.status].sort()).toEqual(["unchanged", "updated"]);
        expect(await count("touches")).toBe(1);
      } finally {
        await other.end();
      }
    });

    it("addsToPipeline creates the member and logs to it", async () => {
      const p = await proposed({ personId: id.sam }, { title: "Associate" });
      expect(p.addsToPipeline).toBe("investor");
      expect((await applyDetails(db, p)).status).toBe("updated");
      const m = (await db.query("SELECT id, role, stage, owner, source FROM members WHERE person_id = $1", [id.sam])).rows;
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ role: "investor", owner: "VF", source: "monsoon-app" });
      const first = (await db.query("SELECT key FROM stages WHERE NOT terminal ORDER BY ord LIMIT 1")).rows[0].key;
      expect(m[0].stage).toBe(first);
      // the stage trigger does not fire on insert: the only touch is the log entry
      expect((await db.query("SELECT member_id, kind, summary FROM touches")).rows).toEqual([
        { member_id: m[0].id, kind: "system", summary: "Details updated: Title: (empty) → Associate" },
      ]);
    });

    it("retries once in a fresh transaction when a concurrent capture added the person to the pipeline", async () => {
      const p = await proposed({ personId: id.sam }, { title: "Associate" });
      let failed = 0;
      let inserted = false;
      const racing = new Proxy(db, {
        get(target, prop) {
          if (prop !== "query") return Reflect.get(target, prop);
          const run = target.query.bind(target) as (...a: unknown[]) => Promise<unknown>;
          return async (text: unknown, ...rest: unknown[]) => {
            if (typeof text === "string" && text.startsWith("INSERT INTO members") && failed === 0) {
              failed++;
              throw Object.assign(new Error("duplicate"), { code: "23505", table: "members", constraint: "members_firm_id_person_id_key" });
            }
            // The concurrent capture commits its member before the retry begins.
            if (failed === 1 && !inserted && text === "BEGIN ISOLATION LEVEL READ COMMITTED") {
              inserted = true;
              await run(
                "INSERT INTO members (person_id, role, stage, owner, source) VALUES ($1, 'investor', 'contacted', 'VF', 'test')",
                [id.sam],
              );
            }
            return run(text, ...rest);
          };
        },
      });
      expect((await applyDetails(racing, p)).status).toBe("updated");
      const m = (await db.query("SELECT id, source FROM members WHERE person_id = $1", [id.sam])).rows;
      expect(m).toHaveLength(1);
      expect(m[0].source).toBe("test");
      expect((await db.query("SELECT member_id, summary FROM touches")).rows).toEqual([
        { member_id: m[0].id, summary: "Details updated: Title: (empty) → Associate" },
      ]);
      expect((await db.query("SELECT title FROM people WHERE id = $1", [id.sam])).rows[0].title).toBe("Associate");
    });

    it("reports the members clash by table, with the constraint name of this schema", async () => {
      const err = await db
        .query("INSERT INTO members (person_id, role, stage, owner, source) VALUES ($1, 'investor', 'contacted', 'VF', 'test')", [id.liwei])
        .catch((e) => e);
      expect(err).toMatchObject({ code: "23505", table: "members", constraint: "members_org_id_person_id_key" });
    });

    it("reports a name collision by table, whatever the unique key is called (Traxo-style names)", async () => {
      const p = await proposed({ personId: id.liwei }, { title: "Director" });
      const before = await snapshot();
      const renamed = new Proxy(db, {
        get(target, prop) {
          if (prop !== "query") return Reflect.get(target, prop);
          return (text: unknown, ...rest: unknown[]) => {
            if (typeof text === "string" && text.startsWith("UPDATE people")) {
              return Promise.reject(Object.assign(new Error("duplicate"), { code: "23505", table: "people", constraint: "people_firm_id_name_key_key" }));
            }
            return (target.query as (...a: unknown[]) => Promise<unknown>)(text, ...rest);
          };
        },
      });
      expect(await applyDetails(renamed, p)).toEqual({ status: "collision", written: [], skipped: [], name: "Li Wei" });
      expect(await snapshot()).toEqual(before);
    });

    it("retries the member insert once by table, with a Traxo-style constraint name", async () => {
      const p = await proposed({ personId: id.sam }, { title: "Associate" });
      let inserts = 0;
      const renamed = new Proxy(db, {
        get(target, prop) {
          if (prop !== "query") return Reflect.get(target, prop);
          const run = target.query.bind(target) as (...a: unknown[]) => Promise<unknown>;
          return async (text: unknown, ...rest: unknown[]) => {
            if (typeof text === "string" && text.startsWith("INSERT INTO members")) {
              inserts++;
              if (inserts === 1) {
                throw Object.assign(new Error("duplicate"), { code: "23505", table: "members", constraint: "members_firm_id_person_id_key" });
              }
            }
            if (inserts === 1 && text === "BEGIN ISOLATION LEVEL READ COMMITTED") {
              inserts = 2; // the concurrent capture's member is committed before the retry begins
              await run("INSERT INTO members (person_id, role, stage, owner, source) VALUES ($1, 'investor', 'contacted', 'VF', 'test')", [id.sam]);
            }
            return run(text, ...rest);
          };
        },
      });
      expect((await applyDetails(renamed, p)).status).toBe("updated");
      expect(await count("members", `person_id = '${id.sam}'`)).toBe(1);
      expect(await count("touches", "kind = 'system'")).toBe(1);
    });

    it("rethrows when the member insert violates the unique key twice, writing nothing", async () => {
      const p = await proposed({ personId: id.sam }, { title: "Associate" });
      const before = await snapshot();
      const failing = new Proxy(db, {
        get(target, prop) {
          if (prop !== "query") return Reflect.get(target, prop);
          return (text: unknown, ...rest: unknown[]) => {
            if (typeof text === "string" && text.startsWith("INSERT INTO members")) {
              return Promise.reject(Object.assign(new Error("duplicate"), { code: "23505", table: "members", constraint: "members_org_id_person_id_key" }));
            }
            return (target.query as (...a: unknown[]) => Promise<unknown>)(text, ...rest);
          };
        },
      });
      await expect(applyDetails(failing, p)).rejects.toThrow("duplicate");
      expect(await snapshot()).toEqual(before);
    });

    it("names the collision after the name on the row now, not the stale proposed name", async () => {
      const p = await proposed({ personId: id.liwei }, { title: "Director", name: "Li Wei Chen" });
      await db.query("UPDATE people SET name = 'Li Wei Zed', name_key = 'li wei zed' WHERE id = $1", [id.liwei]);
      const clash = new Proxy(db, {
        get(target, prop) {
          if (prop !== "query") return Reflect.get(target, prop);
          return (text: unknown, ...rest: unknown[]) => {
            if (typeof text === "string" && text.startsWith("UPDATE people")) {
              return Promise.reject(Object.assign(new Error("duplicate"), { code: "23505", table: "people", constraint: "people_firm_id_name_key_key" }));
            }
            return (target.query as (...a: unknown[]) => Promise<unknown>)(text, ...rest);
          };
        },
      });
      expect(await applyDetails(clash, p)).toEqual({ status: "collision", written: [], skipped: [], name: "Li Wei Zed" });
    });

    it("adds no member when nothing is written", async () => {
      const p = await proposed({ personId: id.sam }, { title: "Associate" });
      await db.query("UPDATE people SET title = 'Other' WHERE id = $1", [id.sam]);
      expect((await applyDetails(db, p)).status).toBe("unchanged");
      expect(await count("members", "person_id IS NOT NULL")).toBe(1);
    });

    it("a collision created between propose and apply writes nothing", async () => {
      const p = await proposed({ personId: id.liwei }, { title: "Director", name: "Li Wei Chen" });
      await db.query(
        "INSERT INTO people (org_id, name, name_key, source) VALUES ($1, 'Li Wei Chen', 'li wei chen', 'test')",
        [id.acme],
      );
      const before = await snapshot();
      const r = await applyDetails(db, p);
      expect(r).toEqual({ status: "collision", written: [], skipped: [], name: "Li Wei Chen" });
      expect(await snapshot()).toEqual(before);
    });

    it("a company created in the same transaction is rolled back on collision", async () => {
      const p = await proposed({ personId: id.pat }, { company: "Fresh Ltd" });
      // Another Pat Lee appears at the company-to-be: the org does not exist yet, so create it too.
      const org = (await db.query("INSERT INTO orgs (name, name_key, source) VALUES ('Fresh Ltd', 'fresh ltd', 'test') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO people (org_id, name, name_key, source) VALUES ($1, 'Pat Lee', 'pat lee', 'test')", [org]);
      const before = await snapshot();
      expect((await applyDetails(db, p)).status).toBe("collision");
      expect(await snapshot()).toEqual(before);
    });

    it("reports a missing person or company", async () => {
      const p = await proposed({ personId: id.sam }, { title: "Associate" });
      await db.query("DELETE FROM people WHERE id = $1", [id.sam]); // test setup only
      expect(await applyDetails(db, p)).toEqual({ status: "missing", written: [], skipped: [], name: "Sam Ortiz" });
      const c = await proposed({ orgId: id.nw }, { country: "UK" });
      await db.query("DELETE FROM orgs WHERE id = $1", [id.nw]);
      expect((await applyDetails(db, c)).status).toBe("missing");
    });

    it("two concurrent company changes for a company-less person write exactly one", async () => {
      const other = await testDb.connect();
      try {
        const a = await proposed({ personId: id.pat }, { company: "Alpha Ltd" });
        const b = await proposed({ personId: id.pat }, { company: "Beta Ltd" });
        const [ra, rb] = await Promise.all([applyDetails(db, a), applyDetails(other, b)]);
        const statuses = [ra.status, rb.status].sort();
        expect(statuses[1]).toBe("updated");
        expect(["unchanged", "partly"]).toContain(statuses[0]);
        const stale = ra.status === "updated" ? rb : ra;
        expect(stale.skipped).toEqual(["company"]);
        expect(stale.written).toEqual([]);
        const row = (await db.query("SELECT o.name FROM people p JOIN orgs o ON o.id = p.org_id WHERE p.id = $1", [id.pat])).rows;
        expect(row).toHaveLength(1);
        const winner = ra.status === "updated" ? "Alpha Ltd" : "Beta Ltd";
        expect(row[0].name).toBe(winner);
        expect(await count("touches", "kind = 'system'")).toBe(1);
        expect((await db.query("SELECT summary FROM touches")).rows[0].summary).toBe(
          `Details updated: Company: (empty) → ${winner}`,
        );
      } finally {
        await other.end();
      }
    });

    it("rethrows a unique violation that is not the namesake key, writing nothing", async () => {
      const p = await proposed({ personId: id.liwei }, { title: "Director" });
      const before = await snapshot();
      const failing = new Proxy(db, {
        get(target, prop) {
          if (prop !== "query") return Reflect.get(target, prop);
          return (text: unknown, ...rest: unknown[]) => {
            if (typeof text === "string" && text.startsWith("UPDATE people")) {
              return Promise.reject(Object.assign(new Error("duplicate"), { code: "23505", table: "people", constraint: "people_pkey" }));
            }
            return (target.query as (...a: unknown[]) => Promise<unknown>)(text, ...rest);
          };
        },
      });
      await expect(applyDetails(failing, p)).rejects.toThrow("duplicate");
      expect(await snapshot()).toEqual(before);
    });

    it("reports unlogged, writing nothing, when the contact has no pipeline entry any more", async () => {
      const p = await proposed({ personId: id.liwei }, { title: "Director" });
      await db.query("DELETE FROM members WHERE id = $1", [id.mLi]); // test setup only
      const before = await snapshot();
      expect(await applyDetails(db, p)).toEqual({ status: "unlogged", written: [], skipped: [], name: "Li Wei" });
      expect(await snapshot()).toEqual(before);
      const c = await proposed({ orgId: id.nw }, { country: "UK" });
      await db.query("DELETE FROM members WHERE id = $1", [id.mNw]); // test setup only
      expect((await applyDetails(db, c)).status).toBe("unlogged");
      expect((await db.query("SELECT country FROM orgs WHERE id = $1", [id.nw])).rows[0].country).toBeNull();
    });

    it("deletes no row and changes no notes column", async () => {
      await db.query("UPDATE people SET notes = 'keep me' WHERE id = $1", [id.liwei]);
      await db.query("UPDATE orgs SET notes = 'keep me too' WHERE id = $1", [id.nw]);
      await db.query("UPDATE members SET notes = 'and me' WHERE id = $1", [id.mLi]);
      await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', 'VF', 'old note')", [id.mLi]);
      const before = (await snapshot()) as Record<string, { id: string; notes?: unknown; summary?: unknown }[]>;
      await applyDetails(db, await proposed({ personId: id.liwei }, { title: "Director", company: "Brand New Ltd" }, { newCompany: true }));
      await applyDetails(db, await proposed({ orgId: id.nw }, { website: "https://x.example" }));
      await applyDetails(db, await proposed({ personId: id.sam }, { name: "Samuel Ortiz" }));
      const after = (await snapshot()) as typeof before;
      for (const t of ["orgs", "people", "members", "touches"]) {
        for (const row of before[t]) {
          const now = after[t].find((r) => r.id === row.id);
          expect(now, `${t} row kept`).toBeDefined();
          expect(now!.notes, `${t}.notes`).toEqual(row.notes);
          expect(now!.summary, `${t}.summary`).toEqual(row.summary);
        }
      }
    });
  });
});
