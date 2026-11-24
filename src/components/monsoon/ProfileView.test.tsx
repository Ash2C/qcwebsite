// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProfileView, { phoneSegments } from "./ProfileView";
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

const BASE = {
  kind: "person", personId: "p1", orgId: "o1", name: "Jane Tan", title: "Partner", company: "Acme Capital",
  email: "jane@acme.com", phone: "+65 9123 4567", linkedin: "linkedin.com/in/jane", country: "Singapore",
  website: "acme.com", notes: "Own notes here", member: null, memberOf: null, timelineOf: null,
  timeline: [], timelineTotal: 0, people: [],
};
const MEMBER = {
  memberId: "m1", memberKind: "person", role: "lp_prospect", stage: "in_talks", owner: "VF", priority: null,
  nextAction: "Send deck", nextActionDate: "2026-11-20", due: "later", notes: "Member notes here",
};

// Timestamps at local noon, and the expected text built from local-date getters, so the test does
// not depend on the machine's timezone.
const NOON_13 = new Date(2026, 10, 13, 12).toISOString();
const NOON_1 = new Date(2026, 10, 1, 12).toISOString();
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function localLabel(iso: string) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTH[d.getMonth()]} ${d.getFullYear()}`;
}

function profile(over: Record<string, unknown> = {}) {
  return { status: 200, body: { profile: { ...BASE, ...over } } } as never;
}

type Props = Partial<React.ComponentProps<typeof ProfileView>>;
function view(props: Props = {}) {
  const handlers = { onBack: vi.fn(), onOpen: vi.fn(), onUnauthorized: vi.fn() };
  render(<ProfileView estate={ESTATE} target={{ personId: "p1" }} {...handlers} {...props} />);
  return handlers;
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("ProfileView", () => {
  it("the type, stage and priority bubbles each open their chooser under the name, one at a time", async () => {
    m.loadProfile.mockResolvedValue(profile({ member: MEMBER, memberOf: "self" }));
    const roles = [{ key: "lp_prospect", label: "LP prospect" }, { key: "introducer", label: "Introducer" }];
    view({
      estate: { ...ESTATE, roles },
      actions: (_profile, _reload, _busy, pick) => <div data-testid="acts">{`${String(pick.open)}${pick.slot ? " with slot" : ""}`}</div>,
    });
    await flush();
    const acts = screen.getByTestId("acts");
    expect(acts).toHaveTextContent("null with slot");
    const stage = screen.getByRole("button", { name: "Stage: In talks. Change stage" });
    fireEvent.click(stage);
    expect(acts).toHaveTextContent("stage");
    expect(stage).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "No priority. Change priority" }));
    expect(acts).toHaveTextContent("priority");
    expect(stage).toHaveAttribute("aria-expanded", "false");
    const type = screen.getByRole("button", { name: "Type: LP prospect. Change type" });
    fireEvent.click(type);
    expect(acts).toHaveTextContent("role");
    fireEvent.click(type);
    expect(acts).toHaveTextContent("null");
  });

  it("the next action is a row to tap: it shows what is set, or that none is, and opens its form there", async () => {
    m.loadProfile.mockResolvedValue(profile({ member: MEMBER, memberOf: "self" }));
    const first = view({ actions: (_p, _r, _b, pick) => <div data-testid="acts">{`${String(pick.open)}${pick.slot ? " with slot" : ""}`}</div> });
    await flush();
    const row = screen.getByRole("button", { name: "Next action: Send deck, due 20 Nov 2026. Change next action" });
    expect(row).toHaveTextContent("Send deck · due 20 Nov 2026");
    fireEvent.click(row);
    expect(screen.getByTestId("acts")).toHaveTextContent("next with slot");
    expect(first.onBack).not.toHaveBeenCalled();
    cleanup();

    m.loadProfile.mockResolvedValue(profile({ member: { ...MEMBER, nextAction: null, nextActionDate: null }, memberOf: "self" }));
    view({ actions: () => null });
    await flush();
    expect(screen.getByRole("button", { name: "Next action: none set. Set next action" })).toHaveTextContent("None set. Tap to add one.");
  });

  it("an estate with one contact type shows the type as plain text; the priority bubble names the priority", async () => {
    m.loadProfile.mockResolvedValue(profile({ member: { ...MEMBER, priority: "high" }, memberOf: "self" }));
    view({ estate: { ...ESTATE, roles: [{ key: "lp_prospect", label: "LP prospect" }] }, actions: () => null });
    await flush();
    expect(screen.queryByRole("button", { name: /Change type/ })).toBeNull();
    expect(screen.getByText("LP prospect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "High priority. Change priority" })).toBeInTheDocument();
  });

  it("shows Loading first, then a person on the pipeline", async () => {
    m.loadProfile.mockResolvedValue(profile({ member: MEMBER, memberOf: "self" }));
    view();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await flush();
    expect(screen.getByRole("heading", { name: "Jane Tan" })).toBeInTheDocument();
    expect(screen.getByText("LP prospect")).toBeInTheDocument();
    expect(screen.getByText("In talks")).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByText("Send deck · due 20 Nov 2026")).toBeInTheDocument();
    expect(screen.getByText("Member notes here")).toBeInTheDocument();
    expect(screen.getByText("Own notes here")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByText("No timeline yet.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "People" })).toBeNull();
  });

  it("shows the stage's label from the profile's stages, else the key as words", async () => {
    m.loadProfile.mockResolvedValue(
      profile({ member: MEMBER, memberOf: "self", stages: [{ key: "in_talks", label: "Talking now", terminal: false }] }),
    );
    view();
    await flush();
    expect(screen.getByText("Talking now")).toBeInTheDocument();
    expect(screen.queryByText("In talks")).toBeNull();
    cleanup();
    m.loadProfile.mockResolvedValue(profile({ member: MEMBER, memberOf: "self", stages: [] }));
    view();
    await flush();
    expect(screen.getByText("In talks")).toBeInTheDocument();
  });

  it("falls back to the role key with spaces when the estate has no label", async () => {
    m.loadProfile.mockResolvedValue(profile({ member: { ...MEMBER, role: "fund_manager" }, memberOf: "self" }));
    view();
    await flush();
    expect(screen.getByText("fund manager")).toBeInTheDocument();
  });

  it("the company is tappable and opens the company", async () => {
    m.loadProfile.mockResolvedValue(profile());
    const h = view();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Acme Capital" }));
    expect(h.onOpen).toHaveBeenCalledWith({ orgId: "o1" });
  });

  it("a person under a company: filed under, company timeline heading, clipped line, author", async () => {
    m.loadProfile.mockResolvedValue(
      profile({
        member: { ...MEMBER, role: "lp_prospect", stage: "lead" },
        memberOf: "company",
        timelineOf: "Acme Capital",
        timeline: [
          { at: NOON_13, kind: "note", by: "VF", summary: "Called <b>Jane</b>" },
          { at: NOON_1, kind: "system", by: null, summary: "Moved" },
        ],
        timelineTotal: 75,
      }),
    );
    view();
    await flush();
    expect(screen.getByText("filed under Acme Capital")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Timeline of Acme Capital" })).toBeInTheDocument();
    expect(screen.getByText(`${localLabel(NOON_13)} · note · Called <b>Jane</b>`)).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("by VF")).toBeInTheDocument();
    expect(screen.getByText(`${localLabel(NOON_1)} · system · Moved`)).toBeInTheDocument();
    expect(screen.getAllByText(/^by /)).toHaveLength(1);
    expect(screen.getByText("Showing 2 of 75")).toBeInTheDocument();
  });

  it("a person not on the pipeline", async () => {
    m.loadProfile.mockResolvedValue(profile({ email: null, phone: null, linkedin: null, country: null, website: null, notes: null }));
    view();
    await flush();
    expect(screen.getByText("Not on the pipeline")).toBeInTheDocument();
    expect(screen.getAllByText("(none)")).toHaveLength(5);
    expect(screen.queryByRole("heading", { name: "Notes" })).toBeNull();
    expect(screen.queryByText(/^Next/)).toBeNull();
  });

  it("a company shows its people, and tapping one opens that person", async () => {
    m.loadProfile.mockResolvedValue(
      profile({
        kind: "company", personId: null, name: "Acme Capital", title: null, company: null,
        people: [{ personId: "p9", name: "Raj Rao", title: "CIO", email: null, phone: null }],
      }),
    );
    const h = view({ target: { orgId: "o1" } });
    await flush();
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Raj Rao/ }));
    expect(h.onOpen).toHaveBeenCalledWith({ personId: "p9" });
  });

  it("builds mailto, tel and web links safely", async () => {
    m.loadProfile.mockResolvedValue(profile());
    view();
    await flush();
    expect(screen.getByRole("link", { name: "jane@acme.com" })).toHaveAttribute("href", "mailto:jane@acme.com");
    const tel = screen.getByRole("link", { name: "+65 9123 4567" });
    expect(tel).toHaveAttribute("href", "tel:+6591234567");
    const li = screen.getByRole("link", { name: "linkedin.com/in/jane" });
    expect(li).toHaveAttribute("href", "https://linkedin.com/in/jane");
    expect(li).toHaveAttribute("target", "_blank");
    expect(li).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.getByRole("link", { name: "acme.com" })).toHaveAttribute("href", "https://acme.com/");
  });

  it("does not link an email that could carry extra recipients or a body", async () => {
    m.loadProfile.mockResolvedValue(profile({ email: "a@b.com?bcc=x@evil.com&body=hi" }));
    view();
    await flush();
    expect(screen.getByText("a@b.com?bcc=x@evil.com&body=hi")).toBeInTheDocument();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it.each(['a"b@c.com', "a<b>@c.com", "a b@c.com", "a@b@c.com", "a@b.com,c@d.com"])("does not link the email %s", async (email) => {
    m.loadProfile.mockResolvedValue(profile({ email }));
    view();
    await flush();
    expect(screen.getByText(email)).toBeInTheDocument();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it.each([
    ["+65 6123 4567", ["tel:+6561234567"]],
    ["212-675-1600", ["tel:2126751600"]],
    ["+1 212-970-5762 (office); +1 973-558-0598 (mobile)", ["tel:+12129705762", "tel:+19735580598"]],
    ["Office 212-675-1600, mobile 646-404-4166", ["tel:2126751600", "tel:6464044166"]],
    ["212-675-1600, 646-404-4166", ["tel:2126751600", "tel:6464044166"]],
    ["212-675-1600 or 646-404-4166", ["tel:2126751600", "tel:6464044166"]],
    ["212-675-1600 x123", ["tel:2126751600"]],
    ["212-675-1600 ext. 1234567", ["tel:2126751600"]],
    ["(212) 675-1600", ["tel:2126751600"]],
    ["+44 (0)20 7946 0958", ["tel:+442079460958"]],
    ["+44(0)20 7946 0958", ["tel:+442079460958"]],
    ["+65 (0) 6123 4567", ["tel:+6561234567"]],
    ["(0)20 7946 0958", ["tel:02079460958"]],
    ["212-675-1600 646-404-4166", ["tel:2126751600", "tel:6464044166"]],
    ["+1 212 970 5762 646 404 4166", ["tel:+12129705762", "tel:6464044166"]],
    ["(212) 675-1600 (646) 404-4166", ["tel:2126751600", "tel:6464044166"]],
    ["+65 6123 4567 +65 6123 4568", ["tel:+6561234567", "tel:+6561234568"]],
    ["212 675 1600", ["tel:2126751600"]],
    ["212-675-1600 - 123", ["tel:2126751600"]],
    ["+852 - 2345 - 6789", ["tel:+85223456789"]],
    ["+1 212 - 970 - 5762", ["tel:+12129705762"]],
    ["+44 20 7946 - 0958", ["tel:+442079460958"]],
    ["+91 22 5550 - 1212", ["tel:+912255501212"]],
    ["(+44) (0)20 7946 0958", ["tel:+442079460958"]],
    ["+65 6123 4567 - 12345", ["tel:+6561234567"]],
    ["212-675-1600 - 12 and 646-404-4166", ["tel:2126751600", "tel:6464044166"]],
    ["call 212-675-1600 - 123, 646-404-4166", ["tel:2126751600", "tel:6464044166"]],
    ["123?x&y", []],
    ["call the front desk", []],
    ["12345678901234567890", []],
  ])("phone %j links exactly %j and shows the stored text", async (phone, hrefs) => {
    m.loadProfile.mockResolvedValue(profile({ phone }));
    view();
    await flush();
    const links = Array.from(document.querySelectorAll('a[href^="tel:"]'));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(hrefs);
    const dd = screen.getByText("Phone").parentElement!.querySelector("dd")!;
    expect(dd.textContent).toBe(phone);
  });

  it("drops a (0) after the country code from the dialled number, keeping the visible text", async () => {
    m.loadProfile.mockResolvedValue(profile({ phone: "+44 (0)20 7946 0958" }));
    view();
    await flush();
    const link = document.querySelector('a[href^="tel:"]')!;
    expect(link.getAttribute("href")).toBe("tel:+442079460958");
    expect(link.textContent).toBe("+44 (0)20 7946 0958");
    expect(screen.getByText("Phone").parentElement!.querySelector("dd")!.textContent).toBe("+44 (0)20 7946 0958");
  });

  it("locks Back, the company link and the People rows while an action is in flight, and unlocks after", async () => {
    m.loadProfile.mockResolvedValue(
      profile({ kind: "company", personId: null, people: [{ personId: "p9", name: "Raj Rao", title: "CIO", email: null, phone: null }] }),
    );
    let setBusy: (b: boolean) => void = () => {};
    const h = view({
      actions: (_p, _r, s) => {
        setBusy = s;
        return null;
      },
    });
    await flush();
    const back = screen.getByRole("button", { name: "‹ Contacts" });
    const row = screen.getByRole("button", { name: /Raj Rao/ });
    expect(back).toBeEnabled();
    expect(row).toBeEnabled();
    await act(async () => setBusy(true));
    expect(back).toBeDisabled();
    expect(row).toBeDisabled();
    fireEvent.click(back);
    fireEvent.click(row);
    expect(h.onBack).not.toHaveBeenCalled();
    expect(h.onOpen).not.toHaveBeenCalled();
    await act(async () => setBusy(false));
    expect(back).toBeEnabled();
    expect(row).toBeEnabled();
  });

  it("locks the company link of a person while an action is in flight", async () => {
    m.loadProfile.mockResolvedValue(profile());
    let setBusy: (b: boolean) => void = () => {};
    const h = view({
      actions: (_p, _r, s) => {
        setBusy = s;
        return null;
      },
    });
    await flush();
    await act(async () => setBusy(true));
    expect(screen.getByRole("button", { name: "Acme Capital" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Acme Capital" }));
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("ignores a response that arrives after the view closed", async () => {
    let resolveProfile!: (v: never) => void;
    m.loadProfile.mockImplementationOnce(() => new Promise((r) => (resolveProfile = r as never)));
    const h = view();
    cleanup();
    await act(async () => resolveProfile({ status: 401, body: { error: "unauthorized" } } as never));
    expect(h.onUnauthorized).not.toHaveBeenCalled();
  });

  it("keeps an extension as text after the link", async () => {
    m.loadProfile.mockResolvedValue(profile({ phone: "212-675-1600 x123" }));
    view();
    await flush();
    expect(screen.getByRole("link", { name: "212-675-1600" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "212-675-1600" }).nextSibling?.textContent).toBe(" x123");
  });

  it("keeps the profile and offers Retry when a reload fails", async () => {
    m.loadProfile.mockResolvedValueOnce(profile()).mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce(profile());
    let reload: () => void = () => {};
    view({
      actions: (_p, r) => {
        reload = r;
        return null;
      },
    });
    await flush();
    await act(async () => reload());
    expect(screen.getByRole("heading", { name: "Jane Tan" })).toBeInTheDocument();
    expect(screen.getByText("Could not refresh. Check signal.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.queryByText("Could not refresh. Check signal.")).toBeNull();
    expect(m.loadProfile).toHaveBeenCalledTimes(3);
  });

  it("does not link a javascript: LinkedIn value or other non-http schemes", async () => {
    m.loadProfile.mockResolvedValue(profile({ linkedin: "javascript:alert(1)", website: "ftp://files.example.com" }));
    view();
    await flush();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "javascript:alert(1)" })).toBeNull();
    expect(screen.getByText("ftp://files.example.com")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ftp://files.example.com" })).toBeNull();
  });

  it("renders the actions slot between details and notes", async () => {
    m.loadProfile.mockResolvedValue(profile());
    view({ actions: (p) => <div data-testid="slot">{p.name}</div> });
    await flush();
    const slot = screen.getByTestId("slot");
    expect(slot).toHaveTextContent("Jane Tan");
    const details = screen.getByText("Country");
    const notes = screen.getByRole("heading", { name: "Notes" });
    expect(details.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("not found shows the message and a working back control", async () => {
    m.loadProfile.mockResolvedValue({ status: 404, body: { error: "Not found" } } as never);
    const h = view();
    await flush();
    expect(screen.getByText("That contact is no longer on file.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹ Contacts" }));
    expect(h.onBack).toHaveBeenCalled();
  });

  it("failure shows Retry, which loads again", async () => {
    m.loadProfile.mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce(profile());
    view();
    await flush();
    expect(screen.getByText("Could not load this contact. Check signal.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.getByRole("heading", { name: "Jane Tan" })).toBeInTheDocument();
  });

  it("calls onUnauthorized on a 401", async () => {
    m.loadProfile.mockResolvedValue({ status: 401, body: { error: "unauthorized" } } as never);
    const h = view();
    await flush();
    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("passes a reload to the actions slot that fetches again", async () => {
    m.loadProfile.mockResolvedValue(profile());
    let reload: () => void = () => {};
    view({
      actions: (_p, r) => {
        reload = r;
        return null;
      },
    });
    await flush();
    await act(async () => reload());
    expect(m.loadProfile).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Jane Tan" })).toBeInTheDocument();
  });
});

describe("phoneSegments", () => {
  it("only ever links an optional + and 7 to 15 digits, keeps the stored text whole, and stays fast", () => {
    // A small seeded generator: the same inputs every run.
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = ["0", "1", "2", "7", "9", "9", " ", " ", " ", "-", "(", ")", ".", "+", "x", "a", ",", "\t", " - "];
    for (let n = 0; n < 3000; n++) {
      let value = "";
      const len = 1 + Math.floor(next() * 40);
      for (let i = 0; i < len; i++) value += alphabet[Math.floor(next() * alphabet.length)];
      const segments = phoneSegments(value);
      expect(segments.map((s) => s.text).join("")).toBe(value);
      for (const s of segments) if (s.href !== null) expect(s.href).toMatch(/^tel:\+?\d{7,15}$/);
    }
    const hostile = ["1 ".repeat(50_000), "1-".repeat(50_000) + "x", " ".repeat(50_000) + "1", "(0)".repeat(20_000), "1 - ".repeat(20_000)];
    const started = Date.now();
    for (const value of hostile) expect(phoneSegments(value).map((s) => s.text).join("")).toBe(value);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
