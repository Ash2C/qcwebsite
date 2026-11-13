import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SCAN = [join(ROOT, "lib", "monsoon"), join(ROOT, "app", "api", "monsoon")];
const TESTING = join(ROOT, "lib", "monsoon", "testing") + sep;

// Every pattern stays inside one statement: the gaps stop at a semicolon or a backtick (the end of
// a template literal), and a SET list stops at a top-level WHERE. A WHERE inside parentheses (a
// subquery in the SET list) does not end it, so a column assigned after a subquery is still seen;
// parentheses nest to three levels. Comments are blanked first, so one between SET and the column
// (or one holding a semicolon or WHERE) hides nothing. Aliases, schema prefixes, ONLY, quoted
// identifiers, other columns earlier in the SET list and the row form SET (a, b) = (...) are all
// allowed for.
const STMT = "[^;`]*?";
const PLAIN = "[^;`()]";
const GROUP1 = `\\(${PLAIN}*\\)`;
const GROUP2 = `\\((?:${PLAIN}|${GROUP1})*\\)`;
const GROUP3 = `\\((?:${PLAIN}|${GROUP2})*\\)`;
const SET_LIST = `(?:(?!\\bWHERE\\b)${PLAIN}|${GROUP3})*?`;
const TOUCHES = '(?:ONLY\\s+)?(?:"?\\w+"?\\.)?"?touches"?';
const NAME = '"?\\w+"?';
const assigns = (column: string) =>
  `(?:[\\s,(]"?${column}"?\\s*=|[\\s,]\\(\\s*(?:${NAME}\\s*,\\s*)*"?${column}"?\\s*(?:,\\s*${NAME}\\s*)*\\)\\s*=)`;

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "DELETE FROM", re: /\bDELETE\s+FROM\b/i },
  { name: "TRUNCATE", re: /\bTRUNCATE\b/i },
  { name: "DROP", re: /\bDROP\s+(?:TABLE|SCHEMA|COLUMN|DATABASE|VIEW|MATERIALIZED\s+VIEW)\b/i },
  { name: "ALTER COLUMN", re: /\bALTER\s+COLUMN\b/i },
  { name: "MERGE", re: /\bMERGE\s+INTO\b/i },
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

/** SQL and JS comments replaced by a space, so they cannot split or hide a statement. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function violations(source: string): string[] {
  const text = withoutComments(source);
  return FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.name);
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
      // (d) assigned after a subquery inside the SET list
      ["UPDATE ... SET notes", "UPDATE members SET stage = (SELECT key FROM stages WHERE ord = 1), notes = $1 WHERE id = $2"],
      [
        "UPDATE touches SET summary",
        "UPDATE touches SET by_whom = (SELECT key FROM owners WHERE key = $1), summary = $2 WHERE id = $3",
      ],
      [
        "UPDATE ... SET notes",
        "UPDATE members SET stage = (SELECT s.key FROM (SELECT key FROM stages WHERE ord = 1) s), notes = $1",
      ],
      // (e) the row form
      ["UPDATE ... SET notes", "UPDATE members SET (stage, notes) = ($1, $2) WHERE id = $3"],
      ["UPDATE ... SET notes", 'UPDATE people SET ("title", "notes", email) = ($1, $2, $3) WHERE id = $4'],
      ["UPDATE ... SET notes", "UPDATE members SET (notes) = ROW($1)"],
      ["UPDATE touches SET summary", "UPDATE touches SET (by_whom, summary) = ($1, $2) WHERE id = $3"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = $1, (priority, notes) = ($2, $3)"],
      // (f) a comment between SET and the column
      ["UPDATE ... SET notes", "UPDATE members SET /* keep it */ notes = $1"],
      ["UPDATE ... SET notes", "UPDATE members SET/**/notes = $1"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = $1, -- why\n notes = $2"],
      ["UPDATE ... SET notes", "UPDATE members SET /* WHERE; */ notes = $1"],
      ["UPDATE touches SET summary", "UPDATE touches SET /* c */ summary = $1"],
      // (g) other statements that rewrite or remove
      ["MERGE", "MERGE INTO members m USING x ON m.id = x.id WHEN MATCHED THEN DELETE"],
      ["MERGE", "merge  into members m USING x ON m.id = x.id WHEN MATCHED THEN UPDATE SET notes = x.notes"],
      ["DROP", "DROP MATERIALIZED VIEW mv"],
      ["DROP", "drop materialized  view if exists mv"],
      ["ALTER COLUMN", "ALTER TABLE members ALTER COLUMN notes TYPE varchar(5)"],
      ["ALTER COLUMN", "alter table touches alter  column summary set not null"],
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
      "UPDATE members SET stage = (SELECT key FROM stages WHERE ord = 1) WHERE id = $2",
      "UPDATE members SET stage = (SELECT key FROM stages WHERE notes = $1) WHERE id = $2",
      "UPDATE members SET stage = $1 WHERE notes = $2",
      "UPDATE members SET stage = $1 /* notes = 1 */ WHERE id = $2",
      "UPDATE members SET stage = $1 -- notes = 1\n WHERE id = $2",
      "UPDATE people SET (title, email) = ($1, $2) WHERE id = $3",
      "UPDATE touches SET by_whom = (SELECT key FROM owners WHERE key = $1) WHERE id = $2",
      "SELECT 1 FROM touches WHERE summary = $1 AND at > now() - interval '2 minutes'",
      "ALTER TABLE members ADD COLUMN extra text",
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

  it("capture.ts never updates notes: its list of updatable person columns has no notes", () => {
    const source = readFileSync(join(ROOT, "lib", "monsoon", "capture.ts"), "utf8");
    const list = /\bPERSON_COLUMNS\b[^=]*=\s*\[([^\]]*)\]/.exec(source);
    expect(list, "PERSON_COLUMNS not found in capture.ts").not.toBeNull();
    const columns = [...list![1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns).not.toContain("notes");
    expect(columns).not.toContain("summary");
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
