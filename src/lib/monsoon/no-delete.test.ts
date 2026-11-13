import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SCAN = [join(ROOT, "lib", "monsoon"), join(ROOT, "app", "api", "monsoon")];
const TESTING = join(ROOT, "lib", "monsoon", "testing") + sep;

// Every pattern stays inside one statement: the gaps stop at a semicolon or a backtick (the end of
// a template literal), and a SET list stops at WHERE. Aliases, schema prefixes, ONLY, quoted
// identifiers and other columns earlier in the SET list are all allowed for.
const STMT = "[^;`]*?";
const SET_LIST = "(?:(?!\\bWHERE\\b)[^;`])*?";
const TOUCHES = '(?:ONLY\\s+)?(?:"?\\w+"?\\.)?"?touches"?';
const assigns = (column: string) => `[\\s,(]"?${column}"?\\s*=`;

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "DELETE FROM", re: /\bDELETE\s+FROM\b/i },
  { name: "TRUNCATE", re: /\bTRUNCATE\b/i },
  { name: "DROP", re: /\bDROP\s+(?:TABLE|SCHEMA|COLUMN|DATABASE|VIEW)\b/i },
  {
    name: "UPDATE ... SET notes",
    re: new RegExp(`(?:\\bUPDATE\\b${STMT}|\\bDO\\s+UPDATE\\s+)\\bSET\\b${SET_LIST}${assigns("notes")}`, "i"),
  },
  {
    name: "UPDATE touches SET summary",
    re: new RegExp(`\\bUPDATE\\s+${TOUCHES}\\b${STMT}\\bSET\\b${SET_LIST}${assigns("summary")}`, "i"),
  },
  {
    name: "DO UPDATE SET summary",
    re: new RegExp(`\\bDO\\s+UPDATE\\s+SET\\b${SET_LIST}${assigns("summary")}`, "i"),
  },
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
      ["DROP", "drop table members"],
      ["DROP", "DROP SCHEMA public CASCADE"],
      ["DROP", "ALTER TABLE members DROP COLUMN notes"],
      ["DROP", "DROP VIEW v"],
      ["DROP", "DROP DATABASE x"],
      ["UPDATE touches SET summary", "update touches set by_whom = 'VF', summary = $2 where id = $1"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = $1,\n notes = $2 WHERE id = $3"],
      ["UPDATE ... SET notes", "UPDATE people SET notes=$1 WHERE id=$2"],
      // (a) an upsert that overwrites
      [
        "UPDATE ... SET notes",
        "INSERT INTO members (org_id) VALUES ($1) ON CONFLICT (org_id, person_id) DO UPDATE SET notes = EXCLUDED.notes",
      ],
      [
        "DO UPDATE SET summary",
        "INSERT INTO touches (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET by_whom = $2, summary = EXCLUDED.summary",
      ],
      // (b) alias, schema prefix, ONLY, quoted table
      ["UPDATE ... SET notes", "UPDATE members m SET notes = $1 WHERE m.id = $2"],
      ["UPDATE ... SET notes", "UPDATE public.members SET notes = $1"],
      ["UPDATE ... SET notes", 'UPDATE "public"."members" AS m SET "notes" = $1'],
      ["UPDATE touches SET summary", "UPDATE ONLY touches SET summary = $1"],
      ["UPDATE touches SET summary", 'UPDATE "touches" SET summary = $1'],
      ["UPDATE touches SET summary", "UPDATE public.touches t SET summary = $1 WHERE t.id = $2"],
      // (c) a quoted identifier earlier in the SET list
      ["UPDATE ... SET notes", 'UPDATE members SET "stage" = $1, notes = $2'],
      ["UPDATE touches SET summary", 'UPDATE touches SET "by_whom" = $1, "summary" = $2'],
    ];
    for (const [name, sql] of samples) expect(violations(sql), sql).toContain(name);
  });

  it("the matcher passes the statements Ask is allowed to run, and prose", () => {
    for (const sql of [
      "UPDATE members SET stage = $1 WHERE id = $2",
      "UPDATE touches SET by_whom = $1 WHERE id = (SELECT id FROM touches WHERE kind = 'stage' AND summary = $2)",
      "INSERT INTO members (role, stage, notes) VALUES ($1, $2, $3)",
      "INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', 'VF', $2)",
      "UPDATE people SET title = $1, email = $2 WHERE id = $3",
      "// drop it if the draft is stale; delete the draft later",
      "UPDATE members SET stage = $1 WHERE id = $2`;\nconst x = { notes = 1 }",
      "UPDATE members SET stage = $1; SELECT notes = 1",
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
