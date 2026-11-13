import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SCAN = [join(ROOT, "lib", "monsoon"), join(ROOT, "app", "api", "monsoon")];
const TESTING = join(ROOT, "lib", "monsoon", "testing") + sep;

// The gap pattern stops at a semicolon or a quote/backtick so a match stays inside one statement.
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "DELETE FROM", re: /\bDELETE\s+FROM\b/i },
  { name: "TRUNCATE", re: /\bTRUNCATE\b/i },
  { name: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { name: "DROP SCHEMA", re: /\bDROP\s+SCHEMA\b/i },
  { name: "UPDATE touches SET summary", re: /\bUPDATE\s+touches\s+SET\b[^;`"]*?\bsummary\s*=/i },
  { name: "UPDATE ... SET notes", re: /\bUPDATE\s+\w+\s+SET\b[^;`"]*?\bnotes\s*=/i },
];

function violations(source: string): string[] {
  return FORBIDDEN.filter((f) => f.re.test(source)).map((f) => f.name);
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !full.startsWith(TESTING)) out.push(full);
  }
  return out;
}

describe("never delete", () => {
  it("the matcher flags each forbidden statement", () => {
    const samples: [string, string][] = [
      ["DELETE FROM", "delete  from touches WHERE id = $1"],
      ["TRUNCATE", "TRUNCATE touches"],
      ["DROP TABLE", "drop table members"],
      ["DROP SCHEMA", "DROP SCHEMA public CASCADE"],
      ["UPDATE touches SET summary", "update touches set by_whom = 'VF', summary = $2 where id = $1"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = $1,\n notes = $2 WHERE id = $3"],
      ["UPDATE ... SET notes", "UPDATE people SET notes=$1 WHERE id=$2"],
    ];
    for (const [name, sql] of samples) expect(violations(sql), sql).toContain(name);
  });

  it("the matcher passes the statements Ask is allowed to run", () => {
    for (const sql of [
      "INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', 'VF', $2)",
      "UPDATE members SET stage = $1 WHERE id = $2",
      "UPDATE touches SET by_whom = $1 WHERE id = (SELECT id FROM touches WHERE kind = 'stage')",
      "INSERT INTO members (org_id, person_id, role, stage, notes, source) VALUES ($1, $2, $3, $4, $5, $6)",
    ]) {
      expect(violations(sql), sql).toEqual([]);
    }
  });

  it("finds the Monsoon server files to scan", () => {
    const found = SCAN.flatMap(files).map((f) => relative(ROOT, f).split(sep).join("/"));
    expect(found).toContain("lib/monsoon/capture.ts");
    expect(found).toContain("app/api/monsoon/save/route.ts");
    expect(found.some((f) => f.includes("/testing/"))).toBe(false);
    expect(found.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });

  it("no Monsoon server code deletes, truncates, drops or rewrites notes", () => {
    const bad: string[] = [];
    for (const file of SCAN.flatMap(files)) {
      const hits = violations(readFileSync(file, "utf8"));
      if (hits.length) bad.push(`${relative(ROOT, file)}: ${hits.join(", ")}`);
    }
    expect(bad).toEqual([]);
  });
});
