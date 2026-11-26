// Bulk import: reading the text of a CSV file into rows, in the browser. Pure functions, no
// database and no Node-only imports. Everything in a file is text: nothing is ever evaluated.
import { headingKey, recognisedColumns } from "./mapping";

export const MAX_ROWS = 5000;
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_COLUMNS = 200;

/** A file Monsoon will not import. The message is written for the person and shown as it is. */
export class ImportFileError extends Error {}

const SEPARATORS = [",", ";", "\t"] as const;
// How much of the file is read three times to choose the separator, and how many of its rows count.
const HEAD_CHARS = 65_536;
const HEAD_ROWS = 30;
const HEADER_SEARCH_ROWS = 10;

function split(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false; // inside a quoted field
  let wasQuoted = false; // the cell being read began with a quote
  const endRow = () => {
    row.push(cell);
    // A line with nothing on it is not a row.
    if (row.length > 1 || cell !== "") rows.push(row);
    row = [];
    cell = "";
    wasQuoted = false;
  };
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === separator) {
      row.push(cell);
      cell = "";
      wasQuoted = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

const filled = (row: string[]): number => row.reduce((count, cell) => (cell.trim() !== "" ? count + 1 : count), 0);

/**
 * The header row's index: the first of the first 10 rows that is a standard export's header, else
 * the first row with at least two filled cells, else the first row with anything in it. -1 when
 * there is none. This is what skips the "Notes:" lines LinkedIn puts above its real header.
 */
export function findHeaderRow(rows: string[][]): number {
  const top = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < top; i++) if (recognisedColumns(rows[i]) !== null) return i;
  const two = rows.findIndex((row) => filled(row) >= 2);
  return two !== -1 ? two : rows.findIndex((row) => filled(row) >= 1);
}

// Comma, semicolon or tab: whichever makes the best header line out of the top of the file.
function chooseSeparator(text: string): string {
  const head = text.slice(0, HEAD_CHARS);
  let best: string = SEPARATORS[0];
  let bestScore = -1;
  for (const separator of SEPARATORS) {
    const rows = split(head, separator).slice(0, HEAD_ROWS);
    const at = findHeaderRow(rows);
    if (at === -1) continue;
    const score = (recognisedColumns(rows[at]) !== null ? 1000 : 0) + filled(rows[at]);
    if (score > bestScore) {
      best = separator;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The rows of a CSV file. Handles quoted fields (commas, line breaks and doubled quotes inside),
 * CRLF, LF and CR line ends, a byte order mark, and files separated by semicolons or tabs. Rows
 * keep the number of cells they have; empty lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body === "") return [];
  return split(body, chooseSeparator(body));
}

export type Table = { headers: string[]; rows: string[][] };

/** The header and the data rows under it (rows with nothing in them dropped). Refuses a file that is empty or too big. */
export function toTable(all: string[][]): Table {
  const at = findHeaderRow(all);
  const headers = at === -1 ? [] : all[at].map((h) => h.trim());
  const rows: string[][] = [];
  for (let i = at + 1; at !== -1 && i < all.length; i++) {
    if (filled(all[i]) === 0) continue;
    if (rows.length >= MAX_ROWS) throw new ImportFileError("This file has more than 5,000 rows.");
    rows.push(all[i]);
  }
  if (rows.length === 0) throw new ImportFileError("This file has no contacts in it.");
  if (headers.length > MAX_COLUMNS) throw new ImportFileError("This file has more than 200 columns.");
  return { headers, rows };
}

/** Refuses a file by its size alone, before any of it is read. */
export function checkSize(bytes: number): void {
  if (bytes > MAX_BYTES) throw new ImportFileError("This file is larger than 10 MB.");
  if (bytes <= 0) throw new ImportFileError("This file is empty.");
}

// Headings only one of the standard exports has, compared after `headingKey`.
const SOURCES: { name: string; any: string[] }[] = [
  { name: "LinkedIn", any: ["connectedon"] },
  { name: "Google", any: ["givenname", "email1value", "organization1name", "organizationname"] },
  { name: "HubSpot", any: ["associatedcompany", "recordid", "lifecyclestage", "contactowner"] },
  { name: "Salesforce", any: ["accountname", "mailingcountry", "leadsource", "leadstatus", "contactid", "accountid"] },
  { name: "Outlook", any: ["businessphone", "businesscountryregion", "email2address", "businessstreet"] },
];
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");
const MAX_SOURCE = 60;

/** Where the file came from, for the import's label: a standard export by name, else the file's own name. */
export function sourceName(headers: string[], fileName: string): string {
  const keys = new Set(headers.map(headingKey));
  const known = SOURCES.find((s) => s.any.some((k) => keys.has(k)));
  if (known) return known.name;
  const base = fileName.replace(/\.[^.]*$/, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SOURCE).trim();
  return base === "" ? "File" : base;
}
