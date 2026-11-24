// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserPage } from "@/lib/monsoon/accounts/profile";
import * as api from "./api";
import { shortDay } from "./ContactsPanel";
import UserPanel, { EMPTY_USER_DRAFT, type UserDraft } from "./UserPanel";

vi.mock("./api", () => ({
  loadUserPage: vi.fn(),
  saveUserPage: vi.fn(),
  addUserNote: vi.fn(),
  loadGranolaKey: vi.fn(),
  saveGranolaKey: vi.fn(),
  testGranolaKey: vi.fn(),
  disconnectGranolaKey: vi.fn(),
}));
const m = vi.mocked(api);

const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", available: true, roles: [] };
const PAGE: UserPage = {
  person: { name: "Dana Lee", phone: "+31 6 1234 5678", email: null },
  work: { company: "Acme Ltd", website: null, roleObjectives: "Partner.\nRaise the next fund." },
  notes: [
    { id: "n2", body: "Prefers short answers.", at: "2026-11-20T09:00:00Z" },
    { id: "n1", body: "Back from leave\nin January.", at: "2025-03-02T09:00:00Z" },
  ],
  notesTotal: 2,
};
const reply = (page: UserPage) => ({ status: 200, body: { page } }) as never;
const GRANOLA_OFF = { status: "missing" as const, last4: null, setAt: null, checkedAt: null };
const GRANOLA_ON = { status: "ok" as const, last4: "4f2A", setAt: "2025-03-02T09:00:00Z", checkedAt: "2025-03-05T09:00:00Z" };
const granola = (key: object) => ({ status: 200, body: { key } }) as never;

let onBack: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn>;
let onName: ReturnType<typeof vi.fn>;
let drafts: UserDraft[];
const lastDraft = () => drafts[drafts.length - 1];

// The draft lives in the parent, as it does in MonsoonApp.
function Harness({ start }: { start: UserDraft }) {
  const [draft, setDraft] = React.useState(start);
  return (
    <UserPanel
      estate={ESTATE}
      draft={draft}
      onDraft={(d) => {
        drafts.push(d);
        setDraft(d);
      }}
      onBack={onBack}
      onUnauthorized={onUnauthorized}
      onName={onName}
    />
  );
}

async function view(start: UserDraft = EMPTY_USER_DRAFT) {
  render(<Harness start={start} />);
  await screen.findByRole("heading", { name: "You" });
}

beforeEach(() => {
  vi.resetAllMocks();
  onBack = vi.fn();
  onUnauthorized = vi.fn();
  onName = vi.fn();
  drafts = [];
  m.loadUserPage.mockResolvedValue(reply(PAGE));
  m.loadGranolaKey.mockResolvedValue(granola(GRANOLA_OFF));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UserPanel", () => {
  it("loads the page for the estate and shows the notice, the three headings, the fields and the notes", async () => {
    await view();
    expect(m.loadUserPage).toHaveBeenCalledWith("traxo");
    expect(screen.getByText("Monsoon's assistant reads this page to make its answers fit you.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your work in Traxo" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notes about you" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Dana Lee");
    expect(screen.getByLabelText("Phone")).toHaveValue("+31 6 1234 5678");
    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(screen.getByLabelText("Company")).toHaveValue("Acme Ltd");
    expect(screen.getByLabelText("Website")).toHaveValue("");
    expect(screen.getByLabelText("Role and objectives")).toHaveValue("Partner.\nRaise the next fund.");
    expect(screen.getByLabelText("New note")).toHaveValue("");
    const notes = within(screen.getByRole("list", { name: "Your notes" })).getAllByRole("listitem");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent("Prefers short answers.");
    expect(notes[0]).toHaveTextContent(shortDay("2026-11-20T09:00:00Z"));
    expect(notes[1]).toHaveTextContent(shortDay("2025-03-02T09:00:00Z"));
    expect(screen.getByText("2 notes")).toBeInTheDocument();
  });

  it("says how many notes there are when not all are listed, and when there are none", async () => {
    m.loadUserPage.mockResolvedValue(reply({ ...PAGE, notesTotal: 73 }));
    await view();
    expect(screen.getByText("The 2 newest of 73 notes")).toBeInTheDocument();
    cleanup();
    m.loadUserPage.mockResolvedValue(reply({ ...PAGE, notes: [], notesTotal: 0 }));
    await view();
    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Your notes" })).toBeNull();
  });

  it("every text box is at least 16px, so the phone does not zoom in", async () => {
    await view();
    for (const label of ["Name", "Phone", "Email", "Company", "Website", "Role and objectives", "New note"]) {
      expect(screen.getByLabelText(label).className).toMatch(/text-\[1[6-9]px\]/);
    }
  });

  it("Save is off until a field changes, sends the edited page, shows what was saved and reports the new name", async () => {
    const user = userEvent.setup();
    await view();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Dana L.");
    await user.type(screen.getByLabelText("Email"), "dana@acme.example");
    await user.clear(screen.getByLabelText("Company"));
    expect(save).toBeEnabled();
    const saved: UserPage = {
      ...PAGE,
      person: { name: "Dana L.", phone: "+31 6 1234 5678", email: "dana@acme.example" },
      work: { ...PAGE.work, company: null },
    };
    m.saveUserPage.mockResolvedValue(reply(saved));
    await user.click(save);
    expect(m.saveUserPage).toHaveBeenCalledWith("traxo", {
      name: "Dana L.",
      phone: "+31 6 1234 5678",
      email: "dana@acme.example",
      company: null,
      website: null,
      roleObjectives: "Partner.\nRaise the next fund.",
    });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(onName).toHaveBeenCalledWith("Dana L.");
    expect(screen.getByLabelText("Name")).toHaveValue("Dana L.");
    expect(screen.getByLabelText("Company")).toHaveValue("");
    expect(lastDraft().fields).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("an edit put back to what is on file leaves Save off", async () => {
    const user = userEvent.setup();
    await view();
    await user.type(screen.getByLabelText("Name"), "x");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.type(screen.getByLabelText("Name"), "{Backspace}");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("a refused save shows the server's message and keeps the edits", async () => {
    const user = userEvent.setup();
    await view();
    await user.type(screen.getByLabelText("Website"), "acme.example");
    m.saveUserPage.mockResolvedValue({ status: 400, body: { error: "The website must start with http:// or https://" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The website must start with http:// or https://");
    expect(screen.getByLabelText("Website")).toHaveValue("acme.example");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(onName).not.toHaveBeenCalled();
  });

  it("a save that cannot reach the server says so and keeps the edits", async () => {
    const user = userEvent.setup();
    await view();
    await user.type(screen.getByLabelText("Website"), "https://acme.example");
    m.saveUserPage.mockRejectedValue(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save. Check signal and try again.");
    expect(screen.getByLabelText("Website")).toHaveValue("https://acme.example");
    // The accounts database being down is a 502 with a message of its own.
    m.saveUserPage.mockResolvedValue({ status: 502, body: { error: "Could not reach the accounts database" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.saveUserPage).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save. Check signal and try again.");
  });

  it("Add is off for a blank note, sends the trimmed note, clears the box and shows the new note first", async () => {
    const user = userEvent.setup();
    await view();
    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText("New note"), "   ");
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText("New note"), "Raising in Q1.  ");
    expect(add).toBeEnabled();
    m.addUserNote.mockResolvedValue(
      reply({ ...PAGE, notes: [{ id: "n3", body: "Raising in Q1.", at: "2026-11-24T08:00:00Z" }, ...PAGE.notes], notesTotal: 3 }),
    );
    await user.click(add);
    expect(m.addUserNote).toHaveBeenCalledWith("traxo", "Raising in Q1.");
    await waitFor(() => expect(screen.getByLabelText("New note")).toHaveValue(""));
    const notes = within(screen.getByRole("list", { name: "Your notes" })).getAllByRole("listitem");
    expect(notes).toHaveLength(3);
    expect(notes[0]).toHaveTextContent("Raising in Q1.");
    expect(screen.getByText("3 notes")).toBeInTheDocument();
    expect(lastDraft().note).toBe("");
  });

  it("adding a note leaves unsaved field edits as they are", async () => {
    const user = userEvent.setup();
    await view();
    await user.type(screen.getByLabelText("Email"), "dana@acme.example");
    await user.type(screen.getByLabelText("New note"), "A note");
    m.addUserNote.mockResolvedValue(reply({ ...PAGE, notesTotal: 3 }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByLabelText("New note")).toHaveValue(""));
    expect(screen.getByLabelText("Email")).toHaveValue("dana@acme.example");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("a refused note shows the server's message and keeps the text", async () => {
    const user = userEvent.setup();
    await view();
    await user.type(screen.getByLabelText("New note"), "Too long");
    m.addUserNote.mockResolvedValue({ status: 400, body: { error: "The note is too long (2,000 characters at most)" } });
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The note is too long (2,000 characters at most)");
    expect(screen.getByLabelText("New note")).toHaveValue("Too long");
  });

  it("a 401 on save or on add hands over to the passcode screen with the edits still in the draft", async () => {
    const user = userEvent.setup();
    await view();
    await user.type(screen.getByLabelText("Phone"), "9");
    await user.type(screen.getByLabelText("New note"), "Half a note");
    m.saveUserPage.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    m.addUserNote.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(2));
    expect(lastDraft().fields?.phone).toBe("+31 6 1234 56789");
    expect(lastDraft().note).toBe("Half a note");
    expect(onName).not.toHaveBeenCalled();
  });

  it("a 401 on load hands over to the passcode screen", async () => {
    m.loadUserPage.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    render(<Harness start={EMPTY_USER_DRAFT} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a draft it is given over the page it loads", async () => {
    await view({
      fields: { name: "Dana Lee", phone: "000", email: null, company: "Acme Ltd", website: null, roleObjectives: "Changed" },
      note: "Half a note",
    });
    expect(screen.getByLabelText("Phone")).toHaveValue("000");
    expect(screen.getByLabelText("Role and objectives")).toHaveValue("Changed");
    expect(screen.getByLabelText("New note")).toHaveValue("Half a note");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("a load failure shows Retry, which loads again", async () => {
    const user = userEvent.setup();
    m.loadUserPage.mockResolvedValueOnce({ status: 502, body: { error: "Could not reach the accounts database" } });
    render(<Harness start={EMPTY_USER_DRAFT} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load. Check signal.");
    expect(screen.queryByRole("heading", { name: "You" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "You" })).toBeInTheDocument();
    expect(m.loadUserPage).toHaveBeenCalledTimes(2);
  });

  it("Back leaves at once when nothing is unsaved", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    await view();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Back with unsaved edits asks first: No stays with the edits, Yes leaves and drops them", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await view();
    await user.type(screen.getByLabelText("Phone"), "9");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(confirm).toHaveBeenCalledWith("Discard your unsaved changes?");
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Phone")).toHaveValue("+31 6 1234 56789");
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(lastDraft()).toEqual(EMPTY_USER_DRAFT);
  });

  it("a note typed and not added counts as unsaved", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await view();
    await user.type(screen.getByLabelText("New note"), "Half a note");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  describe("Connections", () => {
    it("has a Granola row that says the state it loaded", async () => {
      await view();
      expect(screen.getByRole("heading", { name: "Connections" })).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Granola, Not connected" })).toBeEnabled();
      expect(m.loadGranolaKey).toHaveBeenCalledTimes(1);
      cleanup();
      for (const [status, words] of [
        ["ok", "Connected"],
        ["key_rejected", "Key refused"],
        ["no_access", "No access"],
      ]) {
        m.loadGranolaKey.mockResolvedValue(granola({ ...GRANOLA_ON, status }));
        await view();
        expect(await screen.findByRole("button", { name: `Granola, ${words}` })).toBeInTheDocument();
        cleanup();
      }
    });

    it("a Granola state that will not load leaves the row as Granola alone and the page usable", async () => {
      const user = userEvent.setup();
      m.loadGranolaKey.mockRejectedValue(new Error("net"));
      await view();
      await waitFor(() => expect(m.loadGranolaKey).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("button", { name: "Granola" })).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
      await user.type(screen.getByLabelText("Phone"), "9");
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      cleanup();

      // Signed out as far as Granola's route is concerned: still only an unknown row.
      m.loadGranolaKey.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
      await view();
      await waitFor(() => expect(m.loadGranolaKey).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("button", { name: "Granola" })).toBeEnabled();
      expect(onUnauthorized).not.toHaveBeenCalled();
      cleanup();

      m.loadGranolaKey.mockResolvedValue({ status: 502, body: null } as never);
      await view();
      await waitFor(() => expect(m.loadGranolaKey).toHaveBeenCalledTimes(3));
      expect(screen.getByRole("button", { name: "Granola" })).toBeEnabled();
    });

    it("the row opens the Granola screen without asking, and Back returns with the edits and the new state", async () => {
      const user = userEvent.setup();
      const confirm = vi.spyOn(window, "confirm");
      await view();
      await user.clear(screen.getByLabelText("Name"));
      await user.type(screen.getByLabelText("Name"), "Dana L.");
      await user.type(screen.getByLabelText("Phone"), "9");
      await user.type(screen.getByLabelText("Role and objectives"), " More.");
      await user.type(screen.getByLabelText("New note"), "Half a note");
      const draftsBefore = drafts.length;

      await user.click(await screen.findByRole("button", { name: "Granola, Not connected" }));
      expect(confirm).not.toHaveBeenCalled();
      expect(await screen.findByRole("heading", { name: "Granola" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Your page" })).toBeNull();
      expect(screen.queryByLabelText("Name")).toBeNull();

      m.saveGranolaKey.mockResolvedValue(granola(GRANOLA_ON));
      await user.type(await screen.findByLabelText("Granola API key"), "grn_fake_key_for_tests");
      await user.click(screen.getByRole("button", { name: "Test and save" }));
      expect(await screen.findByText("Connected")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(onBack).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "Your page" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Granola, Connected" })).toBeInTheDocument();
      expect(screen.getByLabelText("Name")).toHaveValue("Dana L.");
      expect(screen.getByLabelText("Phone")).toHaveValue("+31 6 1234 56789");
      expect(screen.getByLabelText("Role and objectives")).toHaveValue("Partner.\nRaise the next fund. More.");
      expect(screen.getByLabelText("New note")).toHaveValue("Half a note");
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(drafts.length).toBe(draftsBefore);
      // The page itself was not fetched again.
      expect(m.loadUserPage).toHaveBeenCalledTimes(1);
    });

    it("a 401 on the Granola screen hands over to the passcode screen", async () => {
      const user = userEvent.setup();
      await view();
      await user.click(await screen.findByRole("button", { name: "Granola, Not connected" }));
      m.saveGranolaKey.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
      await user.type(await screen.findByLabelText("Granola API key"), "grn_fake_key_for_tests");
      await user.click(screen.getByRole("button", { name: "Test and save" }));
      await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    });

    it("the row is off while a save or an add is away", async () => {
      const user = userEvent.setup();
      await view();
      const rowButton = await screen.findByRole("button", { name: "Granola, Not connected" });
      let finishSave: (v: never) => void = () => {};
      m.saveUserPage.mockReturnValue(new Promise((resolve) => (finishSave = resolve)));
      await user.type(screen.getByLabelText("Phone"), "9");
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(rowButton).toBeDisabled();
      finishSave(reply(PAGE));
      await waitFor(() => expect(rowButton).toBeEnabled());

      let finishAdd: (v: never) => void = () => {};
      m.addUserNote.mockReturnValue(new Promise((resolve) => (finishAdd = resolve)));
      await user.type(screen.getByLabelText("New note"), "A note");
      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(rowButton).toBeDisabled();
      finishAdd(reply(PAGE));
      await waitFor(() => expect(rowButton).toBeEnabled());
    });
  });
});
