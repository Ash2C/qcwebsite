import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Proposal, ResearchFinding } from "./ask/proposal";
import { applyResearch } from "./research-apply";
import { ensureOwner } from "./owners";
import { testDb } from "./testing/db";

type Research = Extract<Proposal, { kind: "apply_research" }>;

describe.skipIf(!testDb.available)("Applying research (real Postgres)", () => {
  let db: Client;
  const id = {
    nw: randomUUID(),
    acme: randomUUID(),
    orphan: randomUUID(),
    jane: randomUUID(), // at Northwind, own member
    liwei: randomUUID(), // at Acme, no own member (Acme has one)
    sam: randomUUID(), // at Orphan Co, no timeline anywhere
    mJane: randomUUID(),
    mAcme: randomUUID(),
  };
  const U = {
    title: "https://example.com/a",
    linkedin: "https://example.com/b",
    web: "https://example.com/c",
    sum: "https://example.com/d",
  };
  const findings: ResearchFinding[] = [
    { id: "f1", target: "person", field: "title", from: "Analyst", to: "Director", source: U.title },
    { id: "f2", target: "person", field: "linkedin", from: null, to: "https://linkedin.com/in/jane-tan", source: U.linkedin },
    { id: "f3", target: "company", field: "website", from: null, to: "https://northwind.example", source: U.web },
  ];

  function proposal(over: Partial<Research> = {}): Research {
    return {
      kind: "apply_research",
      estate: "zeroone",
      person: { id: id.jane, name: "Jane Tan" },
      company: { id: id.nw, name: "Northwind Capital" },
      identity: "Same person.",
      findings,
      summarySources: [U.sum],
      logMemberId: id.mJane,
      addsToPipeline: null,
      expires: 0,
      ...over,
    };
  }
  async function count(table: string): Promise<number> {
    return (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  }
  const touches = async () => (await db.query("SELECT member_id, kind, by_whom, summary FROM touches ORDER BY at, id")).rows;
  const systemTouches = async () => (await touches()).filter((x) => x.kind === "system");

  beforeEach(async () => {
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
      `INSERT INTO people (id, org_id, name, name_key, title, source) VALUES
         ($1, $4, 'Jane Tan', 'jane tan', 'Analyst', 'test'),
         ($2, $5, 'Li Wei', 'li wei', NULL, 'test'),
         ($3, $6, 'Sam Ortiz', 'sam ortiz', NULL, 'test')`,
      [id.jane, id.liwei, id.sam, id.nw, id.acme, id.orphan],
    );
    await db.query(
      `INSERT INTO members (id, org_id, person_id, role, stage, owner, source) VALUES
         ($1, NULL, $3, 'investor', 'engaged', 'VF', 'test'),
         ($2, $4, NULL, 'investor', 'contacted', 'VF', 'test')`,
      [id.mJane, id.mAcme, id.jane, id.acme],
    );
    await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', 'VF', 'Earlier note')", [
      id.mJane,
    ]);
  });
  afterEach(async () => {
    await db.end();
  });

  it("writes only the ticked findings and one system touch with the exact text", async () => {
    const r = await applyResearch(db, proposal(), ["f1", "f3"], "Jane runs the desk.", "VF");
    expect(r).toEqual({ status: "saved", written: ["Title", "Website"], skipped: [], name: "Jane Tan" });
    const p = (await db.query("SELECT title, linkedin_url FROM people WHERE id = $1", [id.jane])).rows[0];
    expect(p).toEqual({ title: "Director", linkedin_url: null });
    expect((await db.query("SELECT website FROM orgs WHERE id = $1", [id.nw])).rows[0].website).toBe("https://northwind.example");
    const t = await systemTouches();
    expect(t).toHaveLength(1);
    expect(t[0].member_id).toBe(id.mJane);
    expect(t[0].by_whom).toBe("VF");
    expect(t[0].summary).toBe(
      `Research saved: Title: Analyst → Director; Website: (empty) → https://northwind.example\n\nJane runs the desk.\n\nSources: ${U.title}, ${U.web}, ${U.sum}`,
    );
  });

  it("omits the summary and its sources when no summary is saved", async () => {
    await applyResearch(db, proposal(), ["f2"], "", "VF");
    const t = await systemTouches();
    expect(t[0].summary).toBe(`Research saved: LinkedIn: (empty) → https://linkedin.com/in/jane-tan\n\nSources: ${U.linkedin}`);
  });

  it("de-duplicates sources, finding sources first", async () => {
    const same = findings.map((f) => ({ ...f, source: U.sum }));
    await applyResearch(db, proposal({ findings: same }), ["f1", "f2"], "S.", "VF");
    const t = await systemTouches();
    expect(t[0].summary.endsWith(`\n\nSources: ${U.sum}`)).toBe(true);
  });

  it("skips a finding whose from no longer matches and reports partly", async () => {
    await db.query("UPDATE people SET title = 'VP' WHERE id = $1", [id.jane]);
    const r = await applyResearch(db, proposal(), ["f1", "f2"], "", "VF");
    expect(r).toEqual({ status: "partly", written: ["LinkedIn"], skipped: ["Title"], name: "Jane Tan" });
    expect((await db.query("SELECT title FROM people WHERE id = $1", [id.jane])).rows[0].title).toBe("VP");
    const t = await systemTouches();
    expect(t[0].summary).not.toContain("Title");
    expect(t[0].summary).not.toContain(U.title);
  });

  it("skips the website finding when the person has moved company", async () => {
    await db.query("UPDATE people SET org_id = $1 WHERE id = $2", [id.acme, id.jane]);
    const r = await applyResearch(db, proposal(), ["f1", "f3"], "", "VF");
    expect(r).toEqual({ status: "partly", written: ["Title"], skipped: ["Website"], name: "Jane Tan" });
    expect((await db.query("SELECT website FROM orgs WHERE id = $1", [id.nw])).rows[0].website).toBeNull();
  });

  it("logs on the company's timeline when the person has no membership", async () => {
    const r = await applyResearch(
      db,
      proposal({ person: { id: id.liwei, name: "Li Wei" }, company: { id: id.acme, name: "Acme Capital" }, logMemberId: id.mAcme }),
      ["f2"],
      "", "VF"
    );
    expect(r.status).toBe("saved");
    const t = await systemTouches();
    expect(t).toHaveLength(1);
    expect(t[0].member_id).toBe(id.mAcme);
    expect(await count("members")).toBe(2);
  });

  it("adds a person with no timeline to the pipeline when addsToPipeline is set", async () => {
    const r = await applyResearch(
      db,
      proposal({ person: { id: id.sam, name: "Sam Ortiz" }, company: null, logMemberId: null, addsToPipeline: "investor" }),
      ["f2"],
      "", "VF"
    );
    expect(r.status).toBe("saved");
    const m = (await db.query("SELECT id, role, owner, source FROM members WHERE person_id = $1", [id.sam])).rows;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ role: "investor", owner: "VF", source: "monsoon-app" });
    const t = await systemTouches();
    expect(t[0].member_id).toBe(m[0].id);
  });

  it("is unlogged and writes nothing when there is no timeline and no pipeline role", async () => {
    const before = await count("touches");
    const r = await applyResearch(
      db,
      proposal({ person: { id: id.sam, name: "Sam Ortiz" }, company: null, logMemberId: null, addsToPipeline: null }),
      ["f2"],
      "", "VF"
    );
    expect(r.status).toBe("unlogged");
    expect(await count("touches")).toBe(before);
    expect((await db.query("SELECT linkedin_url FROM people WHERE id = $1", [id.sam])).rows[0].linkedin_url).toBeNull();
  });

  it("a summary alone writes one touch and no field", async () => {
    const r = await applyResearch(db, proposal(), [], "Only a summary.", "VF");
    expect(r).toEqual({ status: "saved", written: [], skipped: [], name: "Jane Tan" });
    const t = await systemTouches();
    expect(t).toHaveLength(1);
    expect(t[0].summary).toBe(`Research saved:\n\nOnly a summary.\n\nSources: ${U.sum}`);
    expect((await db.query("SELECT title FROM people WHERE id = $1", [id.jane])).rows[0].title).toBe("Analyst");
  });

  it("nothing ticked and no summary is unchanged with no new rows", async () => {
    const before = [await count("people"), await count("orgs"), await count("touches"), await count("members")];
    const r = await applyResearch(db, proposal(), [], "", "VF");
    expect(r.status).toBe("unchanged");
    expect([await count("people"), await count("orgs"), await count("touches"), await count("members")]).toEqual(before);
  });

  it("every ticked finding stale and no summary is unchanged", async () => {
    await db.query("UPDATE people SET title = 'VP' WHERE id = $1", [id.jane]);
    const r = await applyResearch(db, proposal(), ["f1"], "", "VF");
    expect(r).toEqual({ status: "unchanged", written: [], skipped: ["Title"], name: "Jane Tan" });
    expect(await systemTouches()).toHaveLength(0);
  });

  it("a summary saved while every ticked finding is stale reports partly, with nothing written", async () => {
    await db.query("UPDATE people SET title = 'VP' WHERE id = $1", [id.jane]);
    const r = await applyResearch(db, proposal(), ["f1"], "Jane runs the desk.", "VF");
    expect(r).toEqual({ status: "partly", written: [], skipped: ["Title"], name: "Jane Tan" });
    const t = await systemTouches();
    expect(t).toHaveLength(1);
    expect(t[0].summary).toBe(`Research saved:

Jane runs the desk.

Sources: ${U.sum}`);
  });

  it("leaves every other person column untouched", async () => {
    await db.query("UPDATE people SET email = 'jane@northwind.example', phone = '+65 5555 0100', country = 'Singapore' WHERE id = $1", [id.jane]);
    const cols = "name, name_key, org_id, email, phone, country, linkedin_url, source";
    const before = (await db.query(`SELECT ${cols} FROM people WHERE id = $1`, [id.jane])).rows[0];
    await applyResearch(db, proposal(), ["f1", "f2"], "", "VF");
    const after = (await db.query(`SELECT ${cols}, title FROM people WHERE id = $1`, [id.jane])).rows[0];
    const { title, linkedin_url, ...rest } = after;
    const { linkedin_url: _l, ...beforeRest } = before;
    expect(title).toBe("Director");
    expect(linkedin_url).toBe("https://linkedin.com/in/jane-tan");
    expect(rest).toEqual(beforeRest);
  });

  it("reports a deleted person as missing", async () => {
    const r = await applyResearch(db, proposal({ person: { id: randomUUID(), name: "Gone Person" } }), ["f1"], "", "VF");
    expect(r).toEqual({ status: "missing", written: [], skipped: [], name: "Gone Person" });
  });

  it("never lowers a row count or rewrites an existing touch", async () => {
    const before = { people: await count("people"), orgs: await count("orgs"), touches: await count("touches") };
    const old = (await touches()).filter((x) => x.kind === "note");
    await applyResearch(db, proposal(), ["f1", "f2", "f3"], "Summary.", "VF");
    expect(await count("people")).toBeGreaterThanOrEqual(before.people);
    expect(await count("orgs")).toBeGreaterThanOrEqual(before.orgs);
    expect(await count("touches")).toBe(before.touches + 1);
    expect((await touches()).filter((x) => x.kind === "note")).toEqual(old);
  });

  it("stamps the added member and the log touch with the given owner key", async () => {
    await ensureOwner(db, "AB", "Ana B");
    const r = await applyResearch(
      db,
      proposal({ person: { id: id.sam, name: "Sam Ortiz" }, company: null, logMemberId: null, addsToPipeline: "investor" }),
      ["f2"],
      "",
      "AB",
    );
    expect(r.status).toBe("saved");
    expect((await db.query("SELECT owner FROM members WHERE person_id = $1", [id.sam])).rows).toEqual([{ owner: "AB" }]);
    expect((await systemTouches())[0].by_whom).toBe("AB");
  });
});
