// Pins what the setup checks send to an existing customer's database (schema public): every
// statement and its values, hashed before the schema parameter was added. Must never change.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ queries: [] as Array<{ text: string; values: unknown[] }>, args: [] as unknown[][] }));
vi.mock("../db", () => ({
  withPipelineDb: async (...args: unknown[]) => {
    sent.args.push(args.slice(2));
    const db = {
      query: async (text: string, values: unknown[] = []) => {
        sent.queries.push({ text, values });
        if (text.includes("to_regclass")) return { rowCount: 1, rows: [{ n: 11 }] };
        if (text.includes("max(version)")) return { rowCount: 1, rows: [{ v: 1 }] };
        if (text.includes("open_stage")) return { rowCount: 1, rows: [{ open_stage: true, default_role: true }] };
        if (text.startsWith("DELETE")) throw Object.assign(new Error("permission denied"), { code: "42501" });
        if (text.includes("has_table_privilege")) return { rowCount: 1, rows: [{ n: 0 }] };
        if (text.includes("pg_roles")) return { rowCount: 1, rows: [{ extra: false }] };
        if (text.includes("pg_policies")) return { rowCount: 1, rows: [{ n: 0 }] };
        return { rowCount: 0, rows: [] };
      },
    };
    return (args[1] as (db: unknown) => Promise<unknown>)(db);
  },
}));

import { runSetupChecks } from "./setup-check";

const URL_OK = "postgresql://monsoon_app.abcdefghij0123456789:pw@aws-1-us-east-1.pooler.supabase.com:6543/postgres";
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

beforeEach(() => {
  sent.queries.length = 0;
  sent.args.length = 0;
});

describe("the setup checks for existing callers do not change", () => {
  it("sends exactly the same statements and values, and connects with nothing extra", async () => {
    const result = await runSetupChecks({
      dbUrl: URL_OK,
      claudeKey: null,
      roleName: "monsoon_app",
      defaultRole: "investor",
      tryClaude: async () => true,
    });
    expect(result).toEqual({ ok: true });
    expect(sent.queries.length).toBe(9);
    expect(sha(sent.queries)).toMatchInlineSnapshot(`"4bd79936885076180320ce9df5a7214bc8da8b582f3bfa531dedaccc67c05ffe"`);
    // No schema is handed to the connection for an existing caller.
    expect(sent.args).toEqual([[]]);
  });

  it("naming the schema public sends the same statements", async () => {
    await runSetupChecks({ dbUrl: URL_OK, claudeKey: null, roleName: "monsoon_app", defaultRole: "investor", schema: "public", tryClaude: async () => true });
    expect(sha(sent.queries)).toBe("4bd79936885076180320ce9df5a7214bc8da8b582f3bfa531dedaccc67c05ffe");
    expect(sent.args).toEqual([[]]);
  });
});

describe("the setup checks for a named schema (the shared database)", () => {
  const SCHEMA = "c_0b9d2a476a3e4c1f9d552f7a3c1e8b10";
  const run = (schema: string) =>
    runSetupChecks({ dbUrl: URL_OK, claudeKey: null, roleName: "monsoon_c_x", defaultRole: "investor", schema, tryClaude: async () => true });

  it("looks at that schema's tables and policies, never public's, and hands the schema to the connection", async () => {
    expect(await run(SCHEMA)).toEqual({ ok: true });
    const all = JSON.stringify(sent.queries);
    // (The policy check still names the PUBLIC pseudo-role, as it should.)
    expect(all).not.toContain("public.");
    expect(all).not.toContain("schemaname = 'public'");
    expect(sent.queries.filter((q) => q.text.includes(SCHEMA)).length).toBe(3);
    expect(sent.args).toEqual([[SCHEMA]]);
  });

  it("refuses a schema name that is not a plain identifier, before connecting", async () => {
    for (const schema of ["c_1'; --", "C_1", "", "c 1", "pg_catalog"]) {
      expect(await run(schema), schema).toEqual({ ok: false, failure: "address" });
    }
    expect(sent.args).toEqual([]);
  });
});
