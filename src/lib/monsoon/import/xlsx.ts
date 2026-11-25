// Bulk import: reading the first sheet of an .xlsx workbook into rows of text, in the browser.
// An .xlsx file is a zip of XML files. The zip is opened with fflate, which is loaded only when a
// workbook is actually chosen; the XML is read with the browser's own parser. Cells are only ever
// text: formulas are never run (their last stored value is read) and nothing is evaluated.
import { MAX_ROWS } from "./parse";

// No part of the workbook is unpacked beyond this size, whatever the zip claims to hold.
const MAX_PART_BYTES = 60 * 1024 * 1024;
// Cells further right than this are ignored (the import takes 200 columns at most).
const MAX_COLUMN = 500;
// Reading stops a little past the row limit: enough for the caller to see the file is too long.
const ROW_STOP = MAX_ROWS + 100;

const WORKBOOK = "xl/workbook.xml";
const RELS = "xl/_rels/workbook.xml.rels";
const STRINGS = "xl/sharedStrings.xml";
const STYLES = "xl/styles.xml";
const FIRST_SHEET = "xl/worksheets/sheet1.xml";

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("bad xml");
  return doc;
}

const all = (node: Document | Element, name: string): Element[] => Array.from(node.getElementsByTagNameNS("*", name));

/** The text of a string item or an inline string: its `t` parts joined, phonetic guides left out. */
function richText(item: Element): string {
  let text = "";
  for (const t of all(item, "t")) {
    if (t.parentElement?.localName === "rPh") continue;
    text += t.textContent ?? "";
  }
  return text;
}

// Built-in number formats that show a date or a time.
function builtInDate(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
}

// A custom format is a date when, outside quoted text, brackets and escapes, it has a date letter.
function dateCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dmyhs]/i.test(bare) && !/general/i.test(bare);
}

/** For each cell style, whether it shows a date. */
function dateStyles(styles: Document | null): boolean[] {
  if (!styles) return [];
  const custom = new Map<number, string>();
  for (const f of all(styles, "numFmt")) custom.set(Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? "");
  const xfs = all(styles, "cellXfs")[0];
  if (!xfs) return [];
  return all(xfs, "xf").map((xf) => {
    const id = Number(xf.getAttribute("numFmtId") ?? 0);
    const code = custom.get(id);
    return code !== undefined ? dateCode(code) : builtInDate(id);
  });
}

/** A date serial as YYYY-MM-DD (the time of day is dropped), or null when it is not a usable day. */
function serialDay(serial: number, from1904: boolean): string | null {
  const days = Math.floor(serial) + (from1904 ? 1462 : 0);
  if (!Number.isFinite(days) || days < 1 || days > 2_958_465) return null;
  // Day 25569 is 1 January 1970.
  const d = new Date((days - 25569) * 86_400_000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** "BC12" -> 54 (zero-based column), or -1 when there is no column letter. */
function columnOf(ref: string | null): number {
  if (!ref) return -1;
  let n = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i) & ~32; // upper case
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return i === 0 ? -1 : n - 1;
}

function numberText(value: string): string {
  // A long whole number (a phone number) may be stored as 1.4155550123E10.
  if (/e/i.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : value;
  }
  return value;
}

/**
 * The rows of the workbook's first sheet, every cell as text. Dates come out as YYYY-MM-DD.
 * Throws when the bytes are not a workbook this can read; the caller words that for the person.
 */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const open = (names: string[]): Record<string, Uint8Array> =>
    unzipSync(bytes, {
      filter: (file) => {
        if (!names.includes(file.name)) return false;
        if (file.originalSize > MAX_PART_BYTES) throw new Error("part too large");
        return true;
      },
    });
  const parts = open([WORKBOOK, RELS, STRINGS, STYLES]);
  const part = (from: Record<string, Uint8Array>, name: string): Document | null => (from[name] ? xml(strFromU8(from[name])) : null);

  const workbook = part(parts, WORKBOOK);
  if (!workbook) throw new Error("no workbook");
  const from1904 = all(workbook, "workbookPr").some((p) => ["1", "true"].includes(p.getAttribute("date1904") ?? ""));

  // The first sheet in the workbook's own order, found through the relationships file.
  let path = FIRST_SHEET;
  const first = all(workbook, "sheet")[0];
  const relId = first ? (first.getAttribute("r:id") ?? first.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")) : null;
  const rels = part(parts, RELS);
  const target = relId && rels ? all(rels, "Relationship").find((r) => r.getAttribute("Id") === relId)?.getAttribute("Target") : null;
  if (target) path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;

  const sheet = part(open([path]), path);
  if (!sheet) throw new Error("no sheet");
  const stringsDoc = part(parts, STRINGS);
  const shared = stringsDoc ? all(stringsDoc, "si").map(richText) : [];
  const isDate = dateStyles(part(parts, STYLES));

  const rows: string[][] = [];
  for (const rowNode of all(sheet, "row")) {
    const row: string[] = [];
    let next = 0;
    for (const c of all(rowNode, "c")) {
      const named = columnOf(c.getAttribute("r"));
      const at = named === -1 ? next : named;
      next = at + 1;
      if (at >= MAX_COLUMN) continue;
      const type = c.getAttribute("t") ?? "n";
      const v = all(c, "v")[0]?.textContent ?? "";
      let text: string;
      if (type === "s") text = shared[Number(v)] ?? "";
      else if (type === "inlineStr") text = richText(c);
      else if (type === "b") text = v === "1" ? "TRUE" : "FALSE";
      else if (type === "e") text = "";
      else if (type === "str") text = v;
      else if (type === "d") text = /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v;
      else if (v !== "" && isDate[Number(c.getAttribute("s") ?? 0)] === true) text = serialDay(Number(v), from1904) ?? numberText(v);
      else text = numberText(v);
      while (row.length < at) row.push("");
      row[at] = text;
    }
    if (row.length > 0) rows.push(row);
    if (rows.length >= ROW_STOP) break;
  }
  return rows;
}
