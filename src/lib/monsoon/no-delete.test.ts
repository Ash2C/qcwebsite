import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_DETAIL_COLUMNS, PERSON_DETAIL_COLUMNS, UPDATE_ORGS, UPDATE_PEOPLE } from "./details";

const ROOT = join(__dirname, "..", "..");
const SCAN = [join(ROOT, "lib", "monsoon"), join(ROOT, "app", "api", "monsoon")];
const TESTING = join(ROOT, "lib", "monsoon", "testing") + sep;

// Each file is scanned twice, as raw text and with comments blanked, and is flagged if either pass
// matches: blanking hides a comment that splits a statement; the raw pass hides nothing, so a `--`
// or `/*` inside a string or an operator (`i--;`) cannot swallow what follows.
// The notes / summary rules look at one statement at a time: from UPDATE ... SET (or DO UPDATE SET)
// to the next semicolon, backtick or the end of the text. Parentheses are not balanced and strings
// are not parsed, so nothing nested or quoted can end the SET list early. Inside that statement any
// `notes` (quoted or not, with an optional table or alias prefix, or in the row form
// SET (a, notes) = ...) followed by `=` is an assignment, wherever it sits, even past a WHERE. The
// one exception is a comparison: the word in front of it is WHERE, AND, OR, NOT, ON, HAVING, WHEN,
// THEN or ELSE (or it is the first thing inside a comment). Anything else in front (SET, a comma, a
// closing parenthesis, a quote) is flagged, so the check fails loud rather than guessing.
const COMPARISON_LEAD = /\b(?:WHERE|AND|OR|NOT|ON|HAVING|WHEN|THEN|ELSE)$/i;
const NAME = '(?:"?\\w+"?\\s*\\.\\s*)?"?\\w+"?';

/** True when what comes before a match makes it a comparison (or the start of a comment's text). */
function isComparison(before: string): boolean {
  const lead = before.trimEnd();
  return COMPARISON_LEAD.test(lead) || lead.endsWith("/*") || lead.endsWith("--");
}

function assignsColumn(text: string, start: RegExp, column: string): boolean {
  const plain = new RegExp(`(?<![\\w$"])(?:"?\\w+"?\\s*\\.\\s*)*"?${column}"?\\s*=(?!=)`, "gi");
  const row = new RegExp(
    `\\(\\s*(?:${NAME}\\s*,\\s*)*"?${column}"?\\s*(?:,\\s*${NAME}\\s*)*\\)\\s*=(?!=)`,
    "gi",
  );
  for (const s of text.matchAll(new RegExp(start.source, "gi"))) {
    const tail = text.slice(s.index + s[0].length).split(/[;`]/, 1)[0];
    for (const re of [plain, row]) {
      for (const m of tail.matchAll(re)) {
        if (!isComparison("SET " + tail.slice(0, m.index))) return true;
      }
    }
  }
  return false;
}

const UPDATE_SET = /\bUPDATE\b[^;`]*?\bSET\b/;
const UPDATE_TOUCHES_SET = /\bUPDATE\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?touches"?\b[^;`]*?\bSET\b/;
const DO_UPDATE_SET = /\bDO\s+UPDATE\s+SET\b/;

const FORBIDDEN: { name: string; hit: (text: string) => boolean }[] = [
  { name: "DELETE FROM", hit: (t) => /\bDELETE\s+FROM\b/i.test(t) },
  { name: "TRUNCATE", hit: (t) => /\bTRUNCATE\b/i.test(t) },
  {
    name: "DROP",
    hit: (t) => /\bDROP\s+(?:TABLE|SCHEMA|COLUMN|DATABASE|VIEW|MATERIALIZED\s+VIEW)\b/i.test(t),
  },
  { name: "ALTER COLUMN", hit: (t) => /\bALTER\s+COLUMN\b/i.test(t) },
  { name: "MERGE", hit: (t) => /\bMERGE\s+INTO\b/i.test(t) },
  { name: "UPDATE ... SET notes", hit: (t) => assignsColumn(t, UPDATE_SET, "notes") },
  { name: "UPDATE touches SET summary", hit: (t) => assignsColumn(t, UPDATE_TOUCHES_SET, "summary") },
  { name: "DO UPDATE SET summary", hit: (t) => assignsColumn(t, DO_UPDATE_SET, "summary") },
];

/** SQL and JS comments replaced by a space, so they cannot split a statement. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

// The matcher of commit 5be6ae2, copied unchanged (only the constant names are prefixed). It runs as
// a third, independent check on the comment-blanked text, so the current matcher can only add to
// what it flags. Where it flags a comparison it is a deliberate false positive (fail loud).
const LEGACY_STMT = "[^;`]*?";
const LEGACY_PLAIN = "[^;`()]";
const LEGACY_GROUP1 = `\\(${LEGACY_PLAIN}*\\)`;
const LEGACY_GROUP2 = `\\((?:${LEGACY_PLAIN}|${LEGACY_GROUP1})*\\)`;
const LEGACY_GROUP3 = `\\((?:${LEGACY_PLAIN}|${LEGACY_GROUP2})*\\)`;
const LEGACY_SET_LIST = `(?:(?!\\bWHERE\\b)${LEGACY_PLAIN}|${LEGACY_GROUP3})*?`;
const LEGACY_TOUCHES = '(?:ONLY\\s+)?(?:"?\\w+"?\\.)?"?touches"?';
const LEGACY_NAME = '"?\\w+"?';
const LEGACY_assigns = (column: string) =>
  `(?:[\\s,(]"?${column}"?\\s*=|[\\s,]\\(\\s*(?:${LEGACY_NAME}\\s*,\\s*)*"?${column}"?\\s*(?:,\\s*${LEGACY_NAME}\\s*)*\\)\\s*=)`;

const LEGACY_RULES: { name: string; re: RegExp }[] = [
  { name: "DELETE FROM", re: /\bDELETE\s+FROM\b/i },
  { name: "TRUNCATE", re: /\bTRUNCATE\b/i },
  { name: "DROP", re: /\bDROP\s+(?:TABLE|SCHEMA|COLUMN|DATABASE|VIEW|MATERIALIZED\s+VIEW)\b/i },
  { name: "ALTER COLUMN", re: /\bALTER\s+COLUMN\b/i },
  { name: "MERGE", re: /\bMERGE\s+INTO\b/i },
  {
    name: "UPDATE ... SET notes",
    re: new RegExp(`(?:\\bUPDATE\\b${LEGACY_STMT}|\\bDO\\s+UPDATE\\s+)\\bSET\\b${LEGACY_SET_LIST}${LEGACY_assigns("notes")}`, "i"),
  },
  {
    name: "UPDATE touches SET summary",
    re: new RegExp(`\\bUPDATE\\s+${LEGACY_TOUCHES}\\b${LEGACY_STMT}\\bSET\\b${LEGACY_SET_LIST}${LEGACY_assigns("summary")}`, "i"),
  },
  {
    name: "DO UPDATE SET summary",
    re: new RegExp(`\\bDO\\s+UPDATE\\s+SET\\b${LEGACY_SET_LIST}${LEGACY_assigns("summary")}`, "i"),
  },
];

// The one permitted delete: pruning old sign-in attempts. Allowed by file AND exact statement; any other
// DELETE, in this file or anywhere else, is still flagged.
const PRUNE_FILE = "lib/monsoon/accounts/store.ts";
const PRUNE_STATEMENT = "DELETE FROM sign_in_attempts WHERE at < now() - interval '30 days'";

// Only the statement as a complete string literal (same quote character on both sides) is exempt.
const PRUNE_LITERALS = ["\"", "`"].map((q) => q + PRUNE_STATEMENT + q);

// The setup check's probe: a delete that matches nothing, inside a transaction that is always rolled
// back, run to prove the restricted login is refused (42501). Also the privilege name 'TRUNCATE' as a
// SQL string literal passed to has_table_privilege. Allowed by file AND exact literal only.
const PROBE_FILE = "lib/monsoon/accounts/setup-check.ts";
const PROBE_LITERALS = ['"DELETE FROM touches WHERE false"', "'TRUNCATE'"];

function violations(source: string, file?: string): string[] {
  if (file === PRUNE_FILE) for (const lit of PRUNE_LITERALS) source = source.split(lit).join(" ");
  if (file === PROBE_FILE) for (const lit of PROBE_LITERALS) source = source.split(lit).join(" ");
  // raw and comments blanked, and each again with escaped quotes (a \" inside a TypeScript
  // string) turned into plain ones, so an escaped quoted identifier is seen as one.
  const texts = [source, withoutComments(source)];
  texts.push(...texts.map((t) => t.replace(/\\"/g, '"')));
  const legacy = LEGACY_RULES.filter((f) => f.re.test(withoutComments(source))).map((f) => f.name);
  return [...new Set([...FORBIDDEN.filter((f) => texts.some((t) => f.hit(t))).map((f) => f.name), ...legacy])];
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
  // Strictly wider than every earlier version: this list is the union of the samples the three
  // earlier matchers (2c2c0e1, 8e0cfa0, 5be6ae2) flagged, plus the residual-fix additions. Never
  // remove an entry; the allowed list below must stay unflagged and the real files must pass.
  it("the matcher flags each forbidden statement", () => {
    const samples: [string, string][] = [
      ["DELETE FROM", "delete  from touches WHERE id = $1"],
      ["DELETE FROM", "DELETE FROM customers WHERE id = $1"],
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
      // (h) nesting depth, parentheses in strings, and `--` in code (residual fixes)
      ["UPDATE ... SET notes", "UPDATE members SET stage = coalesce(lower(trim(upper(x)))), notes = $1"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = ':)', notes = $1"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = '(', notes = $1"],
      ["DELETE FROM", 'i--; await db.query("DELETE FROM touches")'],
      ["TRUNCATE", 'x = "--force"; await db.query("TRUNCATE members")'],
      // (i) past a WHERE, quoted, prefixed, a quoted `--` hiding the rest of the line
      ["UPDATE ... SET notes", "UPDATE members SET stage = $1 WHERE id = $2, notes = $3"],
      ["UPDATE ... SET notes", "UPDATE members m SET stage = $1, m.notes = $2"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = '--', notes = $1"],
      ["UPDATE touches SET summary", "UPDATE touches SET by_whom = ')))))', summary = $1"],
      // (j) keywords or comment starts inside a comment or string must not hide the write
      ["UPDATE ... SET notes", "UPDATE members SET stage = 'and--', --and\nnotes = $1"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = '/*', by_whom = $1, -- */ and\n notes = $2"],
      // (k) an escaped quoted identifier inside a double-quoted TypeScript string
      ["UPDATE ... SET notes", String.raw`UPDATE members SET \"notes\" = $1`],
      ["UPDATE touches SET summary", String.raw`UPDATE touches SET \"summary\" = $1`],
      // (l) comparisons the legacy matcher flags: deliberate false positives (fail loud)
      ["UPDATE ... SET notes", "UPDATE members SET stage = $1 AND notes = $2"],
      ["UPDATE ... SET notes", "UPDATE members SET stage = CASE WHEN x THEN 1 ELSE notes = 'a' END"],
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
      "UPDATE members m SET stage = $1 WHERE m.notes = $2 AND m.id = $3",
      "UPDATE touches t SET by_whom = $1 FROM x WHERE t.summary = x.s OR t.id = $2",
    ]) {
      expect(violations(sql), sql).toEqual([]);
    }
  });

  it("allows only the sign-in attempts prune, and only in accounts/store.ts", () => {
    const prune = `await db.query("${PRUNE_STATEMENT}");`;
    expect(violations(prune, PRUNE_FILE)).toEqual([]);
    expect(violations(prune, "lib/monsoon/capture.ts")).toContain("DELETE FROM");
    expect(violations(prune)).toContain("DELETE FROM");
    expect(violations(`await db.query("${PRUNE_STATEMENT} OR true");`, PRUNE_FILE)).toContain("DELETE FROM");
    expect(violations(`// ${PRUNE_STATEMENT}`, PRUNE_FILE)).toContain("DELETE FROM");
    expect(violations(prune + ' await db.query("DELETE FROM customers");', PRUNE_FILE)).toContain("DELETE FROM");
    expect(violations('await db.query("DELETE FROM sign_in_attempts");', PRUNE_FILE)).toContain("DELETE FROM");
    expect(violations("DELETE FROM customers WHERE id = $1", "lib/monsoon/accounts/admin.ts")).toContain("DELETE FROM");
  });

  it("allows only the setup probe and the TRUNCATE privilege name, and only in accounts/setup-check.ts", () => {
    const probe = 'await db.query("DELETE FROM touches WHERE false");';
    const priv = "has_table_privilege($1, t, 'TRUNCATE')";
    expect(violations(probe, PROBE_FILE)).toEqual([]);
    expect(violations(priv, PROBE_FILE)).toEqual([]);
    expect(violations(probe, "lib/monsoon/capture.ts")).toContain("DELETE FROM");
    expect(violations(priv, "lib/monsoon/capture.ts")).toContain("TRUNCATE");
    expect(violations('await db.query("DELETE FROM touches WHERE true");', PROBE_FILE)).toContain("DELETE FROM");
    expect(violations('await db.query("DELETE FROM touches WHERE false OR true");', PROBE_FILE)).toContain("DELETE FROM");
    expect(violations('await db.query("TRUNCATE touches");', PROBE_FILE)).toContain("TRUNCATE");
    expect(violations(probe, PRUNE_FILE)).toContain("DELETE FROM");
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

  it("details.ts never updates notes: its lists of updatable columns have no notes or summary", () => {
    const source = readFileSync(join(ROOT, "lib", "monsoon", "details.ts"), "utf8");
    for (const name of ["PERSON_DETAIL_COLUMNS", "ORG_DETAIL_COLUMNS"]) {
      const list = new RegExp(`\\b${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
      expect(list, `${name} not found in details.ts`).not.toBeNull();
      const columns = [...list![1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
      expect(columns.length).toBeGreaterThan(0);
      expect(columns).not.toContain("notes");
      expect(columns).not.toContain("summary");
    }
  });

  it("the UPDATE statements generated in details.ts assign exactly the listed columns and nothing else", () => {
    // Statement shape: UPDATE <table> SET <col> = CASE WHEN $n::boolean THEN $m::<type> ELSE <col> END, ... WHERE id = $1
    const assigned = (sql: string, table: string): string[] => {
      const m = new RegExp(`^UPDATE ${table} SET (.+) WHERE id = [$]1$`).exec(sql);
      expect(m, `${table} statement has an unexpected shape`).not.toBeNull();
      const list = m![1];
      const items = [...list.matchAll(/(\w+) = CASE WHEN \$\d+::boolean THEN \$\d+::\w+ ELSE (\w+) END/g)];
      for (const i of items) expect(i[2]).toBe(i[1]); // each column falls back to its own value
      // Nothing between or around the matched assignments: the list is made of them alone.
      expect(items.map((i) => i[0]).join(", ")).toBe(list);
      return items.map((i) => i[1]);
    };
    expect(assigned(UPDATE_PEOPLE, "people")).toEqual([...PERSON_DETAIL_COLUMNS]);
    expect(assigned(UPDATE_ORGS, "orgs")).toEqual([...ORG_DETAIL_COLUMNS]);
    // The lists themselves: the editable columns, plus name_key and org_id for people.
    expect([...PERSON_DETAIL_COLUMNS].sort()).toEqual(
      ["country", "email", "linkedin_url", "name", "name_key", "org_id", "phone", "title"],
    );
    expect([...ORG_DETAIL_COLUMNS].sort()).toEqual(["country", "website"]);
  });

  it("research-apply.ts writes through applyRowChanges and has no UPDATE of its own", () => {
    const source = readFileSync(join(ROOT, "lib", "monsoon", "research-apply.ts"), "utf8");
    const code = withoutComments(source).replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(source).toContain("applyRowChanges");
    expect(SCAN.flatMap(files).map((f) => relative(ROOT, f).split(sep).join("/"))).toContain("lib/monsoon/research-apply.ts");
  });

  it("no Monsoon server code deletes, truncates, drops or rewrites notes", () => {
    const bad: string[] = [];
    for (const file of SCAN.flatMap(files)) {
      const hits = violations(readFileSync(file, "utf8"), relative(ROOT, file).split(sep).join("/"));
      if (hits.length) bad.push(`${relative(ROOT, file)}: ${hits.join(", ")}`);
    }
    expect(bad).toEqual([]);
  });
});
