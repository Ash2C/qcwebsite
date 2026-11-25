// Bulk import: which column of a file holds which Monsoon field, and turning one row into a
// contact. No database and no Node-only imports here: the browser uses this file too.

export const FIELDS = [
  "firstName",
  "lastName",
  "fullName",
  "company",
  "title",
  "email",
  "phone",
  "linkedin",
  "country",
  "notes",
  "connectedOn",
] as const;
export type Field = (typeof FIELDS)[number];

/** Field -> index of the column that holds it. */
export type Mapping = Partial<Record<Field, number>>;

/** One row of a file as Monsoon understands it. Text is trimmed and capped; `connectedOn` is YYYY-MM-DD. */
export type ImportContact = {
  name: string;
  org?: string;
  title?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  country?: string;
  notes?: string;
  connectedOn?: string;
};

// The lengths the normal save accepts (save/route.ts): 300 for a one-line field, 2000 for notes.
export const MAX_FIELD = 300;
export const MAX_NOTES = 2000;

// Headings of the standard exports, compared after `headingKey`. The first listed that the file
// has wins. LinkedIn connections, Salesforce contacts and leads, HubSpot contacts, Google Contacts
// and Outlook. A notes column is never picked here: the user chooses it.
const KNOWN: Partial<Record<Field, string[]>> = {
  firstName: ["firstname", "givenname"],
  lastName: ["lastname", "familyname"],
  fullName: ["name", "fullname"],
  company: ["company", "accountname", "companyname", "associatedcompany", "organizationname", "organization1name"],
  title: ["title", "position", "jobtitle", "organizationtitle", "organization1title"],
  email: ["emailaddress", "email", "email1value"],
  phone: ["phone", "phonenumber", "phone1value", "mobile", "mobilephone", "businessphone"],
  linkedin: ["url", "linkedinurl", "linkedin", "linkedinprofile"],
  country: ["mailingcountry", "country", "countryregion", "businesscountryregion"],
  connectedOn: ["connectedon"],
};

const NAME_FIELDS: Field[] = ["fullName", "firstName", "lastName"];

/** A heading reduced to its letters and digits, lower case ("E-mail 1 - Value" -> "email1value"). */
function headingKey(heading: unknown): string {
  return typeof heading === "string" ? heading.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
}

/** The mapping for a standard export, or null when no name column is recognised. Never uses AI. */
export function knownMapping(headers: string[]): Mapping | null {
  const at = new Map<string, number>();
  (Array.isArray(headers) ? headers : []).forEach((h, i) => {
    const key = headingKey(h);
    if (key !== "" && !at.has(key)) at.set(key, i);
  });
  const mapping: Mapping = {};
  for (const field of FIELDS) {
    const found = (KNOWN[field] ?? []).find((alias) => at.has(alias));
    if (found !== undefined) mapping[field] = at.get(found) as number;
  }
  return NAME_FIELDS.some((f) => mapping[f] !== undefined) ? mapping : null;
}

/**
 * A mapping from anywhere (the user's choices, Claude's reply) checked: only known fields, each
 * with one whole-number column index inside the file, and a name column. A field given as null is
 * left out. Answers a clean copy, or null when anything is wrong.
 */
export function validateMapping(mapping: unknown, headerCount: number): Mapping | null {
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) return null;
  const out: Mapping = {};
  for (const key of Object.getOwnPropertyNames(mapping)) {
    if (!(FIELDS as readonly string[]).includes(key)) return null;
    const index = (mapping as Record<string, unknown>)[key];
    if (index === null || index === undefined) continue;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= headerCount) return null;
    out[key as Field] = index;
  }
  return NAME_FIELDS.some((f) => out[f] !== undefined) ? out : null;
}

// --- one row ---------------------------------------------------------------------------------------

// Control characters are built from their code points so this file holds none.
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");
const CONTROL_BUT_BREAKS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

/** One line of text: control characters and line breaks become spaces, runs of spaces one. */
function line(value: unknown): string {
  return typeof value === "string" ? value.replace(CONTROL, " ").replace(/\s+/g, " ").trim() : "";
}

function capped(value: unknown): string | undefined {
  const text = line(value).slice(0, MAX_FIELD).trim();
  return text === "" ? undefined : text;
}

function notesText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n?/g, "\n").replace(CONTROL_BUT_BREAKS, "").trim().slice(0, MAX_NOTES).trim();
  return text === "" ? undefined : text;
}

function emailText(value: unknown): string | undefined {
  const text = line(value);
  // Too long is dropped, not cut: a shortened address would be someone else's.
  return text.includes("@") && text.length <= MAX_FIELD ? text : undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function day(year: number, month: number, dayOfMonth: number): string | undefined {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || dayOfMonth < 1) return undefined;
  const d = new Date(Date.UTC(year, month - 1, dayOfMonth));
  // A day the month does not have rolls over: refuse it.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== dayOfMonth) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
}

function monthNumber(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
}

/** A date cell as YYYY-MM-DD, or undefined when it is not a date this reads. */
function dateText(value: unknown, dayFirst: boolean): string | undefined {
  const text = line(value);
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/))) return day(+m[1], +m[2], +m[3]);
  if ((m = text.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4})$/))) return day(+m[3], monthNumber(m[2]), +m[1]);
  if ((m = text.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/))) return day(+m[3], monthNumber(m[1]), +m[2]);
  if ((m = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/))) {
    return dayFirst ? day(+m[3], +m[2], +m[1]) : day(+m[3], +m[1], +m[2]);
  }
  return undefined;
}

type Raw = { [K in keyof ImportContact]?: unknown };

function build(raw: Raw, dayFirst: boolean, strictDate: boolean): ImportContact | null {
  const name = capped(raw.name);
  if (name === undefined) return null;
  const contact: ImportContact = { name };
  const put = <K extends keyof ImportContact>(key: K, value: ImportContact[K] | undefined) => {
    if (value !== undefined) contact[key] = value;
  };
  put("org", capped(raw.org));
  put("title", capped(raw.title));
  put("email", emailText(raw.email));
  put("phone", capped(raw.phone));
  put("linkedin", capped(raw.linkedin));
  put("country", capped(raw.country));
  put("notes", notesText(raw.notes));
  const on = line(raw.connectedOn);
  put("connectedOn", strictDate && !/^\d{4}-\d{2}-\d{2}$/.test(on) ? undefined : dateText(on, dayFirst));
  return contact;
}

/**
 * One row of the file as a contact, or null when it has no name. `dayFirst` reads 3/12/2021 as
 * 3 December (the default is 12 March, as LinkedIn and Salesforce write it in the US).
 */
export function rowToContact(cells: string[], mapping: Mapping, opts: { dayFirst?: boolean } = {}): ImportContact | null {
  const cell = (field: Field): unknown => {
    const index = mapping[field];
    return index === undefined ? undefined : cells[index];
  };
  const full = line(cell("fullName"));
  const name = full !== "" ? full : `${line(cell("firstName"))} ${line(cell("lastName"))}`;
  return build(
    {
      name,
      org: cell("company"),
      title: cell("title"),
      email: cell("email"),
      phone: cell("phone"),
      linkedin: cell("linkedin"),
      country: cell("country"),
      notes: cell("notes"),
      connectedOn: cell("connectedOn"),
    },
    opts.dayFirst === true,
    false,
  );
}

/**
 * A contact as it arrives at the server, cleaned again: the server never trusts that the browser
 * ran rowToContact. Unknown keys are dropped; `connectedOn` must already be YYYY-MM-DD. Null when
 * it is not an object or has no name.
 */
export function cleanContact(value: unknown): ImportContact | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return build(value as Raw, false, true);
}
