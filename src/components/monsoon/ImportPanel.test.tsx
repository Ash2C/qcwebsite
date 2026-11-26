// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import ImportPanel, { NEW_IMPORT_JOB, type ImportJob } from "./ImportPanel";

vi.mock("./api", () => ({
  mapImportColumns: vi.fn(),
  checkImportRows: vi.fn(),
  saveImportRows: vi.fn(),
  finishImport: vi.fn(),
}));
const m = vi.mocked(api);

const ESTATE = {
  key: "traxo",
  label: "Traxo",
  defaultRole: "introducer",
  available: true,
  roles: [
    { key: "lp_prospect", label: "LP prospect" },
    { key: "introducer", label: "Introducer" },
  ],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINKEDIN_HEAD =
  'Notes:\n"When exporting your connection data, you may notice that some of the email addresses are missing."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\n';

/** A LinkedIn export of `n` people: Person 0 .. Person n-1, each at "Firm i". */
function linkedin(n: number, extra = ""): File {
  let text = LINKEDIN_HEAD;
  for (let i = 0; i < n; i++) text += `Person,${i},https://www.linkedin.com/in/p${i},p${i}@example.com,Firm ${i},Partner,12 Mar 2021\n`;
  return new File([text + extra], "Connections.csv", { type: "text/csv" });
}
const csv = (text: string, name = "old crm.csv") => new File([text], name, { type: "text/csv" });

let onUnauthorized: ReturnType<typeof vi.fn>;
let latest: ImportJob | null;

// The job lives in the parent, as it does in MonsoonApp, so it survives this screen going away.
function Harness({ start }: { start: ImportJob }) {
  const [job, setJob] = React.useState<ImportJob | null>(start);
  latest = job;
  if (!job) return <p>closed</p>;
  return (
    <ImportPanel
      estate={ESTATE}
      job={job}
      onChange={(next) => setJob((prev) => (typeof next === "function" ? (prev ? next(prev) : prev) : next))}
      onUnauthorized={onUnauthorized}
      retryWaitMs={0}
    />
  );
}
const view = (start: ImportJob = NEW_IMPORT_JOB) => render(<Harness start={start} />);

type Contact = { name: string } | null;
/** Every readable row is new unless `classes` says otherwise for its name. */
function checkAs(classes: Record<string, string> = {}) {
  m.checkImportRows.mockImplementation(
    async (_pipeline, rows) =>
      ({ status: 200, body: { classes: (rows as Contact[]).map((r) => (r === null ? "unreadable" : (classes[r.name] ?? "new"))) } }) as never,
  );
}
/** Every row is added unless `outcomes` says otherwise for its row number. */
function saveAs(outcomes: Record<number, string> = {}) {
  m.saveImportRows.mockImplementation(
    async (body) => ({ status: 200, body: { results: body.rows.map((r) => ({ rowNumber: r.rowNumber, outcome: outcomes[r.rowNumber] ?? "added" })) } }) as never,
  );
}
const savedRows = (call: number) => m.saveImportRows.mock.calls[call][0].rows.map((r) => r.rowNumber);

async function choose(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(screen.getByLabelText("Choose a file"), file);
}
/** From the first screen to the summary of a LinkedIn file. */
async function toSummary(user: ReturnType<typeof userEvent.setup>, file: File) {
  await choose(user, file);
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await screen.findByText(/rows: /);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T10:00:00"));
  onUnauthorized = vi.fn();
  latest = null;
  checkAs();
  saveAs();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ImportPanel: choosing a file", () => {
  it("states the limits and takes CSV and .xlsx files", () => {
    view();
    expect(screen.getByRole("heading", { name: "Import contacts" })).toBeInTheDocument();
    expect(screen.getByText(/At most 5,000 rows and 10 MB\./)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is saved until you have seen a summary and confirmed\./)).toBeInTheDocument();
    expect(screen.getByText(/The contacts go into Traxo\./)).toBeInTheDocument();
    const input = screen.getByLabelText("Choose a file");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("accept", ".csv,.xlsx,text/csv");
  });

  it("a LinkedIn export goes straight to the columns, filled in without asking the server", async () => {
    const user = userEvent.setup();
    view();
    await choose(user, linkedin(3));
    expect(await screen.findByRole("heading", { name: "Columns" })).toBeInTheDocument();
    expect(screen.getByText("Connections.csv: 3 rows.")).toBeInTheDocument();
    expect(m.mapImportColumns).not.toHaveBeenCalled();
    const picked = (label: string) => {
      const select = screen.getByLabelText(label) as HTMLSelectElement;
      return select.selectedOptions[0].textContent;
    };
    expect(picked("First name")).toBe("First Name");
    expect(picked("Last name")).toBe("Last Name");
    expect(picked("Full name")).toBe("Not in this file");
    expect(picked("Company")).toBe("Company");
    expect(picked("Title")).toBe("Position");
    expect(picked("Email")).toBe("Email Address");
    expect(picked("Phone")).toBe("Not in this file");
    expect(picked("LinkedIn")).toBe("URL");
    expect(picked("Country")).toBe("Not in this file");
    expect(picked("Notes")).toBe("Not in this file");
    expect(picked("Connected on")).toBe("Connected On");
    // "Not in this file" is the first choice, and a sample from the first row sits beside each field.
    expect(within(screen.getByLabelText("Phone")).getAllByRole("option")[0]).toHaveTextContent("Not in this file");
    expect(screen.getByText("First row: Firm 0")).toBeInTheDocument();
    expect(screen.getByText("First row: 12 Mar 2021")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(latest?.importId).toMatch(UUID);
  });

  it("an unfamiliar file is sent to the server as its headings and five sample rows, and its answer fills the columns", async () => {
    const user = userEvent.setup();
    m.mapImportColumns.mockResolvedValue({ status: 200, body: { mapping: { fullName: 0, company: 1 }, source: "claude" } } as never);
    view();
    const lines = ["Person,Firm,Remarks"];
    for (let i = 0; i < 8; i++) lines.push(`P${i},F${i},R${i}`);
    await choose(user, csv(lines.join("\n")));
    await screen.findByText("Monsoon worked these out. Check them.");
    expect(m.mapImportColumns).toHaveBeenCalledTimes(1);
    const [headers, samples] = m.mapImportColumns.mock.calls[0];
    expect(headers).toEqual(["Person", "Firm", "Remarks"]);
    expect(samples).toHaveLength(5);
    expect(samples[0]).toEqual(["P0", "F0", "R0"]);
    expect(screen.getByLabelText("Full name")).toHaveValue("0");
    expect(screen.getByLabelText("Company")).toHaveValue("1");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("a file where only the name column is recognised is not a known format: the server is asked", async () => {
    const user = userEvent.setup();
    m.mapImportColumns.mockResolvedValue({ status: 200, body: { mapping: { fullName: 0, company: 1 }, source: "claude" } } as never);
    const first = view();
    await choose(user, csv("Name,Works at,Remarks\nJane Tan,Acme,met at SFF\n"));
    await screen.findByText("Monsoon worked these out. Check them.");
    expect(m.mapImportColumns).toHaveBeenCalledTimes(1);
    expect(m.mapImportColumns.mock.calls[0][0]).toEqual(["Name", "Works at", "Remarks"]);
    expect(screen.getByLabelText("Company")).toHaveValue("1");
    first.unmount();

    // With no answer, the column that was recognised is still filled in.
    m.mapImportColumns.mockResolvedValue({ status: 200, body: { mapping: null, source: "none" } } as never);
    view();
    await choose(user, csv("Name,Works at,Remarks\nJane Tan,Acme,met at SFF\n"));
    await screen.findByText("Choose which column is which.");
    expect(screen.getByLabelText("Full name")).toHaveValue("0");
    expect(screen.getByLabelText("Company")).toHaveValue("");
  });

  it("with no answer from the server the person chooses the columns, each for one field only", async () => {
    const user = userEvent.setup();
    m.mapImportColumns.mockResolvedValue({ status: 200, body: { mapping: null, source: "none" } } as never);
    view();
    await choose(user, csv("Person,Firm\nJane Tan,Acme\n"));
    expect(await screen.findByText("Choose which column is which.")).toBeInTheDocument();
    for (const label of ["First name", "Last name", "Full name", "Company", "Title", "Email", "Phone", "LinkedIn", "Country", "Notes", "Connected on"]) {
      expect(screen.getByLabelText(label)).toHaveValue("");
    }
    const go = screen.getByRole("button", { name: "Continue" });
    expect(go).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Company"), "Firm");
    expect(go).toBeDisabled(); // a company is not a name
    await user.selectOptions(screen.getByLabelText("Full name"), "Person");
    expect(go).toBeEnabled();
    // "Person" is taken: no other field can have it.
    expect(within(screen.getByLabelText("Notes")).getByRole("option", { name: "Person" })).toBeDisabled();
    expect(within(screen.getByLabelText("Full name")).getByRole("option", { name: "Person" })).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("Full name"), "Not in this file");
    expect(go).toBeDisabled();
  });

  it("a server that cannot be reached leaves the columns to the person, and a 401 hands over to sign-in", async () => {
    const user = userEvent.setup();
    m.mapImportColumns.mockRejectedValueOnce(new Error("net"));
    const first = view();
    await choose(user, csv("Person,Firm\nJane Tan,Acme\n"));
    expect(await screen.findByText("Choose which column is which.")).toBeInTheDocument();
    expect(onUnauthorized).not.toHaveBeenCalled();
    first.unmount();

    m.mapImportColumns.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } } as never);
    view();
    await choose(user, csv("Person,Firm\nJane Tan,Acme\n"));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    // The file is still there for after signing in.
    expect(latest?.step).toBe("columns");
    expect(latest?.rows).toEqual([["Jane Tan", "Acme"]]);
  });

  it("says plainly what is wrong with a file it will not take", async () => {
    const user = userEvent.setup({ applyAccept: false });
    view();
    await choose(user, linkedin(5001));
    expect(await screen.findByRole("alert")).toHaveTextContent("This file has more than 5,000 rows.");
    await choose(user, new File(["x"], "old.xls"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Save the spreadsheet as CSV or .xlsx first."));
    await choose(user, new File([new Uint8Array([1, 0, 0, 0, 2, 0, 0, 3])], "people.csv"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Monsoon could not read this file. Save it as CSV and try again."));
    expect(latest?.step).toBe("file");
    // A good file after a bad one clears the message.
    await choose(user, linkedin(1));
    expect(await screen.findByRole("heading", { name: "Columns" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ImportPanel: the summary", () => {
  it("checks the rows 200 at a time and shows what it found, with nothing saved", async () => {
    const user = userEvent.setup();
    checkAs({ "Person 1": "existing", "Person 2": "existing", "Person 3": "possible", "Person 4": "repeat" });
    view();
    // 450 people and one row with no name.
    await toSummary(user, linkedin(450, ",,,nobody@example.com,Nameless Ltd,,\n"));
    expect(m.checkImportRows.mock.calls.map(([pipeline, rows]) => [pipeline, rows.length])).toEqual([
      ["traxo", 200],
      ["traxo", 200],
      ["traxo", 51],
    ]);
    // Only what the check compares by is sent.
    expect(m.checkImportRows.mock.calls[0][1][0]).toEqual({ name: "Person 0", org: "Firm 0", email: "p0@example.com" });
    expect(m.checkImportRows.mock.calls[2][1][50]).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "451 rows: 446 new, 2 already in Monsoon, 1 possible match, 1 repeated in the file, 1 cannot be read (no name)",
    );
    expect(screen.getByText("This cannot be undone: Monsoon never deletes contacts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 446 contacts" })).toBeEnabled();
    expect(m.saveImportRows).not.toHaveBeenCalled();
  });

  it("each group opens to a list of names and companies, 200 at most", async () => {
    const user = userEvent.setup();
    checkAs({ "Person 1": "existing" });
    view();
    await toSummary(user, linkedin(260));
    const existing = screen.getByRole("button", { name: "Already in Monsoon (1)" });
    expect(existing).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Already in Monsoon" })).toBeNull();
    await user.click(existing);
    expect(existing).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "Already in Monsoon" })).getByText("Person 1 · Firm 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New (259)" }));
    const list = screen.getByRole("list", { name: "New" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(201);
    expect(within(list).getByText("and 59 more")).toBeInTheDocument();
    // Groups with nobody in them are not offered.
    expect(screen.queryByRole("button", { name: /^Possible matches/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cannot be read/ })).toBeNull();
  });

  it("offers the pipeline's roles with its default chosen, and a label that can be changed", async () => {
    const user = userEvent.setup();
    view();
    await toSummary(user, linkedin(2));
    const role = screen.getByLabelText("Role");
    expect(role).toHaveValue("introducer");
    expect(within(role).getAllByRole("option").map((o) => o.textContent)).toEqual(["LP prospect", "Introducer"]);
    const label = screen.getByLabelText("Label");
    expect(label).toHaveValue("LinkedIn import, Nov 2026");
    expect(label).toHaveAttribute("maxlength", "80");
    await user.clear(label);
    expect(screen.getByRole("button", { name: "Import 2 contacts" })).toBeDisabled();
    await user.type(label, "Old network");
    await user.selectOptions(role, "lp_prospect");
    await user.click(screen.getByRole("button", { name: "Import 2 contacts" }));
    await screen.findByText("2 imported, 0 already here, 0 skipped, 0 could not be saved");
    expect(m.saveImportRows.mock.calls[0][0]).toMatchObject({ pipeline: "traxo", label: "Old network", role: "lp_prospect", includePossible: false });
  });

  it("a file Monsoon does not know is labelled with its own name", async () => {
    const user = userEvent.setup();
    m.mapImportColumns.mockResolvedValue({ status: 200, body: { mapping: { fullName: 0 }, source: "claude" } } as never);
    view();
    await choose(user, csv("Person,Firm\nJane Tan,Acme\n", "old crm people.csv"));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Label")).toHaveValue("old crm people import, Nov 2026");
  });

  it("possible matches are only imported when the box is ticked, and the box is only there when there are some", async () => {
    const user = userEvent.setup();
    checkAs({ "Person 0": "possible", "Person 1": "possible" });
    const first = view();
    await toSummary(user, linkedin(3));
    const box = screen.getByRole("checkbox", { name: "Import the possible matches as new people" });
    expect(box).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Import 1 contact" })).toBeEnabled();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Import 3 contacts" }));
    await screen.findByText(/3 imported/);
    expect(m.saveImportRows.mock.calls[0][0].includePossible).toBe(true);
    first.unmount();

    checkAs();
    view();
    await toSummary(user, linkedin(3));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("with nothing new to import the button is off", async () => {
    const user = userEvent.setup();
    checkAs({ "Person 0": "existing", "Person 1": "possible" });
    view();
    await toSummary(user, linkedin(2));
    expect(screen.getByRole("button", { name: "Import 0 contacts" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Import 1 contact" })).toBeEnabled();
  });

  it("a check that fails can be tried again, and a 401 hands over to sign-in with the file kept", async () => {
    const user = userEvent.setup();
    m.checkImportRows.mockResolvedValueOnce({ status: 502, body: { error: "Could not reach the Traxo CRM" } } as never);
    const first = view();
    await choose(user, linkedin(2));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check the file. Check signal and try again.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/2 rows: 2 new/)).toBeInTheDocument();
    first.unmount();

    m.checkImportRows.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } } as never);
    const second = view();
    await choose(user, linkedin(2));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    const kept = latest as ImportJob;
    expect(kept.step).toBe("summary");
    second.unmount();
    // Signed in again: the same job is checked again and shown.
    view(kept);
    expect(await screen.findByText(/2 rows: 2 new/)).toBeInTheDocument();
  });

  it("Back steps back through the screens and then leaves", async () => {
    const user = userEvent.setup();
    view();
    await toSummary(user, linkedin(2));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Columns" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Choose a file")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("closed")).toBeInTheDocument();
  });
});

describe("ImportPanel: request sizes", () => {
  const wide = (n: number) => "\u6ce8".repeat(n);
  /** `n` people whose every field is as long as a contact can hold, in CJK text. */
  function wideFile(n: number): File {
    let text = "Name,Company,Email,Title,Phone,Country,Notes\n";
    for (let i = 0; i < n; i++) {
      text += `Person ${i},${wide(300)},p${i}@example.com,${wide(300)},${wide(300)},${wide(300)},${wide(2000)}\n`;
    }
    return csv(text, "wide.csv");
  }
  const sent = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).length;

  it("builds every request by size as well as by count: rows of the longest CJK notes stay under 60% of each route's limit", async () => {
    const user = userEvent.setup();
    view();
    await choose(user, wideFile(120));
    await user.selectOptions(await screen.findByLabelText("Notes"), "Notes");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/120 rows: 120 new/);
    for (const [pipeline, rows] of m.checkImportRows.mock.calls) {
      expect(sent({ pipeline, rows })).toBeLessThanOrEqual(0.6 * 524_288);
      for (const row of rows) expect(Object.keys(row as object).sort()).toEqual(["email", "name", "org"]);
    }
    expect(m.checkImportRows.mock.calls.flatMap(([, rows]) => rows)).toHaveLength(120);

    await user.click(screen.getByRole("button", { name: "Import 120 contacts" }));
    expect(await screen.findByText("120 imported, 0 already here, 0 skipped, 0 could not be saved")).toBeInTheDocument();
    const bodies = m.saveImportRows.mock.calls.map(([b]) => b);
    expect(bodies.length).toBeGreaterThan(3);
    for (const body of bodies) {
      expect(sent(body)).toBeLessThanOrEqual(0.6 * 262_144);
      expect(body.rows.length).toBeLessThanOrEqual(50);
    }
    expect(bodies.flatMap((b) => b.rows.map((r) => r.rowNumber))).toEqual(Array.from({ length: 120 }, (_, i) => i));
    expect(bodies[0].rows[0].contact).toMatchObject({ name: "Person 0", notes: wide(2000) });
  });

  it("a request refused as too large is split, and a row too large to send alone is marked so and not sent again", async () => {
    const user = userEvent.setup();
    m.saveImportRows.mockImplementation(async (body) => {
      const rows = body.rows.map((r) => r.rowNumber);
      if (rows.length > 1 || rows[0] === 3) return { status: 413, body: { outcome: "invalid", error: "Request too large" } } as never;
      return { status: 200, body: { results: rows.map((rowNumber) => ({ rowNumber, outcome: "added" })) } } as never;
    });
    view();
    await toSummary(user, linkedin(5));
    await user.click(screen.getByRole("button", { name: "Import 5 contacts" }));
    expect(await screen.findByText("4 imported, 0 already here, 0 skipped, 1 could not be saved")).toBeInTheDocument();
    // Row 3 went alone once and was never sent again.
    expect(m.saveImportRows.mock.calls.filter(([b]) => b.rows.length === 1 && b.rows[0].rowNumber === 3)).toHaveLength(1);
    const failed = screen.getByRole("list", { name: "Could not be saved" });
    expect(within(failed).getByText("Person 3 \u00b7 Firm 3: This row is too large.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try those again" })).toBeNull();
    expect(screen.queryByText(/signal/i)).toBeNull();
    expect((latest as ImportJob).tooLarge).toEqual([3]);
  });

  it("a check refused as too large is not called a signal problem", async () => {
    const user = userEvent.setup();
    m.checkImportRows.mockResolvedValue({ status: 413, body: { outcome: "invalid", error: "Request too large" } } as never);
    view();
    await choose(user, linkedin(2));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check the file. A row in it is too large.");
    expect(screen.queryByText(/signal/i)).toBeNull();
  });
});

describe("ImportPanel: saving", () => {
  it("saves 50 rows at a time, one request after the other, and marks only the first request", async () => {
    const user = userEvent.setup();
    checkAs({ "Person 1": "existing" });
    saveAs({ 1: "existing" });
    view();
    // Row 120 has no name: it is never sent.
    await toSummary(user, linkedin(120, ",,,nobody@example.com,Nameless Ltd,,\n"));
    let inFlight = 0;
    let most = 0;
    const inner = m.saveImportRows.getMockImplementation()!;
    m.saveImportRows.mockImplementation(async (body) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return inner(body);
    });
    await user.click(screen.getByRole("button", { name: "Import 119 contacts" }));
    expect(await screen.findByText("119 imported, 1 already here, 1 skipped, 0 could not be saved")).toBeInTheDocument();
    expect(most).toBe(1);
    expect(m.saveImportRows).toHaveBeenCalledTimes(3);
    expect(m.saveImportRows.mock.calls.map(([b]) => b.rows.length)).toEqual([50, 50, 20]);
    expect(m.saveImportRows.mock.calls.map(([b]) => b.first)).toEqual([true, undefined, undefined]);
    const ids = new Set(m.saveImportRows.mock.calls.map(([b]) => b.importId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(UUID);
    // A row's number is its place among the file's data rows.
    expect(savedRows(0)[0]).toBe(0);
    expect(savedRows(2)[19]).toBe(119);
    expect(m.saveImportRows.mock.calls[2][0].rows[19].contact).toMatchObject({ name: "Person 119", org: "Firm 119" });
    expect(screen.queryByRole("button", { name: "Try those again" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("closed")).toBeInTheDocument();
  });

  it("shows a progress bar and how many are saved while it runs", async () => {
    const user = userEvent.setup();
    view();
    await toSummary(user, linkedin(120));
    const release: (() => void)[] = [];
    const inner = m.saveImportRows.getMockImplementation()!;
    m.saveImportRows.mockImplementation(async (body) => {
      await new Promise<void>((r) => release.push(r));
      return inner(body);
    });
    await user.click(screen.getByRole("button", { name: "Import 120 contacts" }));
    const bar = await screen.findByRole("progressbar", { name: "Import progress" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "120");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("status")).toHaveTextContent("0 of 120 saved");
    // Nothing on this screen can start a second import.
    expect(screen.queryByRole("button", { name: /^Import / })).toBeNull();
    expect(screen.queryByLabelText("Choose a file")).toBeNull();
    release.shift()!();
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "50"));
    expect(screen.getByRole("status")).toHaveTextContent("50 of 120 saved");
    await waitFor(() => expect(release).toHaveLength(1));
    release.shift()!();
    await waitFor(() => expect(release).toHaveLength(1));
    release.shift()!();
    expect(await screen.findByText("120 imported, 0 already here, 0 skipped, 0 could not be saved")).toBeInTheDocument();
  });

  it("a row that fails is sent twice more and then left; Try those again sends only it", async () => {
    const user = userEvent.setup();
    saveAs({ 3: "failed", 4: "possible_skipped" });
    view();
    await toSummary(user, linkedin(6));
    await user.click(screen.getByRole("button", { name: "Import 6 contacts" }));
    expect(await screen.findByText("4 imported, 0 already here, 1 skipped, 1 could not be saved")).toBeInTheDocument();
    expect(m.saveImportRows).toHaveBeenCalledTimes(3);
    expect(savedRows(0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(savedRows(1)).toEqual([3]);
    expect(savedRows(2)).toEqual([3]);
    const failed = screen.getByRole("list", { name: "Could not be saved" });
    expect(within(failed).getAllByRole("listitem")).toHaveLength(1);
    expect(within(failed).getByText("Person 3 · Firm 3")).toBeInTheDocument();
    const importId = m.saveImportRows.mock.calls[0][0].importId;

    saveAs();
    await user.click(screen.getByRole("button", { name: "Try those again" }));
    expect(await screen.findByText("5 imported, 0 already here, 1 skipped, 0 could not be saved")).toBeInTheDocument();
    expect(m.saveImportRows).toHaveBeenCalledTimes(4);
    const again = m.saveImportRows.mock.calls[3][0];
    expect(again.rows.map((r) => r.rowNumber)).toEqual([3]);
    expect(again.importId).toBe(importId);
    expect(again.first).toBeUndefined();
    expect(screen.queryByRole("list", { name: "Could not be saved" })).toBeNull();
  });

  it("closes the import once when the rows are done, again after Try those again, and not when signed out", async () => {
    const user = userEvent.setup();
    saveAs({ 3: "failed" });
    view();
    await toSummary(user, linkedin(120));
    expect(m.finishImport).not.toHaveBeenCalled();
    // The closing request failing, or never answering properly, does not hold the result back.
    m.finishImport.mockRejectedValueOnce(new Error("net")).mockResolvedValue({ status: 200, body: { finished: true } } as never);
    await user.click(screen.getByRole("button", { name: "Import 120 contacts" }));
    expect(await screen.findByText("119 imported, 0 already here, 0 skipped, 1 could not be saved")).toBeInTheDocument();
    const importId = m.saveImportRows.mock.calls[0][0].importId;
    expect(m.finishImport.mock.calls).toEqual([
      [{ pipeline: "traxo", importId, label: "LinkedIn import, Nov 2026" }],
      [{ pipeline: "traxo", importId, label: "LinkedIn import, Nov 2026" }],
    ]);
    // Every row had been sent before it.
    expect(m.finishImport.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...m.saveImportRows.mock.invocationCallOrder));

    saveAs();
    await user.click(screen.getByRole("button", { name: "Try those again" }));
    expect(await screen.findByText("120 imported, 0 already here, 0 skipped, 0 could not be saved")).toBeInTheDocument();
    expect(m.finishImport).toHaveBeenCalledTimes(3);
    cleanup();

    // Signed out while saving: not closed; signed out at the close itself: handed to sign-in.
    m.finishImport.mockClear();
    m.saveImportRows.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } } as never);
    const second = view();
    await toSummary(user, linkedin(2));
    await user.click(screen.getByRole("button", { name: "Import 2 contacts" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(m.finishImport).not.toHaveBeenCalled();
    second.unmount();
    saveAs();
    m.finishImport.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } } as never);
    view();
    await toSummary(user, linkedin(2));
    await user.click(screen.getByRole("button", { name: "Import 2 contacts" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(2));
    expect((latest as ImportJob).step).toBe("progress");
    // After signing in, carrying on closes it and shows the result.
    await user.click(await screen.findByRole("button", { name: "Continue the import" }));
    expect(await screen.findByText("2 imported, 0 already here, 0 skipped, 0 could not be saved")).toBeInTheDocument();
    expect(m.finishImport).toHaveBeenCalledTimes(2);
  });

  it("a request that fails (no signal, the CRM unreachable, another import running) is sent again, three times at most", async () => {
    const user = userEvent.setup();
    const ok = m.saveImportRows.getMockImplementation()!;
    m.saveImportRows
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValueOnce({ status: 409, body: { error: "import_running" } } as never)
      .mockImplementationOnce(ok);
    const first = view();
    await toSummary(user, linkedin(2));
    await user.click(screen.getByRole("button", { name: "Import 2 contacts" }));
    expect(await screen.findByText("2 imported, 0 already here, 0 skipped, 0 could not be saved")).toBeInTheDocument();
    expect(m.saveImportRows).toHaveBeenCalledTimes(3);
    // No request had been answered yet, so each still carries the mark of the first.
    expect(m.saveImportRows.mock.calls.map(([b]) => b.first)).toEqual([true, true, true]);
    first.unmount();

    m.saveImportRows.mockReset();
    m.saveImportRows.mockResolvedValue({ status: 502, body: { error: "Could not reach the Traxo CRM" } } as never);
    view();
    await toSummary(user, linkedin(2));
    await user.click(screen.getByRole("button", { name: "Import 2 contacts" }));
    expect(await screen.findByText("0 imported, 0 already here, 0 skipped, 2 could not be saved")).toBeInTheDocument();
    expect(m.saveImportRows).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Try those again" })).toBeInTheDocument();
  });

  it("a request the server calls invalid is not sent again", async () => {
    const user = userEvent.setup();
    m.saveImportRows.mockResolvedValue({ status: 400, body: { outcome: "invalid", error: "unknown role: x" } } as never);
    view();
    await toSummary(user, linkedin(2));
    await user.click(screen.getByRole("button", { name: "Import 2 contacts" }));
    expect(await screen.findByText("0 imported, 0 already here, 0 skipped, 2 could not be saved")).toBeInTheDocument();
    expect(m.saveImportRows).toHaveBeenCalledTimes(1);
  });

  it("a 401 stops the import with everything kept; after signing in it carries on with the rows not yet saved", async () => {
    const user = userEvent.setup();
    const ok = m.saveImportRows.getMockImplementation()!;
    m.saveImportRows.mockImplementationOnce(ok).mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } } as never);
    const first = view();
    await toSummary(user, linkedin(120));
    await user.click(screen.getByRole("button", { name: "Import 120 contacts" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(m.saveImportRows).toHaveBeenCalledTimes(2);
    const kept = latest as ImportJob;
    expect(kept.step).toBe("progress");
    first.unmount(); // the passcode screen takes over

    m.saveImportRows.mockClear();
    saveAs();
    view(kept);
    expect(screen.getByRole("status")).toHaveTextContent("50 of 120 saved");
    expect(screen.getByText("The import paused. Nothing is lost.")).toBeInTheDocument();
    expect(m.saveImportRows).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue the import" }));
    expect(await screen.findByText("120 imported, 0 already here, 0 skipped, 0 could not be saved")).toBeInTheDocument();
    expect(m.saveImportRows.mock.calls.map(([b]) => b.rows.length)).toEqual([50, 20]);
    expect(savedRows(0)[0]).toBe(50);
    expect(m.saveImportRows.mock.calls.map(([b]) => b.first)).toEqual([undefined, undefined]);
    expect(m.saveImportRows.mock.calls[0][0].importId).toBe(kept.importId);
  });

  it("Back while it runs asks first; saying no carries on, saying yes stops after the request in flight", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    view();
    await toSummary(user, linkedin(120));
    const release: (() => void)[] = [];
    const inner = m.saveImportRows.getMockImplementation()!;
    m.saveImportRows.mockImplementation(async (body) => {
      await new Promise<void>((r) => release.push(r));
      return inner(body);
    });
    await user.click(screen.getByRole("button", { name: "Import 120 contacts" }));
    await screen.findByRole("progressbar");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(confirm).toHaveBeenCalledWith("Stop the import? Contacts already saved stay.");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Back" }));
    release.shift()!();
    expect(await screen.findByText("50 imported, 0 already here, 0 skipped, 70 could not be saved")).toBeInTheDocument();
    expect(m.saveImportRows).toHaveBeenCalledTimes(1);
    // The rest can still be imported: nothing was lost.
    const failed = screen.getByRole("list", { name: "Could not be saved" });
    expect(within(failed).getAllByRole("listitem")).toHaveLength(70);
    expect(within(failed).getByText("Person 50 · Firm 50")).toBeInTheDocument();
    m.saveImportRows.mockImplementation(inner);
    await user.click(screen.getByRole("button", { name: "Try those again" }));
    expect(await screen.findByText("120 imported, 0 already here, 0 skipped, 0 could not be saved")).toBeInTheDocument();
  });

  it("warns before the page is closed while an import runs, and not otherwise", async () => {
    const user = userEvent.setup();
    view();
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    await toSummary(user, linkedin(2));
    let release = () => {};
    const inner = m.saveImportRows.getMockImplementation()!;
    m.saveImportRows.mockImplementation(async (body) => {
      await new Promise<void>((r) => (release = r));
      return inner(body);
    });
    await user.click(screen.getByRole("button", { name: "Import 2 contacts" }));
    await screen.findByRole("progressbar");
    expect(leave()).toBe(true);
    release();
    await screen.findByText(/2 imported/);
    expect(leave()).toBe(false);
  });

  it("never puts thousands of rows on the page", async () => {
    const user = userEvent.setup();
    view();
    await toSummary(user, linkedin(3000));
    expect(m.checkImportRows).toHaveBeenCalledTimes(15);
    await user.click(screen.getByRole("button", { name: "New (3,000)" }));
    expect(document.querySelectorAll("li").length).toBeLessThanOrEqual(201);
    expect(screen.getByRole("button", { name: "Import 3,000 contacts" })).toBeEnabled();
  }, 30_000);
});
