// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContactsPanel, { EMPTY_CONTACTS, type ContactsState } from "./ContactsPanel";
import * as api from "./api";

vi.mock("./api", () => ({ searchContacts: vi.fn(), loadProfile: vi.fn(), loadImports: vi.fn(), loadImportContacts: vi.fn() }));
const m = vi.mocked(api);

const ESTATE = {
  key: "traxo",
  label: "Traxo",
  defaultRole: "lp_prospect",
  available: true,
  roles: [{ key: "lp_prospect", label: "LP prospect" }],
};

const SELF = {
  kind: "person", personId: "p1", orgId: "o1", name: "Jane Tan", title: "Partner", company: "Acme Capital",
  email: "jane@acme.com", member: { memberId: "m1", memberKind: "person", role: "lp_prospect", stage: "in_talks" }, memberOf: "self",
};
const FILED = {
  kind: "person", personId: "p2", orgId: "o1", name: "Raj Rao", title: null, company: "Acme Capital",
  email: null, member: { memberId: "m2", memberKind: "company", role: "lp_prospect", stage: "lead" }, memberOf: "company",
};
const LOOSE = {
  kind: "person", personId: "p3", orgId: null, name: "Sam Lee", title: "Analyst", company: null,
  email: null, member: null, memberOf: null,
};
const COMPANY = {
  kind: "company", personId: null, orgId: "o1", name: "Acme Capital", title: null, company: null,
  email: null, member: { memberId: "m2", memberKind: "company", role: "lp_prospect", stage: "lead" }, memberOf: "self",
};

const hits = (...contacts: unknown[]) => ({ status: 200, body: { contacts } }) as never;

const OTHER = { ...ESTATE, key: "zeroone", label: "Zero One" };

function Harness({
  onUnauthorized = () => {},
  estate = ESTATE,
  initial = EMPTY_CONTACTS,
  onViewing,
  reloadSignal,
}: {
  onViewing?: (v: unknown) => void;
  reloadSignal?: number;
  onUnauthorized?: () => void;
  estate?: typeof ESTATE;
  initial?: ContactsState;
}) {
  const [state, setState] = useState<ContactsState>(initial);
  return <ContactsPanel estate={estate} state={state} onChange={setState} onUnauthorized={onUnauthorized} onViewing={onViewing} reloadSignal={reloadSignal} />;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function type(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Search contacts" }), { target: { value: text } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ContactsPanel", () => {
  it("every row shows its next action and last action, blank when there is none", async () => {
    const year = new Date().getFullYear();
    const busy = {
      ...SELF,
      work: { priority: "high", nextAction: "Send deck", nextActionDate: `${year}-03-05`, due: "overdue", lastKind: "meeting", lastAt: `${year}-02-20T10:00:00Z`, stageOrd: 2, recentAt: null },
    };
    m.searchContacts.mockResolvedValue(hits(busy, { ...COMPANY, work: null }));
    render(<Harness />);
    await advance(0);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("High");
    expect(rows[0]).toHaveTextContent("Next: Send deck · 5 Mar · overdue");
    expect(rows[0]).toHaveTextContent("Last: Meeting · 20 Feb");
    expect(rows[1]).toHaveTextContent("Next: —");
    expect(rows[1]).toHaveTextContent("Last: —");
    expect(rows[1]).not.toHaveTextContent("High");
  });

  it("High priority and the sorts ask the server again and stay switched on", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    render(<Harness />);
    await advance(0);
    const high = screen.getByRole("button", { name: "High priority" });
    expect(high).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(high);
    await advance(0);
    expect(m.searchContacts).toHaveBeenLastCalledWith("traxo", "", { high: true, sort: "recent" });
    expect(high).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "Recent" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next action" }));
    await advance(0);
    expect(m.searchContacts).toHaveBeenLastCalledWith("traxo", "", { high: true, sort: "next" });
    expect(screen.getByRole("button", { name: "Next action" })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Recent", "Last action", "Stage"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }

    fireEvent.click(high);
    await advance(0);
    expect(m.searchContacts).toHaveBeenLastCalledWith("traxo", "", { high: false, sort: "next" });
  });

  it("says when nothing is high priority, and how many rows are not shown", async () => {
    m.searchContacts.mockResolvedValue(hits());
    render(<Harness />);
    await advance(0);
    expect(screen.getByText("No contacts yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "High priority" }));
    await advance(0);
    expect(screen.getByText("No high-priority contacts.")).toBeInTheDocument();

    m.searchContacts.mockResolvedValue({ status: 200, body: { contacts: [SELF], total: 240 } } as never);
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await advance(0);
    expect(screen.getByText("Showing 1 of 240. Search to find the rest.")).toBeInTheDocument();
  });

  it("shows the recent list under Recent and a search box with the estate placeholder", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    render(<Harness />);
    await advance(0);
    expect(m.searchContacts).toHaveBeenCalledWith("traxo", "");
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search Traxo")).toBeInTheDocument();
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("searches after a 250 ms pause, with the trimmed text, and a single character stays on recent", async () => {
    m.searchContacts.mockResolvedValue(hits());
    render(<Harness />);
    await advance(0);
    m.searchContacts.mockClear();
    type("j");
    await advance(0);
    expect(m.searchContacts).not.toHaveBeenCalled(); // still the recent list, nothing new to fetch
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    type("ja");
    await advance(200);
    type(" jan ");
    await advance(200);
    expect(m.searchContacts).not.toHaveBeenCalled();
    await advance(60);
    expect(m.searchContacts).toHaveBeenCalledTimes(1);
    expect(m.searchContacts).toHaveBeenLastCalledWith("traxo", "jan");
    expect(screen.queryByRole("heading", { name: "Recent" })).toBeNull();
  });

  it("clears the query with the clear button", async () => {
    m.searchContacts.mockResolvedValue(hits());
    render(<Harness />);
    await advance(0);
    type("jane");
    await advance(250);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await advance(0);
    expect(screen.getByRole("textbox", { name: "Search contacts" })).toHaveValue("");
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
  });

  it("ignores a late response for an older query", async () => {
    let first!: (v: never) => void;
    m.searchContacts
      .mockResolvedValueOnce(hits())
      .mockImplementationOnce(() => new Promise((r) => (first = r as never)))
      .mockResolvedValueOnce(hits(LOOSE));
    render(<Harness />);
    await advance(0);
    type("jane");
    await advance(250);
    type("sam");
    await advance(250);
    expect(screen.getByText("Sam Lee")).toBeInTheDocument();
    await act(async () => first(hits(SELF)));
    expect(screen.queryByText("Jane Tan")).toBeNull();
    expect(screen.getByText("Sam Lee")).toBeInTheDocument();
  });

  it("says when nothing matches", async () => {
    m.searchContacts.mockResolvedValue(hits());
    render(<Harness />);
    await advance(0);
    type("zzz");
    await advance(250);
    expect(screen.getByText('No contacts match "zzz".')).toBeInTheDocument();
  });

  it("renders each row variant", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF, FILED, LOOSE, COMPANY));
    render(<Harness />);
    await advance(0);
    expect(screen.getByText("Partner · Acme Capital")).toBeInTheDocument();
    expect(screen.getByText("LP prospect · In talks")).toBeInTheDocument();
    expect(screen.getByText("filed under Acme Capital")).toBeInTheDocument();
    expect(screen.getByText("on file, not on the pipeline")).toBeInTheDocument();
    expect(screen.getByText("Analyst")).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("LP prospect · Lead")).toBeInTheDocument();
  });

  it("shows a failure with Retry, and Retry loads again", async () => {
    m.searchContacts.mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce(hits(SELF));
    render(<Harness />);
    await advance(0);
    expect(screen.getByText("Could not load contacts. Check signal.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await advance(0);
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    expect(screen.queryByText("Could not load contacts. Check signal.")).toBeNull();
  });

  it("treats a non-200 answer as a failure", async () => {
    m.searchContacts.mockResolvedValue({ status: 500, body: { error: "x" } } as never);
    render(<Harness />);
    await advance(0);
    expect(screen.getByText("Could not load contacts. Check signal.")).toBeInTheDocument();
  });

  it("calls onUnauthorized on a 401", async () => {
    const onUnauthorized = vi.fn();
    m.searchContacts.mockResolvedValue({ status: 401, body: { error: "unauthorized" } } as never);
    render(<Harness onUnauthorized={onUnauthorized} />);
    await advance(0);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("opens a person's profile, and Back returns with the query kept", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    m.loadProfile.mockResolvedValue({ status: 404, body: { error: "Not found" } } as never);
    render(<Harness />);
    await advance(0);
    type("jane");
    await advance(250);
    fireEvent.click(screen.getByRole("button", { name: /Jane Tan/ }));
    await advance(0);
    expect(m.loadProfile).toHaveBeenCalledWith("traxo", { personId: "p1" }, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(screen.getByText("That contact is no longer on file.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search contacts" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Contacts/ }));
    await advance(250);
    expect(screen.getByRole("textbox", { name: "Search contacts" })).toHaveValue("jane");
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
  });

  it("opens a company row by its orgId", async () => {
    m.searchContacts.mockResolvedValue(hits(COMPANY));
    m.loadProfile.mockResolvedValue({ status: 404, body: { error: "Not found" } } as never);
    render(<Harness />);
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: /Acme Capital/ }));
    await advance(0);
    expect(m.loadProfile).toHaveBeenCalledWith("traxo", { orgId: "o1" }, expect.any(String));
  });

  it("drops the old estate's rows and an open profile when the estate changes, before the new response", async () => {
    m.searchContacts.mockResolvedValueOnce(hits(SELF));
    const { rerender } = render(<Harness />);
    await advance(0);
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    m.searchContacts.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<Harness estate={OTHER} />);
    await advance(0);
    expect(screen.queryByText("Jane Tan")).toBeNull();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(m.searchContacts).toHaveBeenLastCalledWith("zeroone", "");
  });

  it("never requests a profile of the new estate with the old ids", async () => {
    m.searchContacts.mockResolvedValue(hits());
    m.loadProfile.mockResolvedValue({ status: 404, body: { error: "Not found" } } as never);
    const { rerender } = render(<Harness initial={{ query: "", open: { personId: "p1" } }} />);
    await advance(0);
    expect(m.loadProfile).toHaveBeenCalledTimes(1);
    rerender(<Harness initial={{ query: "", open: { personId: "p1" } }} estate={OTHER} />);
    await advance(0);
    expect(m.loadProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "Search contacts" })).toBeInTheDocument();
  });

  it("ignores a profile response that arrives after Back", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    let resolveProfile!: (v: never) => void;
    m.loadProfile.mockImplementationOnce(() => new Promise((r) => (resolveProfile = r as never)));
    render(<Harness />);
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: /Jane Tan/ }));
    await advance(0);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Contacts/ }));
    await advance(0);
    expect(screen.getByRole("textbox", { name: "Search contacts" })).toBeInTheDocument();
    await act(async () => resolveProfile({ status: 200, body: { profile: { ...SELF, phone: null, linkedin: null, country: null, website: null, notes: null, timelineOf: null, timeline: [], timelineTotal: 0, people: [], stages: [] } } } as never));
    await advance(0);
    expect(screen.getByRole("textbox", { name: "Search contacts" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Jane Tan" })).toBeNull();
  });

  it("closes a loaded profile when the estate changes, and does not show it again", async () => {
    m.searchContacts.mockResolvedValue(hits());
    m.loadProfile.mockResolvedValue({ status: 200, body: { profile: { ...SELF, phone: null, linkedin: null, country: null, website: null, notes: null, timelineOf: null, timeline: [], timelineTotal: 0, people: [], stages: [] } } } as never);
    const open = { query: "", open: { personId: "p1" } };
    const { rerender } = render(<Harness initial={open} />);
    await advance(0);
    expect(screen.getByRole("heading", { name: "Jane Tan" })).toBeInTheDocument();
    rerender(<Harness initial={open} estate={OTHER} />);
    await advance(0);
    expect(screen.queryByRole("heading", { name: "Jane Tan" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search contacts" })).toBeInTheDocument();
    expect(m.loadProfile).toHaveBeenCalledTimes(1);
  });

  it("opens a company hit without an orgId by its memberId, and leaves a row with no id untappable", async () => {
    const byMember = { ...COMPANY, orgId: null };
    const noId = { ...COMPANY, orgId: null, name: "Ghost Co", member: null, memberOf: null };
    m.searchContacts.mockResolvedValue(hits(byMember, noId));
    m.loadProfile.mockResolvedValue({ status: 404, body: { error: "Not found" } } as never);
    render(<Harness />);
    await advance(0);
    expect(screen.queryByRole("button", { name: /Ghost Co/ })).toBeNull();
    expect(screen.getByText("Ghost Co")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Acme Capital/ }));
    await advance(0);
    expect(m.loadProfile).toHaveBeenCalledWith("traxo", { memberId: "m2" }, expect.any(String));
  });
});

describe("ContactsPanel tells Ask what is open", () => {
  const LOADED = { status: 200, body: { profile: { ...SELF, phone: null, linkedin: null, country: null, website: null, notes: null, timelineOf: null, timeline: [], timelineTotal: 0, people: [], stages: [] } } } as never;
  const open = { query: "", open: { personId: "p1" } };

  it("reports the loaded profile with its target, name and company, and null after Back", async () => {
    m.searchContacts.mockResolvedValue(hits());
    m.loadProfile.mockResolvedValue(LOADED);
    const onViewing = vi.fn();
    render(<Harness initial={open} onViewing={onViewing} />);
    expect(onViewing.mock.calls.every(([v]) => v === null)).toBe(true);
    await advance(0);
    expect(onViewing).toHaveBeenLastCalledWith({ target: { personId: "p1" }, name: SELF.name, company: SELF.company });
    fireEvent.click(screen.getByRole("button", { name: /Contacts/ }));
    await advance(0);
    expect(onViewing).toHaveBeenLastCalledWith(null);
  });

  it("never reports a profile that failed to load or is missing", async () => {
    m.searchContacts.mockResolvedValue(hits());
    m.loadProfile.mockResolvedValue({ status: 404, body: { error: "Not found" } } as never);
    const onViewing = vi.fn();
    render(<Harness initial={open} onViewing={onViewing} />);
    await advance(0);
    expect(onViewing.mock.calls.every(([v]) => v === null)).toBe(true);
  });

  it("reports null when the estate changes under an open profile", async () => {
    m.searchContacts.mockResolvedValue(hits());
    m.loadProfile.mockResolvedValue(LOADED);
    const onViewing = vi.fn();
    const { rerender } = render(<Harness initial={open} onViewing={onViewing} />);
    await advance(0);
    rerender(<Harness initial={open} estate={OTHER} onViewing={onViewing} />);
    await advance(0);
    expect(onViewing).toHaveBeenLastCalledWith(null);
  });

  it("a new reload signal reads the list again when no profile is open", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    const { rerender } = render(<Harness reloadSignal={0} />);
    await advance(0);
    expect(m.searchContacts).toHaveBeenCalledTimes(1);
    rerender(<Harness reloadSignal={1} />);
    await advance(0);
    expect(m.searchContacts).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
  });

  it("keeps reporting the profile when a refresh fails and the old one stays on screen", async () => {
    m.searchContacts.mockResolvedValue(hits());
    m.loadProfile.mockResolvedValueOnce(LOADED);
    const onViewing = vi.fn();
    const { rerender } = render(<Harness initial={open} onViewing={onViewing} reloadSignal={0} />);
    await advance(0);
    m.loadProfile.mockResolvedValueOnce({ status: 500, body: { error: "x" } } as never);
    rerender(<Harness initial={open} onViewing={onViewing} reloadSignal={1} />);
    await advance(0);
    expect(screen.getByText("Could not refresh. Check signal.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Jane Tan" })).toBeInTheDocument();
    expect(onViewing).toHaveBeenLastCalledWith({ target: { personId: "p1" }, name: SELF.name, company: SELF.company });
  });

  it("a new reload signal reads the open profile again", async () => {
    m.searchContacts.mockResolvedValue(hits());
    m.loadProfile.mockResolvedValue(LOADED);
    const { rerender } = render(<Harness initial={open} reloadSignal={0} />);
    await advance(0);
    expect(m.loadProfile).toHaveBeenCalledTimes(1);
    rerender(<Harness initial={open} reloadSignal={1} />);
    await advance(0);
    expect(m.loadProfile).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Jane Tan" })).toBeInTheDocument();
  });
});

describe("ContactsPanel: imports", () => {
  const LINKEDIN = "LinkedIn import, Nov 2026";
  const IMPORTS = [
    { label: LINKEDIN, count: 120, at: "2026-11-25T10:00:00Z" },
    { label: "old crm import, Oct 2026", count: 2, at: "2026-10-02T10:00:00Z" },
  ];
  const imports = (list: unknown[] = IMPORTS) => ({ status: 200, body: { imports: list } }) as never;
  const imported = (contacts: unknown[], total?: number) => ({ status: 200, body: { contacts, total: total ?? contacts.length } }) as never;
  const picker = () => screen.queryByRole("combobox", { name: "Imports" });

  it("asks for the imports when the tab opens and offers nothing when there are none", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    m.loadImports.mockResolvedValue(imports([]));
    render(<Harness />);
    await advance(0);
    expect(m.loadImports).toHaveBeenCalledTimes(1);
    expect(m.loadImports).toHaveBeenCalledWith("traxo");
    expect(picker()).toBeNull();
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    expect(m.loadImportContacts).not.toHaveBeenCalled();
  });

  it("an imports list that will not load leaves the tab exactly as it was", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    m.loadImports.mockRejectedValue(new Error("net"));
    const onUnauthorized = vi.fn();
    const first = render(<Harness onUnauthorized={onUnauthorized} />);
    await advance(0);
    expect(picker()).toBeNull();
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(m.searchContacts).toHaveBeenCalledWith("traxo", "");
    first.unmount();

    m.loadImports.mockResolvedValue({ status: 502, body: { error: "Could not reach the Traxo CRM" } } as never);
    render(<Harness onUnauthorized={onUnauthorized} />);
    await advance(0);
    expect(picker()).toBeNull();
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("lists each import with its count; choosing one shows its contacts and says which, and Show all goes back", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    m.loadImports.mockResolvedValue(imports());
    m.loadImportContacts.mockResolvedValue(imported([FILED, LOOSE]));
    render(<Harness />);
    await advance(0);
    const select = picker() as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["All contacts", `${LINKEDIN} (120)`, "old crm import, Oct 2026 (2)"]);
    expect(select).toHaveValue("");
    expect(screen.queryByText(/^Showing:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();

    fireEvent.change(select, { target: { value: LINKEDIN } });
    await advance(0);
    expect(m.loadImportContacts).toHaveBeenCalledTimes(1);
    expect(m.loadImportContacts).toHaveBeenCalledWith("traxo", LINKEDIN, { high: false, sort: "recent" });
    expect(screen.getByRole("status")).toHaveTextContent(`Showing: ${LINKEDIN}`);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Raj Rao");
    expect(rows[1]).toHaveTextContent("Sam Lee");
    expect(screen.queryByText("Jane Tan")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Recent" })).toBeNull();
    // The search box searches every contact, so it is away while one import is shown.
    expect(screen.queryByRole("textbox", { name: "Search contacts" })).toBeNull();
    expect(screen.queryByText(/Showing the first/)).toBeNull();

    const before = m.searchContacts.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await advance(0);
    expect(m.searchContacts.mock.calls.length).toBe(before + 1);
    expect(m.searchContacts).toHaveBeenLastCalledWith("traxo", "");
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    expect(screen.queryByText(/^Showing:/)).toBeNull();
    expect(picker()).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Search contacts" })).toBeInTheDocument();
  });

  it("says so when an import has more contacts than are shown", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    m.loadImports.mockResolvedValue(imports());
    m.loadImportContacts.mockResolvedValue(imported([FILED, LOOSE], 120));
    render(<Harness initial={{ ...EMPTY_CONTACTS, importLabel: LINKEDIN }} />);
    await advance(0);
    expect(screen.getByText("Showing the first 2 of 120.")).toBeInTheDocument();
    expect(screen.queryByText(/Search to find the rest/)).toBeNull();
    // The list of everyone was never asked for.
    expect(m.searchContacts).not.toHaveBeenCalled();
    expect(picker()).toHaveValue(LINKEDIN);
  });

  it("High priority and the sorts work on the import that is shown", async () => {
    m.loadImports.mockResolvedValue(imports());
    m.loadImportContacts.mockResolvedValue(imported([FILED]));
    render(<Harness initial={{ ...EMPTY_CONTACTS, importLabel: LINKEDIN }} />);
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "High priority" }));
    await advance(0);
    expect(m.loadImportContacts).toHaveBeenLastCalledWith("traxo", LINKEDIN, { high: true, sort: "recent" });
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await advance(0);
    expect(m.loadImportContacts).toHaveBeenLastCalledWith("traxo", LINKEDIN, { high: true, sort: "stage" });
    m.loadImportContacts.mockResolvedValue(imported([]));
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    await advance(0);
    expect(screen.getByText("No high-priority contacts in this import.")).toBeInTheDocument();
    expect(m.searchContacts).not.toHaveBeenCalled();
  });

  it("a contact of an import opens like any other, and the import is still chosen on the way back", async () => {
    m.loadImports.mockResolvedValue(imports());
    m.loadImportContacts.mockResolvedValue(imported([LOOSE]));
    m.loadProfile.mockResolvedValue({ status: 502, body: { error: "x" } } as never);
    render(<Harness initial={{ ...EMPTY_CONTACTS, importLabel: LINKEDIN }} />);
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: /Sam Lee/ }));
    await advance(0);
    expect(m.loadProfile).toHaveBeenCalledWith("traxo", { personId: "p3" }, expect.any(String));
    fireEvent.click(screen.getByRole("button", { name: /Contacts/ }));
    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent(`Showing: ${LINKEDIN}`);
    expect(m.loadImportContacts).toHaveBeenCalledTimes(2);
  });

  it("a 401 or a failure on an import's contacts is handled as on the list", async () => {
    m.loadImports.mockResolvedValue(imports());
    m.loadImportContacts.mockResolvedValueOnce({ status: 502, body: { error: "x" } } as never);
    const onUnauthorized = vi.fn();
    render(<Harness onUnauthorized={onUnauthorized} initial={{ ...EMPTY_CONTACTS, importLabel: LINKEDIN }} />);
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load contacts. Check signal.");
    m.loadImportContacts.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } } as never);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await advance(0);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("another estate has its own imports, and the import chosen in the last one is dropped", async () => {
    m.searchContacts.mockResolvedValue(hits(SELF));
    m.loadImports.mockResolvedValue(imports());
    m.loadImportContacts.mockResolvedValue(imported([LOOSE]));
    const { rerender } = render(<Harness initial={{ ...EMPTY_CONTACTS, importLabel: LINKEDIN }} />);
    await advance(0);
    m.loadImports.mockResolvedValue(imports([]));
    rerender(<Harness estate={OTHER} initial={{ ...EMPTY_CONTACTS, importLabel: LINKEDIN }} />);
    await advance(0);
    expect(m.loadImports).toHaveBeenLastCalledWith("zeroone");
    expect(picker()).toBeNull();
    expect(screen.queryByText(/^Showing:/)).toBeNull();
    expect(m.searchContacts).toHaveBeenLastCalledWith("zeroone", "");
    expect(m.loadImportContacts).toHaveBeenCalledTimes(1);
  });
});
