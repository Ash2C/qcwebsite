// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContactsPanel, { EMPTY_CONTACTS, type ContactsState } from "./ContactsPanel";
import * as api from "./api";

vi.mock("./api", () => ({ searchContacts: vi.fn(), loadProfile: vi.fn() }));
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
}: {
  onUnauthorized?: () => void;
  estate?: typeof ESTATE;
  initial?: ContactsState;
}) {
  const [state, setState] = useState<ContactsState>(initial);
  return <ContactsPanel estate={estate} state={state} onChange={setState} onUnauthorized={onUnauthorized} />;
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
