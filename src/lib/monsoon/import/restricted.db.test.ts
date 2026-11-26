import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSetupScript } from "../accounts/setup-script";
import { recentContacts } from "../contacts";
import { listImported, listImports, listMembers } from "../sift";
import { makeTestDb, testRoleName } from "../testing/db";
import { classifyRows } from "./classify";
import { withImportLock } from "./guard";
import type { ImportContact } from "./mapping";
import { noteCompanyImports, saveImportRows } from "./save";

const testDb = makeTestDb("import_login");
const LABEL = "LinkedIn import, November 2026";
const TODAY = "2026-11-25";

// The whole import, as the app runs it for a customer: through the restricted login the setup
// script creates (select, insert and update on the Monsoon tables; nothing else). It needs no
// privilege that login lacks.
describe.skipIf(!testDb.available)("the import through the restricted app login (real Postgres)", () => {
  const role = `${testRoleName()}_import`;
  const password = randomBytes(18).toString("base64url");
  let admin: Client;
  let app: Client;
  let guard: Client;

  async function asRole(): Promise<Client> {
    const url = new URL(testDb.url());
    const c = new Client({ host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), user: role, password });
    await c.connect();
    return c;
  }
  async function dropRole(c: Client) {
    if ((await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount) await c.query(`DROP OWNED BY ${role}`);
    await c.query(`DROP ROLE IF EXISTS ${role}`);
  }

  beforeAll(async () => {
    admin = await testDb.connect();
    // The setup script builds the tables itself, so it starts from an empty schema.
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await dropRole(admin);
    await admin.query(
      generateSetupScript({
        stages: [
          { key: "uncontacted", ord: 0, label: "Uncontacted", terminal: false },
          { key: "engaged", ord: 1, label: "Engaged", terminal: false },
        ],
        roles: [{ key: "investor", label: "Investor" }],
        owners: [{ key: "VF", name: "Vincent" }],
        roleName: role,
        password,
      }),
    );
    // On file before the import: a person with a pipeline entry, and a company that is itself one.
    const jane = (await admin.query("INSERT INTO people (name, name_key, email, source) VALUES ('Jane Tan', 'jane tan', 'jane@acme.com', 'seed') RETURNING id")).rows[0].id;
    await admin.query("INSERT INTO members (person_id, role, stage, owner, source) VALUES ($1, 'investor', 'engaged', 'VF', 'seed')", [jane]);
    const org = (await admin.query("INSERT INTO orgs (name, name_key, source) VALUES ('Northwind', 'northwind', 'seed') RETURNING id")).rows[0].id;
    await admin.query("INSERT INTO members (org_id, role, stage, owner, source) VALUES ($1, 'investor', 'engaged', 'VF', 'seed')", [org]);
    app = await asRole();
    guard = await asRole();
  });
  afterAll(async () => {
    await app?.end();
    await guard?.end();
    if (admin) {
      await dropRole(admin).catch(() => undefined);
      await admin.end();
    }
  });

  it("is the restricted login: no superuser, no row-security bypass, and it cannot delete", async () => {
    const me = (await app.query("SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
    expect(me).toEqual({ name: role, rolsuper: false, rolbypassrls: false });
    await expect(app.query("TRUNCATE captures")).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("UPDATE captures SET status = 'rejected'")).rejects.toMatchObject({ code: "42501" });
  });

  it("checks, saves, closes and lists an import with nothing but that login", async () => {
    const contacts: (ImportContact | null)[] = [
      { name: "Jane Tan", email: "jane@acme.com" }, // already on file
      { name: "Omar Haddad", org: "Acme Capital", email: "omar@acme.com", notes: "Met at SFF", connectedOn: "2021-03-02" }, // new, a new company
      { name: "Bea Park", org: "Northwind" }, // new, under the company that is a pipeline entry
      { name: "Cy Wu", org: "Northwind" },
      { name: "Jane Tan", org: "Elsewhere" }, // a possible match
      null,
    ];
    expect((await classifyRows(app, contacts)).map((v) => v.class)).toEqual(["existing", "new", "new", "new", "possible", "unreadable"]);

    const importId = randomUUID();
    const input = { importId, label: LABEL, role: "investor", owner: "VF", includePossible: true };
    const rows = contacts.map((contact, rowNumber) => ({ rowNumber, contact }));
    const saved = await withImportLock(guard, "person-1", () => saveImportRows(app, { ...input, rows: rows.slice(0, 3) }));
    expect(saved).toMatchObject({ locked: true });
    expect(saved.locked && saved.value.map((r) => r.outcome)).toEqual(["existing", "added", "added"]);
    // The rest with the first batch sent again, then the close, twice.
    expect((await saveImportRows(app, { ...input, rows })).map((r) => r.outcome)).toEqual(["existing", "added", "added", "added", "added", "unreadable"]);
    await noteCompanyImports(app, { importId, label: LABEL, owner: "VF" });
    await noteCompanyImports(app, { importId, label: LABEL, owner: "VF" });
    // The same file again after a reload.
    expect((await saveImportRows(app, { ...input, importId: randomUUID(), rows })).map((r) => r.outcome)).toEqual([
      "existing",
      "existing",
      "existing",
      "existing",
      "existing",
      "unreadable",
    ]);

    expect((await admin.query("SELECT summary FROM touches WHERE kind = 'system' ORDER BY summary")).rows.map((r) => r.summary)).toEqual([
      `2 people imported from ${LABEL}.`,
      `Also in ${LABEL}.`,
      `Also in ${LABEL}.`,
      `Imported from ${LABEL}.`,
      `Imported from ${LABEL}. Connected on LinkedIn 2 Mar 2021.`,
    ]);

    expect((await listImports(app)).map((i) => [i.label, i.count])).toEqual([[LABEL, 4]]);
    const imported = await listImported(app, { label: LABEL, high: false, sort: "stage", today: TODAY });
    expect(imported.total).toBe(4);
    expect(imported.contacts.map((c) => c.name).sort()).toEqual(["Bea Park", "Cy Wu", "Jane Tan", "Omar Haddad"]);
    for (const sort of ["recent", "next", "last", "stage"] as const) {
      const all = await listMembers(app, { high: false, sort, today: TODAY });
      expect(all.total).toBe(4);
      expect(all.contacts.map((c) => c.name).sort()).toEqual(["Jane Tan", "Jane Tan", "Northwind", "Omar Haddad"]);
    }
    expect(await recentContacts(app)).toHaveLength(4);
    expect((await app.query("SELECT 1 AS one")).rows[0].one).toBe(1);
  });
});
