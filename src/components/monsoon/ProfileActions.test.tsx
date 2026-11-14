// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProfileActions from "./ProfileActions";
import * as api from "./api";

vi.mock("./api", () => ({ proposeChange: vi.fn(), actOnCrm: vi.fn() }));
const m = vi.mocked(api);

const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", available: true, roles: [] };
const STAGES = [
  { key: "lead", label: "Lead", terminal: false },
  { key: "in_talks", label: "In talks", terminal: false },
  { key: "won", label: "Won", terminal: true },
];
const MEMBER = {
  memberId: "m1", memberKind: "person", role: "lp_prospect", stage: "in_talks", owner: "VF", priority: null,
  nextAction: null, nextActionDate: null, due: "later", notes: null,
};
const PERSON = {
  kind: "person", personId: "p1", orgId: "o1", name: "Jane Tan", title: "Partner", company: "Acme Capital",
  email: "jane@acme.com", phone: "+65 9123 4567", linkedin: null, country: "Singapore", website: "acme.com",
  notes: null, member: MEMBER, memberOf: "self", timelineOf: null, timeline: [], timelineTotal: 0, people: [], stages: STAGES,
};
const COMPANY = {
  ...PERSON, kind: "company", personId: null, orgId: "o1", name: "Acme Capital", title: null, company: null,
  email: null, phone: null, linkedin: null, member: { ...MEMBER, memberId: "m9", memberKind: "company" },
  people: [], website: "acme.com",
};

const NOTE_SIGNED = {
  proposal: {
    kind: "add_note", estate: "traxo", memberId: "m1", memberKind: "person", memberName: "Jane Tan",
    company: "Acme Capital", about: null, expires: 1,
  },
  signature: "sig-note",
  text: "Called her",
};
const STAGE_SIGNED = {
  proposal: {
    kind: "move_stage", estate: "traxo", memberId: "m1", memberKind: "person", memberName: "Jane Tan",
    company: "Acme Capital", about: null, fromStage: "in_talks", toStage: "won", expires: 1,
  },
  signature: "sig-stage",
};
const EDIT_SIGNED = {
  proposal: {
    kind: "update_details", estate: "traxo", target: { type: "person", id: "p1" }, targetName: "Jane Tan",
    company: "Acme Capital", changes: [{ field: "title", from: "Partner", to: "Founder" }, { field: "phone", from: "+65 9123 4567", to: null }],
    logMemberId: "m1", addsToPipeline: null, expires: 1,
  },
  signature: "sig-edit",
};

const proposed = (signed: unknown) => ({ status: 200, body: { ok: true, signed } }) as never;
const refused = (reason: string) => ({ status: 200, body: { ok: false, reason } }) as never;
const acted = (message: string) => ({ status: 200, body: { status: "updated", message } }) as never;

type User = ReturnType<typeof userEvent.setup>;
type Props = Partial<React.ComponentProps<typeof ProfileActions>>;
function view(profile: object = PERSON, props: Props = {}) {
  const handlers = { reload: vi.fn(), onUnauthorized: vi.fn(), onBusy: vi.fn(), onAsk: vi.fn() };
  const result = render(<ProfileActions estate={ESTATE} profile={profile as never} {...handlers} {...props} />);
  return { ...handlers, ...result };
}
const click = (user: User, name: string | RegExp) => user.click(screen.getByRole("button", { name }));

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("ProfileActions buttons", () => {
  it("shows Add note, Move stage and Edit, and Ask about this contact", () => {
    view();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Add note", "Move stage", "Edit", "Ask about this contact",
    ]);
  });

  it("hides Move stage when neither the contact nor its company is on the pipeline", () => {
    view({ ...PERSON, member: null, memberOf: null });
    expect(screen.queryByRole("button", { name: "Move stage" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add note" })).toBeInTheDocument();
  });

  it("keeps Move stage for a person filed under a company", () => {
    view({ ...PERSON, memberOf: "company" });
    expect(screen.getByRole("button", { name: "Move stage" })).toBeInTheDocument();
  });

  it("offers a company that is not on the pipeline only Edit", () => {
    view({ ...COMPANY, member: null, memberOf: null });
    expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move stage" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("Ask about this contact hands over the draft without sending anything", async () => {
    const user = userEvent.setup();
    const { onAsk } = view();
    await click(user, "Ask about this contact");
    expect(onAsk).toHaveBeenCalledWith("About Jane Tan: ");
    expect(m.proposeChange).not.toHaveBeenCalled();
  });
});

describe("Add note", () => {
  it("proposes with the member, shows the card, and Confirm sends the proposal, signature and text, then reloads", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue(proposed(NOTE_SIGNED));
    m.actOnCrm.mockResolvedValue(acted("Done. Note added to Jane Tan."));
    const { reload } = view();
    await click(user, "Add note");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.type(screen.getByPlaceholderText("Type or dictate a note"), "Called her");
    await click(user, "Continue");
    expect(m.proposeChange).toHaveBeenCalledWith({
      estate: "traxo", kind: "add_note", target: { memberId: "m1" }, text: "Called her",
    });
    expect(await screen.findByText("Jane Tan")).toBeInTheDocument();
    await click(user, "Confirm");
    expect(await screen.findByText("Done. Note added to Jane Tan.")).toBeInTheDocument();
    expect(m.actOnCrm).toHaveBeenCalledWith({
      estate: "traxo", proposal: NOTE_SIGNED.proposal, signature: "sig-note", text: "Called her",
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("addresses a person filed under a company by person id", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue(refused("nope"));
    view({ ...PERSON, memberOf: "company" });
    await click(user, "Add note");
    await user.type(screen.getByPlaceholderText("Type or dictate a note"), "Hi");
    await click(user, "Continue");
    expect(m.proposeChange.mock.calls[0][0].target).toEqual({ personId: "p1" });
  });

  it("addresses a company by its member", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue(refused("nope"));
    view(COMPANY);
    await click(user, "Add note");
    await user.type(screen.getByPlaceholderText("Type or dictate a note"), "Hi");
    await click(user, "Continue");
    expect(m.proposeChange.mock.calls[0][0].target).toEqual({ memberId: "m9" });
  });

  it("shows a refusal under the control", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue(refused("Jane is on file but not on the pipeline."));
    view();
    await click(user, "Add note");
    await user.type(screen.getByPlaceholderText("Type or dictate a note"), "Hi");
    await click(user, "Continue");
    expect(await screen.findByRole("alert")).toHaveTextContent("Jane is on file but not on the pipeline.");
    expect(screen.getByPlaceholderText("Type or dictate a note")).toHaveValue("Hi");
  });

  it("shows a failure when the request fails", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockRejectedValue(new Error("offline"));
    view();
    await click(user, "Add note");
    await user.type(screen.getByPlaceholderText("Type or dictate a note"), "Hi");
    await click(user, "Continue");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
  });

  it("asks for the passcode on a 401", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue({ status: 401, body: { error: "unauthorized" } } as never);
    const { onUnauthorized } = view();
    await click(user, "Add note");
    await user.type(screen.getByPlaceholderText("Type or dictate a note"), "Hi");
    await click(user, "Continue");
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });
});

describe("Move stage", () => {
  it("lists the profile's stages in order with the current one disabled, and picking one proposes", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue(proposed(STAGE_SIGNED));
    view();
    await click(user, "Move stage");
    const labels = ["Lead", "In talks Current", "Won"];
    const list = labels.map((l) => screen.getByRole("button", { name: l }));
    expect(list[1]).toBeDisabled();
    await user.click(list[2]);
    expect(m.proposeChange).toHaveBeenCalledWith({
      estate: "traxo", kind: "move_stage", target: { memberId: "m1" }, stage: "won",
    });
    expect(await screen.findByText("in talks → won")).toBeInTheDocument();
  });
});

describe("Edit", () => {
  it("shows the person fields filled from the profile and sends only what changed", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue(proposed(EDIT_SIGNED));
    view();
    await click(user, "Edit");
    for (const label of ["Name", "Title", "Company", "Email", "Phone", "LinkedIn", "Country"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText("Website")).toBeNull();
    expect(screen.getByLabelText("Title")).toHaveValue("Partner");
    expect(screen.getByLabelText("LinkedIn")).toHaveValue("");
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Founder");
    await user.clear(screen.getByLabelText("Phone"));
    await click(user, "Review changes");
    expect(m.proposeChange).toHaveBeenCalledWith({
      estate: "traxo", kind: "update_details", target: { personId: "p1" }, changes: { title: "Founder", phone: "" },
    });
    expect(await screen.findByText("Edit details")).toBeInTheDocument();
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("does not call the server when nothing differs, and Cancel closes the editor", async () => {
    const user = userEvent.setup();
    view();
    await click(user, "Edit");
    await click(user, "Review changes");
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing to change.");
    expect(m.proposeChange).not.toHaveBeenCalled();
    await click(user, "Cancel");
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("edits a company's website and country by org id", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue(refused("x"));
    view(COMPANY);
    await click(user, "Edit");
    expect(screen.getByLabelText("Website")).toHaveValue("acme.com");
    expect(screen.queryByLabelText("Name")).toBeNull();
    await user.clear(screen.getByLabelText("Country"));
    await user.type(screen.getByLabelText("Country"), "SG");
    await click(user, "Review changes");
    expect(m.proposeChange).toHaveBeenCalledWith({
      estate: "traxo", kind: "update_details", target: { orgId: "o1" }, changes: { country: "SG" },
    });
  });

  it("shows a refusal, and offers It's a different company for the lookalike reason, re-sending with newCompany", async () => {
    const user = userEvent.setup();
    const reason = "Acme Cap looks like Acme Capital, already on file. Use that name, or say it is a different company.";
    m.proposeChange.mockResolvedValueOnce(refused("Another Jane Tan is already on file there."));
    view();
    await click(user, "Edit");
    await user.clear(screen.getByLabelText("Company"));
    await user.type(screen.getByLabelText("Company"), "Acme Cap");
    await click(user, "Review changes");
    expect(await screen.findByRole("alert")).toHaveTextContent("Another Jane Tan is already on file there.");
    expect(screen.queryByRole("button", { name: "It's a different company" })).toBeNull();

    m.proposeChange.mockResolvedValueOnce(refused(reason));
    await click(user, "Review changes");
    expect(await screen.findByText(reason)).toBeInTheDocument();
    m.proposeChange.mockResolvedValueOnce(proposed(EDIT_SIGNED));
    await click(user, "It's a different company");
    expect(m.proposeChange).toHaveBeenLastCalledWith({
      estate: "traxo", kind: "update_details", target: { personId: "p1" }, changes: { company: "Acme Cap" }, newCompany: true,
    });
    expect(await screen.findByText("Edit details")).toBeInTheDocument();
  });
});

describe("the change card", () => {
  async function openEditCard(user: User, signed: unknown = EDIT_SIGNED, props: Props = {}) {
    m.proposeChange.mockResolvedValue(proposed(signed));
    const v = view(PERSON, props);
    await click(user, "Edit");
    await user.type(screen.getByLabelText("Title"), "x");
    await click(user, "Review changes");
    await screen.findByText("Edit details");
    return v;
  }

  it("shows the contact, one line per change, and Confirm and Cancel", async () => {
    const user = userEvent.setup();
    await openEditCard(user);
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    expect(screen.getByText("Acme Capital")).toBeInTheDocument();
    expect(screen.getByText("Title: Partner → Founder")).toBeInTheDocument();
    expect(screen.getByText("Phone: +65 9123 4567 → (empty)")).toBeInTheDocument();
    expect(screen.queryByText(/also adds/)).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows the adds-to-pipeline line with the role's underscores as spaces", async () => {
    const user = userEvent.setup();
    const signed = { ...EDIT_SIGNED, proposal: { ...EDIT_SIGNED.proposal, addsToPipeline: "fund_manager" } };
    await openEditCard(user, signed);
    expect(screen.getByText("This also adds Jane Tan to the pipeline as fund manager.")).toBeInTheDocument();
  });

  it("Confirm sends the proposal and signature, shows the message, reloads, and cannot be confirmed again", async () => {
    const user = userEvent.setup();
    m.actOnCrm.mockResolvedValue(acted("Done. Jane Tan updated."));
    const { reload } = await openEditCard(user);
    await click(user, "Confirm");
    expect(await screen.findByText("Done. Jane Tan updated.")).toBeInTheDocument();
    expect(m.actOnCrm).toHaveBeenCalledWith({ estate: "traxo", proposal: EDIT_SIGNED.proposal, signature: "sig-edit" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("a double tap sends once", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    m.actOnCrm.mockImplementationOnce(() => new Promise((r) => (resolve = r as never)));
    await openEditCard(user);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    await user.dblClick(confirm);
    expect(m.actOnCrm).toHaveBeenCalledTimes(1);
    resolve(acted("Done."));
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(m.actOnCrm).toHaveBeenCalledTimes(1);
  });

  it("a 403 marks it expired and removes Confirm", async () => {
    const user = userEvent.setup();
    m.actOnCrm.mockResolvedValue({ status: 403, body: { error: "expired" } } as never);
    const { reload } = await openEditCard(user);
    await click(user, "Confirm");
    expect(await screen.findByRole("alert")).toHaveTextContent("This change has expired. Ask again.");
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("a failure leaves it open to try again", async () => {
    const user = userEvent.setup();
    m.actOnCrm.mockRejectedValueOnce(new Error("offline"));
    await openEditCard(user);
    await click(user, "Confirm");
    expect(await screen.findByText("Could not save. Check signal and try again.")).toBeInTheDocument();
    m.actOnCrm.mockResolvedValueOnce(acted("Done."));
    await click(user, "Confirm");
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(m.actOnCrm).toHaveBeenCalledTimes(2);
  });

  it("a 401 reopens the card and asks for the passcode", async () => {
    const user = userEvent.setup();
    m.actOnCrm.mockResolvedValue({ status: 401, body: { error: "unauthorized" } } as never);
    const { onUnauthorized } = await openEditCard(user);
    await click(user, "Confirm");
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  it("shows a partly-applied message as the server words it", async () => {
    const user = userEvent.setup();
    const msg = "Updated Title. Phone changed in the meantime and was left alone.";
    m.actOnCrm.mockResolvedValue(acted(msg));
    await openEditCard(user);
    await click(user, "Confirm");
    expect(await screen.findByText(msg)).toBeInTheDocument();
  });

  it("Cancel closes the card without sending", async () => {
    const user = userEvent.setup();
    await openEditCard(user);
    await click(user, "Cancel");
    expect(await screen.findByText("Cancelled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(m.actOnCrm).not.toHaveBeenCalled();
  });

  it("a second proposal replaces the finished card", async () => {
    const user = userEvent.setup();
    m.actOnCrm.mockResolvedValue(acted("Done. Jane Tan updated."));
    await openEditCard(user);
    await click(user, "Confirm");
    await screen.findByText("Done. Jane Tan updated.");
    m.proposeChange.mockResolvedValue(proposed(STAGE_SIGNED));
    await click(user, "Move stage");
    await click(user, "Won");
    expect(await screen.findByText("in talks → won")).toBeInTheDocument();
    expect(screen.queryByText("Done. Jane Tan updated.")).toBeNull();
    expect(screen.queryByText("Edit details")).toBeNull();
  });

  it("an add-note card carries the note's text into the confirm request", async () => {
    const user = userEvent.setup();
    m.proposeChange.mockResolvedValue(proposed({ ...NOTE_SIGNED, text: undefined }));
    m.actOnCrm.mockResolvedValue(acted("Done."));
    view();
    await click(user, "Add note");
    await user.type(screen.getByPlaceholderText("Type or dictate a note"), "Fresh");
    await click(user, "Continue");
    await click(user, "Confirm");
    await screen.findByText("Done.");
    expect(m.actOnCrm.mock.calls[0][0].text).toBe("Fresh");
  });
});

describe("busy reporting", () => {
  it("reports busy while proposing and while confirming, and releases after each", async () => {
    const user = userEvent.setup();
    let resolveProposal!: (v: never) => void;
    let resolveAct!: (v: never) => void;
    m.proposeChange.mockImplementationOnce(() => new Promise((r) => (resolveProposal = r as never)));
    m.actOnCrm.mockImplementationOnce(() => new Promise((r) => (resolveAct = r as never)));
    const { onBusy } = view();
    expect(onBusy).toHaveBeenLastCalledWith(false);
    await click(user, "Edit");
    await user.type(screen.getByLabelText("Title"), "x");
    await click(user, "Review changes");
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask about this contact" })).toBeDisabled();
    resolveProposal(proposed(EDIT_SIGNED));
    await screen.findByText("Edit details");
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
    await click(user, "Confirm");
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true));
    resolveAct(acted("Done."));
    await screen.findByText("Done.");
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
  });

  it("releases when the view closes mid-request, and drops the late result", async () => {
    const user = userEvent.setup();
    let resolveProposal!: (v: never) => void;
    m.proposeChange.mockImplementationOnce(() => new Promise((r) => (resolveProposal = r as never)));
    const { onBusy, unmount } = view();
    await click(user, "Edit");
    await user.type(screen.getByLabelText("Title"), "x");
    await click(user, "Review changes");
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true));
    unmount();
    expect(onBusy).toHaveBeenLastCalledWith(false);
    resolveProposal(proposed(EDIT_SIGNED));
    await Promise.resolve();
  });
});
