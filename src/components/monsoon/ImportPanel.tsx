"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RowClass } from "@/lib/monsoon/import/classify";
import { UNREADABLE, readImportFile } from "@/lib/monsoon/import/file";
import { CHECK_MAX_BODY, SAVE_MAX_BODY, bySize, jsonBytes, requestBudget } from "@/lib/monsoon/import/limits";
import { knownMapping, recognisedColumns, rowToContact, validateMapping, type Field, type ImportContact, type Mapping } from "@/lib/monsoon/import/mapping";
import { ImportFileError, MAX_COLUMNS, sourceName } from "@/lib/monsoon/import/parse";
import { fileRepeats } from "@/lib/monsoon/import/repeats";
import type { SaveOutcome } from "@/lib/monsoon/import/save";
import { checkImportRows, finishImport, mapImportColumns, saveImportRows, type EstateInfo } from "./api";
import MonsoonLoader from "./MonsoonLoader";
import { card, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";

/**
 * One import, from the chosen file to its result. It lives in MonsoonApp, not here, so it survives
 * the passcode screen: after signing in again the import is where it was. The file's rows and the
 * contacts made from them are held once and never put on the page as a whole.
 */
export type ImportJob = {
  step: "file" | "columns" | "summary" | "progress" | "result";
  /** Made when the file is chosen; with a row's number it names that row for good, so a row sent twice is saved once. */
  importId: string;
  fileName: string;
  headers: string[];
  /** The file's data rows. A row's number is its place in this list and never changes. */
  rows: string[][];
  mapping: Mapping;
  /** Where the mapping came from; `loading` while the server is being asked. */
  mapSource: "loading" | "known" | "claude" | "none";
  /** One per row, made when the columns are confirmed; null for a row with no name. */
  contacts: (ImportContact | null)[];
  /** One per row once the check has answered for all of them. */
  classes: RowClass[] | null;
  role: string;
  label: string;
  includePossible: boolean;
  /** The row numbers of the run in hand: every readable row, or the failed ones on "Try those again". */
  queue: number[];
  /** What the server said happened to each row sent, by row number. */
  outcomes: Record<number, SaveOutcome>;
  /** True once a save request has been answered: the next ones no longer carry `first`. */
  firstDone: boolean;
  /** Rows too large to send even alone: marked failed, said so, and never sent again. */
  tooLarge: number[];
};

export const NEW_IMPORT_JOB: ImportJob = {
  step: "file",
  importId: "",
  fileName: "",
  headers: [],
  rows: [],
  mapping: {},
  mapSource: "none",
  contacts: [],
  classes: null,
  role: "",
  label: "",
  includePossible: false,
  queue: [],
  outcomes: {},
  firstDone: false,
  tooLarge: [],
};

export type ImportJobChange = (next: ImportJob | null | ((prev: ImportJob) => ImportJob)) => void;

const CHECK_CHUNK = 200;
const SAVE_CHUNK = 50;
const SAVE_TRIES = 3;
const CLOSE_TRIES = 2;
const RETRY_WAIT_MS = 2000;
const LIST_MAX = 200;
const MAX_LABEL = 80;
const SAMPLE_ROWS = 5;
const SAMPLE_CHARS = 80;

const CHECK_FAILURE = "Could not check the file. Check signal and try again.";
const CHECK_TOO_LARGE = "Could not check the file. A row in it is too large.";
const ROW_TOO_LARGE = "This row is too large.";
const STOP = "Stop the import? Contacts already saved stay.";
const NO_UNDO = "This cannot be undone: Monsoon never deletes contacts.";

const FIELD_ROWS: { key: Field; label: string }[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "fullName", label: "Full name" },
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "country", label: "Country" },
  { key: "notes", label: "Notes" },
  { key: "connectedOn", label: "Connected on" },
];
const MAP_LINES: Record<ImportJob["mapSource"], string> = {
  loading: "Working out the columns…",
  known: "Monsoon knows this kind of file. Check the columns.",
  claude: "Monsoon worked these out. Check them.",
  none: "Choose which column is which.",
};
const GROUPS: { key: RowClass; title: string }[] = [
  { key: "new", title: "New" },
  { key: "existing", title: "Already in Monsoon" },
  { key: "possible", title: "Possible matches" },
  { key: "repeat", title: "Repeated in the file" },
  { key: "unreadable", title: "Cannot be read" },
];
const CLASSES: readonly unknown[] = GROUPS.map((g) => g.key);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const sectionTitle = "px-1 text-[13px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300";
const quiet = "px-1 text-[14px] leading-snug text-neutral-600 dark:text-neutral-400";
const plain = "px-1 text-[16px] leading-snug text-neutral-900 dark:text-white";
const bad = "px-1 text-[15px] font-medium text-red-600 dark:text-red-400";
const rowsCard = `${card} divide-y divide-neutral-200 overflow-hidden dark:divide-white/10`;
const scrollList = "max-h-64 overflow-y-auto border-t border-neutral-200 px-4 py-2 text-[15px] leading-relaxed dark:border-white/10";

const count = (n: number): string => n.toLocaleString("en-US");
const contactsWord = (n: number): string => (n === 1 ? "1 contact" : `${count(n)} contacts`);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The default role when the pipeline offers it, else its first role.
function startRole(e: EstateInfo): string {
  return e.roles.some((r) => r.key === e.defaultRole) ? e.defaultRole : (e.roles[0]?.key ?? e.defaultRole);
}

function defaultLabel(source: string, now: Date = new Date()): string {
  return `${source} import, ${MONTHS[now.getMonth()]} ${now.getFullYear()}`.slice(0, MAX_LABEL);
}

/** A mapping with each column used once: the first field that names a column keeps it. */
function oneFieldPerColumn(mapping: Mapping): Mapping {
  const out: Mapping = {};
  const used = new Set<number>();
  for (const { key } of FIELD_ROWS) {
    const column = mapping[key];
    if (column === undefined || used.has(column)) continue;
    used.add(column);
    out[key] = column;
  }
  return out;
}

/** Whether 3/12/2021 in this column means 3 December: true when some day is over 12 and no month is. */
function readsDayFirst(rows: string[][], column: number | undefined): boolean {
  if (column === undefined) return false;
  let dayFirst = false;
  for (const row of rows) {
    const m = /^\s*(\d{1,2})[/.](\d{1,2})[/.]\d{4}\s*$/.exec(row[column] ?? "");
    if (!m) continue;
    if (Number(m[2]) > 12) return false;
    if (Number(m[1]) > 12) dayFirst = true;
  }
  return dayFirst;
}

/** How one row reads in a list: name and company, or for a row with no name its place and first cells. */
function rowLine(job: ImportJob, rowNumber: number): string {
  const contact = job.contacts[rowNumber];
  if (contact) return contact.org ? `${contact.name} · ${contact.org}` : contact.name;
  const cells = (job.rows[rowNumber] ?? []).map((c) => c.trim()).filter((c) => c !== "").slice(0, 3);
  const text = cells.join(", ").slice(0, 120);
  return text === "" ? `Row ${count(rowNumber + 1)}` : `Row ${count(rowNumber + 1)}: ${text}`;
}

/** What the check compares a row by, and so all that is sent to it. */
function checkRow(contact: ImportContact | null): Pick<ImportContact, "name" | "org" | "email"> | null {
  if (contact === null) return null;
  return { name: contact.name, ...(contact.org ? { org: contact.org } : {}), ...(contact.email ? { email: contact.email } : {}) };
}

function RowList({ job, label, rowNumbers }: { job: ImportJob; label: string; rowNumbers: number[] }) {
  const shown = rowNumbers.slice(0, LIST_MAX);
  return (
    <ul aria-label={label} className={scrollList}>
      {shown.map((n) => (
        <li key={n} className="break-words">
          {job.tooLarge.includes(n) ? `${rowLine(job, n)}: ${ROW_TOO_LARGE}` : rowLine(job, n)}
        </li>
      ))}
      {rowNumbers.length > shown.length && (
        <li className="text-neutral-600 dark:text-neutral-400">{`and ${count(rowNumbers.length - shown.length)} more`}</li>
      )}
    </ul>
  );
}

export default function ImportPanel({
  estate,
  job,
  onChange,
  onUnauthorized,
  retryWaitMs = RETRY_WAIT_MS,
}: {
  /** The pipeline the contacts go into: the one that is open. */
  estate: EstateInfo;
  job: ImportJob;
  /** The job as it now stands; null closes this screen. */
  onChange: ImportJobChange;
  onUnauthorized: () => void;
  /** How long to wait before a failed save is sent again. */
  retryWaitMs?: number;
}) {
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [checked, setChecked] = useState(0);
  const [checkFailed, setCheckFailed] = useState<"signal" | "large" | null>(null);
  const [openGroup, setOpenGroup] = useState<RowClass | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);

  // The latest props, for the moment a request returns.
  const calls = useRef({ onChange, onUnauthorized });
  calls.current = { onChange, onUnauthorized };
  const jobRef = useRef(job);
  jobRef.current = job;
  // False once this screen is gone (the passcode screen replaced it): a save run then stops where it is.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // One save run at a time; these do not ride on a render, so a second tap in the same tick is refused.
  const runRef = useRef(false);
  const stopRef = useRef(false);
  // The import whose columns the server has been asked about, so it is asked once.
  const mapAsked = useRef("");

  const patch = useCallback((changes: Partial<ImportJob>) => calls.current.onChange((prev) => ({ ...prev, ...changes })), []);

  // Closing the page or the tab while rows are being saved asks first.
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  // --- choose file -------------------------------------------------------------------------------

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file || reading) return;
    setReading(true);
    setFileError(null);
    try {
      const table = await readImportFile(file);
      if (!alive.current) return;
      const known = knownMapping(table.headers);
      setCheckFailed(null);
      setOpenGroup(null);
      calls.current.onChange({
        ...NEW_IMPORT_JOB,
        step: "columns",
        importId: crypto.randomUUID(),
        fileName: file.name,
        headers: table.headers,
        rows: table.rows,
        mapping: known ? oneFieldPerColumn(known) : {},
        mapSource: known ? "known" : "loading",
        role: startRole(estate),
        label: defaultLabel(sourceName(table.headers, file.name)),
      });
    } catch (err) {
      if (alive.current) setFileError(err instanceof ImportFileError ? err.message : UNREADABLE);
    } finally {
      if (alive.current) setReading(false);
    }
  }

  // --- columns -----------------------------------------------------------------------------------

  // A file Monsoon does not know: the server is asked once, with the headings and five sample rows.
  // Any failure leaves the columns for the person to choose.
  useEffect(() => {
    if (job.step !== "columns" || job.mapSource !== "loading" || mapAsked.current === job.importId) return;
    const id = job.importId;
    mapAsked.current = id;
    const width = Math.min(job.headers.length, MAX_COLUMNS);
    const cut = (cell: string | undefined) => (cell ?? "").slice(0, SAMPLE_CHARS);
    const headers = job.headers.slice(0, width).map(cut);
    const samples = job.rows.slice(0, SAMPLE_ROWS).map((row) => Array.from({ length: width }, (_, i) => cut(row[i])));
    void (async () => {
      let res: Awaited<ReturnType<typeof mapImportColumns>> | null = null;
      try {
        res = await mapImportColumns(headers, samples);
      } catch {
        // no signal: the person chooses the columns
      }
      if (!alive.current || jobRef.current.importId !== id || jobRef.current.mapSource !== "loading") return;
      if (res?.status === 401) return calls.current.onUnauthorized();
      const body = res?.status === 200 ? res.body : null;
      const mapping = body && "mapping" in body ? validateMapping(body.mapping, width) : null;
      // With no answer, whatever columns were recognised by their headings are still filled in.
      patch(
        mapping
          ? { mapping: oneFieldPerColumn(mapping), mapSource: "claude" }
          : { mapping: oneFieldPerColumn(recognisedColumns(jobRef.current.headers) ?? {}), mapSource: "none" },
      );
    })();
  }, [job.step, job.mapSource, job.importId, job.headers, job.rows, patch]);

  function setColumn(field: Field, value: string) {
    const mapping: Mapping = { ...job.mapping };
    if (value === "") delete mapping[field];
    else mapping[field] = Number(value);
    patch({ mapping });
  }

  const mappingOk = job.mapSource !== "loading" && validateMapping(job.mapping, job.headers.length) !== null;

  function confirmColumns() {
    const mapping = validateMapping(job.mapping, job.headers.length);
    if (!mapping || job.mapSource === "loading") return;
    const dayFirst = readsDayFirst(job.rows, mapping.connectedOn);
    // Once, here: the contacts are kept with the job and never worked out again.
    const contacts = job.rows.map((row) => rowToContact(row, mapping, { dayFirst }));
    setCheckFailed(null);
    setChecked(0);
    setOpenGroup(null);
    patch({ step: "summary", mapping, contacts, classes: null });
  }

  // --- summary -----------------------------------------------------------------------------------

  // The check: read-only, at most 200 rows a request and well inside the route's size limit. It
  // runs whenever the summary has no answer yet, which is also what happens after signing in again.
  const estateKey = estate.key;
  const checking = job.step === "summary" && job.classes === null && !checkFailed;
  const contacts = job.contacts;
  useEffect(() => {
    if (!checking) return;
    let live = true;
    void (async () => {
      const slim = contacts.map(checkRow);
      const { chunks, tooLarge } = bySize(
        slim.map((_, rowNumber) => rowNumber),
        (rowNumber) => jsonBytes(slim[rowNumber]),
        { maxCount: CHECK_CHUNK, maxBytes: requestBudget(CHECK_MAX_BODY), baseBytes: jsonBytes({ pipeline: estateKey, rows: [] }) },
      );
      const classes: RowClass[] = new Array(slim.length);
      // Never so with a contact's capped fields; were it so, the save step says the row is too large.
      for (const rowNumber of tooLarge) classes[rowNumber] = "new";
      let answered = tooLarge.length;
      setChecked(0);
      for (const chunk of chunks) {
        let res: Awaited<ReturnType<typeof checkImportRows>> | null = null;
        try {
          res = await checkImportRows(
            estateKey,
            chunk.map((rowNumber) => slim[rowNumber]),
          );
        } catch {
          // no signal: the retry line
        }
        if (!live) return;
        if (res?.status === 401) return calls.current.onUnauthorized();
        if (res?.status === 413) return setCheckFailed("large");
        const got = res?.status === 200 && res.body && "classes" in res.body && Array.isArray(res.body.classes) ? res.body.classes : null;
        if (!got || got.length !== chunk.length || !got.every((c) => CLASSES.includes(c))) return setCheckFailed("signal");
        // A row with no name is unreadable whatever else is said about it.
        got.forEach((c, at) => (classes[chunk[at]] = slim[chunk[at]] === null ? "unreadable" : c));
        answered += chunk.length;
        setChecked(answered);
      }
      // The check sees the file a request at a time, so a row repeated further apart than that is
      // found here, over the whole file, by the same rule.
      fileRepeats(contacts).forEach((repeat, rowNumber) => {
        if (repeat && classes[rowNumber] !== "unreadable") classes[rowNumber] = "repeat";
      });
      patch({ classes });
    })();
    return () => {
      live = false;
    };
  }, [checking, contacts, estateKey, patch]);

  const groups = useMemo(() => {
    const out: Record<RowClass, number[]> = { new: [], existing: [], possible: [], repeat: [], unreadable: [] };
    job.classes?.forEach((c, rowNumber) => out[c]?.push(rowNumber));
    return out;
  }, [job.classes]);
  const toImport = groups.new.length + (job.includePossible ? groups.possible.length : 0);

  // --- saving ------------------------------------------------------------------------------------

  /**
   * The closing request, once the rows of a run are done: the server then writes the one summary
   * entry per company for the whole import. Sending it again is safe. A failure does not hold the
   * result back. Answers true when the session has ended.
   */
  async function close(from: ImportJob): Promise<boolean> {
    for (let tries = 0; tries < CLOSE_TRIES; tries++) {
      if (tries > 0) await wait(retryWaitMs);
      if (!alive.current) return false;
      let res: Awaited<ReturnType<typeof finishImport>> | null = null;
      try {
        res = await finishImport({ pipeline: estateKey, importId: from.importId, label: from.label });
      } catch {
        // no signal: once more
      }
      if (res?.status === 401) return true;
      if (res?.status === 200 || res?.status === 400) return false;
    }
    return false;
  }

  /**
   * Sends the given rows one request after the other: at most 50 rows each, and by size well
   * inside the route's limit. A row answered `failed`, and every row of a request that got no
   * answer, is sent again up to twice more. A request refused as too large is split in two, and a
   * row too large to send alone is marked so and left. A 401 stops the run with the job as it
   * stands. Stopped or finished, the import is closed, what was not saved is marked failed and the
   * result is shown.
   */
  async function run(queue: number[], from: ImportJob) {
    if (runRef.current) return;
    runRef.current = true;
    stopRef.current = false;
    setRunning(true);
    setStopping(false);
    let first = !from.firstDone;
    let signedOut = false;
    const envelope = { pipeline: estateKey, importId: from.importId, label: from.label, role: from.role, includePossible: from.includePossible };
    const sized = bySize(queue, (rowNumber) => jsonBytes({ rowNumber, contact: from.contacts[rowNumber] }), {
      maxCount: SAVE_CHUNK,
      maxBytes: requestBudget(SAVE_MAX_BODY),
      baseBytes: jsonBytes({ ...envelope, first: true, rows: [] }),
    });
    const tooLarge = (rows: number[]) => {
      const failed: Record<number, SaveOutcome> = {};
      for (const n of rows) failed[n] = "failed";
      calls.current.onChange((prev) => ({
        ...prev,
        outcomes: { ...prev.outcomes, ...failed },
        tooLarge: [...new Set([...prev.tooLarge, ...rows])].sort((a, b) => a - b),
      }));
    };
    if (sized.tooLarge.length > 0) tooLarge(sized.tooLarge);
    const work = [...sized.chunks];
    try {
      while (work.length > 0 && !stopRef.current && !signedOut) {
        let pending = work.shift() as number[];
        for (let tries = 0; tries < SAVE_TRIES && pending.length > 0; tries++) {
          if (tries > 0) {
            await wait(retryWaitMs);
            if (stopRef.current || !alive.current) break;
          }
          let res: Awaited<ReturnType<typeof saveImportRows>> | null = null;
          try {
            res = await saveImportRows({
              ...envelope,
              ...(first ? { first: true as const } : {}),
              rows: pending.map((rowNumber) => ({ rowNumber, contact: from.contacts[rowNumber] })),
            });
          } catch {
            // no signal or a timeout: sent again below
          }
          if (res?.status === 401) {
            signedOut = true;
            break;
          }
          if (res?.status === 413) {
            // Never a signal problem, and sending the same request again cannot help.
            const half = Math.ceil(pending.length / 2);
            if (pending.length > 1) work.unshift(pending.slice(0, half), pending.slice(half));
            else tooLarge(pending);
            pending = [];
            break;
          }
          const results = res?.status === 200 && res.body && "results" in res.body && Array.isArray(res.body.results) ? res.body.results : null;
          if (results) {
            first = false;
            const settled: Record<number, SaveOutcome> = {};
            for (const r of results) if (pending.includes(r.rowNumber) && r.outcome !== "failed") settled[r.rowNumber] = r.outcome;
            pending = pending.filter((n) => settled[n] === undefined);
            // Recorded even when this screen has gone: the job lives in the parent.
            calls.current.onChange((prev) => ({ ...prev, firstDone: true, outcomes: { ...prev.outcomes, ...settled } }));
          } else if (res?.status === 400) break; // the request itself is wrong: sending it again cannot help
          if (!alive.current) break;
        }
        if (signedOut || !alive.current) break;
        if (pending.length > 0) {
          const failed: Record<number, SaveOutcome> = {};
          for (const n of pending) failed[n] = "failed";
          calls.current.onChange((prev) => ({ ...prev, outcomes: { ...prev.outcomes, ...failed } }));
        }
      }
      if (!signedOut && alive.current) signedOut = await close(from);
    } finally {
      runRef.current = false;
      if (alive.current) {
        setRunning(false);
        setStopping(false);
      }
    }
    // Signed out: everything is kept, and the import carries on from here after signing in.
    if (signedOut) return calls.current.onUnauthorized();
    if (alive.current) finish();
  }

  /** The result: whatever in the run has no answer was not saved. */
  function finish() {
    calls.current.onChange((prev) => {
      const outcomes = { ...prev.outcomes };
      for (const n of prev.queue) if (outcomes[n] === undefined) outcomes[n] = "failed";
      return { ...prev, outcomes, step: "result" };
    });
  }

  function startImport() {
    const label = job.label.trim();
    if (runRef.current || job.classes === null || toImport === 0 || label === "") return;
    // Every row with a name is sent: the server decides each one again as it saves, and a contact
    // already in Monsoon gets its "Also in" entry.
    const queue: number[] = [];
    job.contacts.forEach((c, rowNumber) => {
      if (c !== null) queue.push(rowNumber);
    });
    const next: ImportJob = { ...job, step: "progress", label, queue, outcomes: {}, tooLarge: [] };
    calls.current.onChange(next);
    void run(queue, next);
  }

  function continueImport() {
    // With nothing left to send this still closes the import.
    void run(
      job.queue.filter((n) => job.outcomes[n] === undefined),
      job,
    );
  }

  const failedRows = useMemo(() => {
    const out: number[] = [];
    for (const key of Object.keys(job.outcomes)) if (job.outcomes[Number(key)] === "failed") out.push(Number(key));
    return out.sort((a, b) => a - b);
  }, [job.outcomes]);

  // A row too large to send is not sent again.
  const retryRows = useMemo(() => failedRows.filter((n) => !job.tooLarge.includes(n)), [failedRows, job.tooLarge]);

  function retryFailed() {
    if (runRef.current || retryRows.length === 0) return;
    const outcomes = { ...job.outcomes };
    for (const n of retryRows) delete outcomes[n];
    const next: ImportJob = { ...job, step: "progress", queue: retryRows, outcomes };
    calls.current.onChange(next);
    void run(retryRows, next);
  }

  // Progress counts the rows the button counted (new, and the possible matches when asked for),
  // so it can never pass that number. Rows already in Monsoon, which only get an "Also in" entry,
  // are counted apart. Repeats and possible matches left out are sent too, and count for neither.
  const progress = useMemo(() => {
    const p = { done: 0, total: 0, alsoDone: 0, alsoTotal: 0 };
    for (const rowNumber of job.queue) {
      const c = job.classes?.[rowNumber];
      const settled = job.outcomes[rowNumber] !== undefined && job.outcomes[rowNumber] !== "failed";
      if (c === "new" || (c === "possible" && job.includePossible)) {
        p.total++;
        if (settled) p.done++;
      } else if (c === "existing") {
        p.alsoTotal++;
        if (settled) p.alsoDone++;
      }
    }
    return p;
  }, [job.queue, job.classes, job.outcomes, job.includePossible]);
  const { done, total } = progress;

  /** The possible matches that were not imported: left out by choice, or impossible to store beside their match. */
  const leftOut = useMemo(() => {
    const out: number[] = [];
    for (const key of Object.keys(job.outcomes)) {
      const outcome = job.outcomes[Number(key)];
      if (outcome === "skipped" || outcome === "possible_skipped") out.push(Number(key));
    }
    return out.sort((a, b) => a - b);
  }, [job.outcomes]);

  const tally = useMemo(() => {
    const t = { added: 0, existing: 0, skipped: 0, failed: 0 };
    // Rows with no name were never sent.
    for (const c of job.contacts) if (c === null) t.skipped++;
    for (const key of Object.keys(job.outcomes)) {
      const outcome = job.outcomes[Number(key)];
      if (outcome === "added") t.added++;
      else if (outcome === "existing") t.existing++;
      else if (outcome === "failed") t.failed++;
      else t.skipped++;
    }
    return t;
  }, [job.contacts, job.outcomes]);

  // --- leaving -----------------------------------------------------------------------------------

  function back() {
    if (reading || stopping) return;
    if (job.step === "progress") {
      if (!window.confirm(STOP)) return;
      if (runRef.current) {
        // The request in flight finishes; nothing more is sent.
        stopRef.current = true;
        setStopping(true);
      } else finish();
      return;
    }
    if (job.step === "summary") {
      setCheckFailed(null);
      return patch({ step: "columns", contacts: [], classes: null });
    }
    if (job.step === "columns") {
      setFileError(null);
      return calls.current.onChange({ ...NEW_IMPORT_JOB });
    }
    calls.current.onChange(null);
  }

  const firstRow = job.rows[0] ?? [];
  const usedBy = new Map<number, Field>();
  for (const { key } of FIELD_ROWS) {
    const column = job.mapping[key];
    if (column !== undefined) usedBy.set(column, key);
  }

  return (
    <section aria-labelledby="import-title" className="flex flex-col gap-4">
      <button
        type="button"
        onClick={back}
        disabled={reading || stopping}
        className="flex min-h-[44px] items-center gap-1.5 self-start px-1 text-[16px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Back
      </button>
      <h2 id="import-title" className="px-1 text-[26px] font-semibold tracking-tight">
        Import contacts
      </h2>

      {job.step === "file" && (
        <>
          <p className={plain}>
            Choose a CSV or .xlsx file of contacts, such as an export from LinkedIn, Salesforce, HubSpot, Google or Outlook. At most 5,000 rows and 10 MB.
          </p>
          <p className={quiet}>The contacts go into {estate.label}. Nothing is saved until you have seen a summary and confirmed.</p>
          <label
            className={`flex min-h-[64px] cursor-pointer items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#0E7FA6]/50 bg-[#0E7FA6]/5 px-4 text-[19px] font-semibold text-[#0E7FA6] focus-within:ring-2 focus-within:ring-[#0E7FA6] active:bg-[#0E7FA6]/10 dark:border-[#6AE6FF]/50 dark:bg-[#6AE6FF]/10 dark:text-[#6AE6FF] dark:focus-within:ring-[#6AE6FF] ${
              reading ? "pointer-events-none opacity-50" : ""
            }`}
          >
            {reading && <MonsoonLoader className="h-7 w-7" />}
            <span>Choose a file</span>
            <input type="file" accept=".csv,.xlsx,text/csv" className="sr-only" disabled={reading} onChange={onFile} />
          </label>
          {reading && (
            <p role="status" className={quiet}>
              Reading the file…
            </p>
          )}
          {fileError && (
            <p role="alert" className={bad}>
              {fileError}
            </p>
          )}
          <p className={quiet}>The file is read on this device. Old .xls and Numbers files are not read: save them as CSV or .xlsx first.</p>
        </>
      )}

      {job.step === "columns" && (
        <section aria-labelledby="import-columns" className="flex flex-col gap-3">
          <h3 id="import-columns" className={sectionTitle}>
            Columns
          </h3>
          <p className={quiet}>{`${job.fileName}: ${job.rows.length === 1 ? "1 row" : `${count(job.rows.length)} rows`}.`}</p>
          <p role="status" className={plain}>
            {MAP_LINES[job.mapSource]}
          </p>
          <div className={rowsCard}>
            {FIELD_ROWS.map(({ key, label }) => {
              const column = job.mapping[key];
              const sample = column === undefined ? "" : (firstRow[column] ?? "").trim().slice(0, SAMPLE_CHARS);
              return (
                <div key={key}>
                  <label htmlFor={`import-col-${key}`} className={fieldLabel}>
                    {label}
                  </label>
                  <select
                    id={`import-col-${key}`}
                    value={column === undefined ? "" : String(column)}
                    disabled={job.mapSource === "loading"}
                    onChange={(e) => setColumn(key, e.target.value)}
                    className={`${fieldInput} appearance-none`}
                  >
                    <option value="">Not in this file</option>
                    {job.headers.map((header, i) => (
                      // A column already given to another field cannot be chosen twice.
                      <option key={i} value={String(i)} disabled={usedBy.has(i) && usedBy.get(i) !== key}>
                        {header === "" ? `Column ${i + 1}` : header}
                      </option>
                    ))}
                  </select>
                  {sample !== "" && <span className="block break-words px-4 pb-2 text-[14px] text-neutral-600 dark:text-neutral-400">{`First row: ${sample}`}</span>}
                </div>
              );
            })}
          </div>
          {!mappingOk && job.mapSource !== "loading" && <p className={quiet}>Choose the column that holds the name to continue.</p>}
          <button type="button" className={primaryButton} disabled={!mappingOk} onClick={confirmColumns}>
            Continue
          </button>
        </section>
      )}

      {job.step === "summary" && job.classes === null && (
        <>
          {checkFailed ? (
            <div className="flex flex-col gap-3">
              <p role="alert" className={bad}>
                {checkFailed === "large" ? CHECK_TOO_LARGE : CHECK_FAILURE}
              </p>
              <button type="button" className={secondaryButton} onClick={() => setCheckFailed(null)}>
                Try again
              </button>
            </div>
          ) : (
            <p role="status" className={`${plain} flex items-center gap-2`}>
              <MonsoonLoader className="h-7 w-7" />
              {`Checking ${count(checked)} of ${count(job.contacts.length)} rows…`}
            </p>
          )}
        </>
      )}

      {job.step === "summary" && job.classes !== null && (
        <section aria-labelledby="import-summary" className="flex flex-col gap-3">
          <h3 id="import-summary" className={sectionTitle}>
            Summary
          </h3>
          <p role="status" className={`${plain} font-medium`}>
            {`${job.classes.length === 1 ? "1 row" : `${count(job.classes.length)} rows`}: ${count(groups.new.length)} new, ${count(groups.existing.length)} already in Monsoon, ${
              groups.possible.length === 1 ? "1 possible match" : `${count(groups.possible.length)} possible matches`
            }, ${count(groups.repeat.length)} repeated in the file, ${count(groups.unreadable.length)} cannot be read (no name)`}
          </p>
          <div className={rowsCard}>
            {GROUPS.filter((g) => groups[g.key].length > 0).map((g) => (
              <div key={g.key}>
                <button
                  type="button"
                  aria-expanded={openGroup === g.key}
                  onClick={() => setOpenGroup(openGroup === g.key ? null : g.key)}
                  className="flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-2 text-left text-[16px] font-medium active:bg-neutral-100 dark:active:bg-white/10"
                >
                  {`${g.title} (${count(groups[g.key].length)})`}
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`shrink-0 text-neutral-500 dark:text-neutral-400 ${openGroup === g.key ? "rotate-90" : ""}`}
                  >
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                {openGroup === g.key && <RowList job={job} label={g.title} rowNumbers={groups[g.key]} />}
              </div>
            ))}
          </div>

          <div className={rowsCard}>
            <div>
              <label htmlFor="import-role" className={fieldLabel}>
                Role
              </label>
              <select id="import-role" value={job.role} onChange={(e) => patch({ role: e.target.value })} className={`${fieldInput} appearance-none`}>
                {estate.roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="import-label" className={fieldLabel}>
                Label
              </label>
              <input
                id="import-label"
                type="text"
                maxLength={MAX_LABEL}
                autoComplete="off"
                value={job.label}
                onChange={(e) => patch({ label: e.target.value.slice(0, MAX_LABEL) })}
                className={fieldInput}
              />
            </div>
          </div>
          <p className={quiet}>Every imported contact gets this role and carries this label, so the import can be found again in Contacts.</p>

          {groups.possible.length > 0 && (
            <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-1 text-[16px] text-neutral-900 dark:text-white">
              <input
                type="checkbox"
                checked={job.includePossible}
                onChange={(e) => patch({ includePossible: e.target.checked })}
                className="h-6 w-6 shrink-0 accent-[#0E7FA6] dark:accent-[#6AE6FF]"
              />
              Import the possible matches as new people
            </label>
          )}

          <p className={`${plain} font-medium`}>{NO_UNDO}</p>
          <button type="button" className={primaryButton} disabled={toImport === 0 || job.label.trim() === ""} onClick={startImport}>
            {`Import ${contactsWord(toImport)}`}
          </button>
        </section>
      )}

      {job.step === "progress" && (
        <section aria-labelledby="import-progress" className="flex flex-col gap-3">
          <h3 id="import-progress" className={sectionTitle}>
            {running ? "Importing" : "Import paused"}
          </h3>
          <div
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="h-3 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10"
          >
            <div className="h-full rounded-full bg-[#0E7FA6] transition-[width] dark:bg-[#6AE6FF]" style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }} />
          </div>
          <p role="status" className={`${plain} font-medium`}>{`${count(done)} of ${count(total)} saved`}</p>
          {progress.alsoTotal > 0 && <p className={quiet}>{`${count(progress.alsoDone)} of ${count(progress.alsoTotal)} already in Monsoon noted`}</p>}
          {running ? (
            <p className={quiet}>{stopping ? "Stopping…" : "Keep this page open until it finishes."}</p>
          ) : (
            <>
              <p className={quiet}>The import paused. Nothing is lost.</p>
              <button type="button" className={primaryButton} onClick={continueImport}>
                Continue the import
              </button>
            </>
          )}
        </section>
      )}

      {job.step === "result" && (
        <section aria-labelledby="import-result" className="flex flex-col gap-3">
          <h3 id="import-result" className={sectionTitle}>
            Result
          </h3>
          <p role="status" className={`${plain} font-medium`}>
            {`${count(tally.added)} imported, ${count(tally.existing)} already here, ${count(tally.skipped)} skipped, ${count(tally.failed)} could not be saved`}
          </p>
          {leftOut.length > 0 && (
            <div className={`${card} overflow-hidden`}>
              <h4 className="px-4 py-3 text-[16px] font-medium">Possible matches, not imported</h4>
              <RowList job={job} label="Possible matches, not imported" rowNumbers={leftOut} />
            </div>
          )}
          {failedRows.length > 0 && (
            <>
              <div className={`${card} overflow-hidden`}>
                <h4 className="px-4 py-3 text-[16px] font-medium">Could not be saved</h4>
                <RowList job={job} label="Could not be saved" rowNumbers={failedRows} />
              </div>
              {retryRows.length > 0 && (
                <button type="button" className={secondaryButton} onClick={retryFailed}>
                  Try those again
                </button>
              )}
            </>
          )}
          <button type="button" className={primaryButton} onClick={() => calls.current.onChange(null)}>
            Done
          </button>
        </section>
      )}
    </section>
  );
}
