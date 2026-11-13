// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MonsoonApp from "./MonsoonApp";
import * as api from "./api";
import { downsizeImage } from "./image";

vi.mock("./api", () => ({
  signIn: vi.fn(),
  loadEstates: vi.fn(),
  readCards: vi.fn(),
  saveCard: vi.fn(),
  refineCard: vi.fn(),
}));
vi.mock("./image", () => ({
  downsizeImage: vi.fn(),
}));

const m = vi.mocked(api);

const ESTATES = {
  estates: [
    {
      key: "traxo",
      label: "Traxo",
      defaultRole: "lp_prospect",
      available: true,
      roles: [
        { key: "lp_prospect", label: "LP prospect" },
        { key: "introducer", label: "Introducer" },
      ],
    },
    {
      key: "zeroone",
      label: "Zero One",
      defaultRole: "investor",
      available: true,
      roles: [
        { key: "investor", label: "investor" },
        { key: "reader", label: "Reader" },
      ],
    },
  ],
};

const CARD = {
  name: "Jane Tan",
  title: "Partner",
  org: "Acme Capital",
  email: "jane@acme.com",
  phone: "",
  linkedin: "",
  raw_text: "Jane Tan Partner Acme Capital",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type User = ReturnType<typeof userEvent.setup>;

function signedIn() {
  m.loadEstates.mockResolvedValue({ status: 200, body: ESTATES });
}

async function pickPhoto(user: User) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, new File(["img"], "card.jpg", { type: "image/jpeg" }));
}

async function ready() {
  await screen.findByRole("button", { name: "Save" });
}

async function typeName(user: User, name = "Jane Tan") {
  await user.type(screen.getByLabelText("Name"), name);
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

beforeEach(() => {
  // Node's own experimental localStorage can shadow jsdom's; use a fixed fake.
  vi.stubGlobal("localStorage", memoryStorage());
  vi.resetAllMocks();
  vi.mocked(downsizeImage).mockResolvedValue(new Blob(["x"], { type: "image/jpeg" }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MonsoonApp", () => {
  it("shows the passcode screen when estates returns 401, then the app after sign-in", async () => {
    const user = userEvent.setup();
    m.loadEstates.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } });
    m.signIn.mockResolvedValue({ status: 200, body: { ok: true } });
    render(<MonsoonApp />);
    const field = await screen.findByLabelText("Passcode");
    signedIn();
    await user.type(field, "a-long-passcode-here");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(m.signIn).toHaveBeenCalledWith("a-long-passcode-here");
    await ready();
  });

  it('wrong passcode shows "Wrong passcode"', async () => {
    const user = userEvent.setup();
    m.loadEstates.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    m.signIn.mockResolvedValue({ status: 401, body: { error: "Wrong passcode" } });
    render(<MonsoonApp />);
    await user.type(await screen.findByLabelText("Passcode"), "nope");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Wrong passcode")).toBeInTheDocument();
  });

  it("remembers the estate", async () => {
    localStorage.setItem("monsoon.estate", "zeroone");
    signedIn();
    render(<MonsoonApp />);
    await ready();
    expect(screen.getByRole("button", { name: "Zero One" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Role")).toHaveValue("investor");
  });

  it("defaults to traxo when localStorage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    signedIn();
    render(<MonsoonApp />);
    await ready();
    expect(screen.getByRole("button", { name: "Traxo" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.setup().click(screen.getByRole("button", { name: "Zero One" }));
    expect(screen.getByLabelText("Role")).toHaveValue("investor");
  });

  it("unavailable estate is disabled", async () => {
    m.loadEstates.mockResolvedValue({
      status: 200,
      body: {
        estates: [ESTATES.estates[0], { ...ESTATES.estates[1], available: false }],
      },
    });
    render(<MonsoonApp />);
    await ready();
    expect(screen.getByRole("button", { name: "Zero One (unavailable)" })).toBeDisabled();
  });

  it("fills the form from a photo", async () => {
    const user = userEvent.setup();
    signedIn();
    m.readCards.mockResolvedValue({ status: 200, body: { cards: [CARD] } });
    render(<MonsoonApp />);
    await ready();
    await pickPhoto(user);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan"));
    expect(m.readCards).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Company")).toHaveValue("Acme Capital");
    expect(screen.getByLabelText("Email")).toHaveValue("jane@acme.com");
  });

  it("read failure keeps the form usable", async () => {
    const user = userEvent.setup();
    signedIn();
    m.readCards.mockResolvedValue({ status: 502, body: { error: "x" } });
    render(<MonsoonApp />);
    await ready();
    await pickPhoto(user);
    expect(
      await screen.findByText("Could not read the photo. Try again or type the details."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await typeName(user);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("saves and clears", async () => {
    const user = userEvent.setup();
    signedIn();
    m.readCards.mockResolvedValue({ status: 200, body: { cards: [CARD] } });
    m.saveCard.mockResolvedValue({
      status: 200,
      body: { outcome: "added", person: "6f1c2a3e-0000-4000-8000-000000000001", org: "Acme Capital", role: "lp_prospect", filled: [] },
    });
    render(<MonsoonApp />);
    await ready();
    await pickPhoto(user);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Jane Tan added to Traxo.")).toBeInTheDocument();
    expect(m.saveCard).toHaveBeenCalledWith({
      estate: "traxo",
      role: "lp_prospect",
      captureId: expect.stringMatching(UUID),
      fields: {
        name: "Jane Tan",
        title: "Partner",
        org: "Acme Capital",
        email: "jane@acme.com",
        phone: "",
        linkedin: "",
        notes: "",
      },
      extracted: CARD,
    });
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("existing outcome uses the role label and lists filled fields", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockResolvedValueOnce({
      status: 200,
      body: { outcome: "existing", person: "6f1c2a3e-0000-4000-8000-000000000001", org: null, role: "lp_prospect", filled: ["email", "phone"] },
    });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Jane Tan is already in Traxo as LP prospect; filled in email, phone."),
    ).toBeInTheDocument();
  });

  it("disables Save while saving", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockReturnValue(new Promise(() => {}));
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    const save = screen.getByRole("button", { name: /Save/ });
    await user.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    await user.click(save);
    expect(m.saveCard).toHaveBeenCalledTimes(1);
  });

  it("org lookalike: choosing an existing company re-saves with that name and the same captureId", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard
      .mockResolvedValueOnce({ status: 200, body: { outcome: "org_lookalike", similar: ["Acme Capital Ltd"] } })
      .mockResolvedValueOnce({
        status: 200,
        body: { outcome: "added", person: "6f1c2a3e-0000-4000-8000-000000000001", org: "Acme Capital Ltd", role: "lp_prospect", filled: [] },
      });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.type(screen.getByLabelText("Company"), "Acme Capital");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Acme Capital looks like Acme Capital Ltd, already on file.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use Acme Capital Ltd" }));
    await screen.findByText("Jane Tan added to Traxo.");
    const [first, second] = m.saveCard.mock.calls.map((c) => c[0]);
    expect(second.captureId).toBe(first.captureId);
    expect(second.fields.org).toBe("Acme Capital Ltd");
    expect(second.newOrg).toBeUndefined();
  });

  it("org lookalike: \"It's a different company\" re-saves with newOrg true", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard
      .mockResolvedValueOnce({ status: 200, body: { outcome: "org_lookalike", similar: ["Acme Capital Ltd"] } })
      .mockResolvedValueOnce({
        status: 200,
        body: { outcome: "added", person: "6f1c2a3e-0000-4000-8000-000000000001", org: "Acme Capital", role: "lp_prospect", filled: [] },
      });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.type(screen.getByLabelText("Company"), "Acme Capital");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "It's a different company" }));
    await screen.findByText("Jane Tan added to Traxo.");
    expect(m.saveCard.mock.calls[1][0]).toMatchObject({ newOrg: true });
    expect(m.saveCard.mock.calls[1][0].captureId).toBe(m.saveCard.mock.calls[0][0].captureId);
  });

  it('same name: "Same person" re-saves with that personId; "Different person" with false', async () => {
    const user = userEvent.setup();
    signedIn();
    const sameName: Awaited<ReturnType<typeof api.saveCard>> = {
      status: 200,
      body: { outcome: "same_name", matches: [{ personId: "p1", org: "Beta" }] },
    };
    m.saveCard
      .mockResolvedValueOnce(sameName)
      .mockResolvedValueOnce({
        status: 200,
        body: { outcome: "existing", person: "6f1c2a3e-0000-4000-8000-000000000001", org: "Beta", role: "lp_prospect", filled: [] },
      })
      .mockResolvedValueOnce(sameName)
      .mockResolvedValueOnce({
        status: 200,
        body: { outcome: "added", person: "6f1c2a3e-0000-4000-8000-000000000001", org: null, role: "lp_prospect", filled: [] },
      });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Jane Tan is already on file at Beta. Same person?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Same person (Beta)" }));
    await screen.findByText("Jane Tan is already in Traxo as LP prospect; nothing new.");
    expect(m.saveCard.mock.calls[1][0]).toMatchObject({ samePerson: "p1" });

    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "Different person" }));
    await screen.findByText("Jane Tan added to Traxo.");
    expect(m.saveCard.mock.calls[3][0]).toMatchObject({ samePerson: false });
  });

  it("ambiguous asks for the company and keeps the fields", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockResolvedValue({ status: 200, body: { outcome: "ambiguous", orgs: ["A", null] } });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Several people are named Jane Tan. Add the company to say which one."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan");
  });

  it("duplicate says saved", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockResolvedValue({ status: 200, body: { outcome: "duplicate", person: "6f1c2a3e-0000-4000-8000-000000000001", org: null } });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Jane Tan saved to Traxo.")).toBeInTheDocument();
  });

  it("changing estate keeps fields and resets role", async () => {
    const user = userEvent.setup();
    signedIn();
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.selectOptions(screen.getByLabelText("Role"), "introducer");
    await user.click(screen.getByRole("button", { name: "Zero One" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan");
    expect(screen.getByLabelText("Role")).toHaveValue("investor");
    expect(localStorage.getItem("monsoon.estate")).toBe("zeroone");
  });

  it("keeps the form across a 401", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    m.signIn.mockResolvedValue({ status: 200, body: { ok: true } });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(await screen.findByLabelText("Passcode"), "a-long-passcode-here");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await ready();
    expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan");
  });

  it("save failure keeps the fields and shows the save-failure message", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockResolvedValueOnce({ status: 502, body: { error: "x" } });
    m.saveCard.mockRejectedValueOnce(new Error("network"));
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save. Check signal and try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.saveCard).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Could not save. Check signal and try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan");
  });

  it("a 400 invalid save shows the server error and keeps the fields", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockResolvedValue({ status: 400, body: { outcome: "invalid", error: "unknown role: x" } });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("unknown role: x")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan");
  });

  it("a non-401 estates failure shows Retry, not the passcode form; Retry reloads", async () => {
    const user = userEvent.setup();
    m.loadEstates.mockResolvedValueOnce({ status: 502, body: { error: "x" } });
    render(<MonsoonApp />);
    expect(await screen.findByText("Could not load. Check signal.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Passcode")).not.toBeInTheDocument();
    signedIn();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await ready();
  });

  it("a network error on load also shows Retry", async () => {
    m.loadEstates.mockRejectedValueOnce(new Error("offline"));
    render(<MonsoonApp />);
    expect(await screen.findByText("Could not load. Check signal.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Passcode")).not.toBeInTheDocument();
  });

  it("after sign-in, a non-401 reload failure shows the retry message", async () => {
    const user = userEvent.setup();
    m.loadEstates.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } });
    m.loadEstates.mockResolvedValueOnce({ status: 500, body: { error: "x" } });
    m.signIn.mockResolvedValue({ status: 200, body: { ok: true } });
    render(<MonsoonApp />);
    await user.type(await screen.findByLabelText("Passcode"), "a-long-passcode-here");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Could not load. Check signal.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Passcode")).not.toBeInTheDocument();
  });

  it("the file input offers the photo library: no capture attribute", async () => {
    signedIn();
    render(<MonsoonApp />);
    await ready();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toHaveAttribute("capture");
    expect(input).toHaveAttribute("accept", "image/*");
    expect(input).toHaveAttribute("hidden");
  });

  it("re-login keeps the chosen role when it is still offered", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    m.signIn.mockResolvedValue({ status: 200, body: { ok: true } });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.selectOptions(screen.getByLabelText("Role"), "introducer");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(await screen.findByLabelText("Passcode"), "a-long-passcode-here");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await ready();
    expect(screen.getByLabelText("Role")).toHaveValue("introducer");
  });

  it("selects roles[0] when the estate default role is not in its list", async () => {
    const user = userEvent.setup();
    m.loadEstates.mockResolvedValue({
      status: 200,
      body: {
        estates: [
          { ...ESTATES.estates[0], defaultRole: "gone" },
          ESTATES.estates[1],
        ],
      },
    });
    m.saveCard.mockResolvedValue({
      status: 200,
      body: { outcome: "added", person: "6f1c2a3e-0000-4000-8000-000000000001", org: null, role: "lp_prospect", filled: [] },
    });
    render(<MonsoonApp />);
    await ready();
    expect(screen.getByLabelText("Role")).toHaveValue("lp_prospect");
    await typeName(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Jane Tan added to Traxo.");
    expect(m.saveCard.mock.calls[0][0].role).toBe("lp_prospect");
  });

  it("keeps an earlier same-name answer when re-saving from the company prompt", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard
      .mockResolvedValueOnce({ status: 200, body: { outcome: "same_name", matches: [{ personId: "p1", org: "Beta" }] } })
      .mockResolvedValueOnce({ status: 200, body: { outcome: "org_lookalike", similar: ["Acme Capital Ltd"] } })
      .mockResolvedValueOnce({
        status: 200,
        body: { outcome: "added", person: "6f1c2a3e-0000-4000-8000-000000000001", org: "Acme Capital Ltd", role: "lp_prospect", filled: [] },
      });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.type(screen.getByLabelText("Company"), "Acme Capital");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "Different person" }));
    await user.click(await screen.findByRole("button", { name: "Use Acme Capital Ltd" }));
    await screen.findByText("Jane Tan added to Traxo.");
    expect(m.saveCard.mock.calls[1][0]).toMatchObject({ samePerson: false });
    expect(m.saveCard.mock.calls[2][0]).toMatchObject({ samePerson: false });
  });

  it("a new photo keeps Notes the user already typed", async () => {
    const user = userEvent.setup();
    signedIn();
    m.readCards.mockResolvedValue({ status: 200, body: { cards: [CARD] } });
    render(<MonsoonApp />);
    await ready();
    await user.type(screen.getByLabelText("Notes"), "met at SFF");
    await pickPhoto(user);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan"));
    expect(screen.getByLabelText("Notes")).toHaveValue("met at SFF");
  });

  it("editing a field or changing estate clears the prompt message and its buttons", async () => {
    const user = userEvent.setup();
    signedIn();
    m.saveCard.mockResolvedValue({ status: 200, body: { outcome: "org_lookalike", similar: ["Acme Capital Ltd", "Acme Cap"] } });
    render(<MonsoonApp />);
    await ready();
    await typeName(user);
    await user.type(screen.getByLabelText("Company"), "Acme Capital");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Acme Capital looks like a company already on file.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "x");
    expect(screen.queryByText("Acme Capital looks like a company already on file.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Acme Capital Ltd" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Acme Capital looks like a company already on file.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zero One" }));
    expect(screen.queryByText("Acme Capital looks like a company already on file.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "It's a different company" })).not.toBeInTheDocument();
  });

  const BOB = { ...CARD, name: "Bob Lee", org: "", email: "bob@x.com", raw_text: "Bob Lee" };
  const ADDED = { status: 200, body: { outcome: "added", person: "p", org: null } } as never;

  async function openBatch(user: User) {
    signedIn();
    m.readCards.mockResolvedValue({ status: 200, body: { cards: [CARD, BOB] } });
    render(<MonsoonApp />);
    await ready();
    await pickPhoto(user);
    await screen.findByText("2 cards found");
  }

  it("two or more cards open the batch review", async () => {
    const user = userEvent.setup();
    signedIn();
    m.readCards.mockResolvedValue({ status: 200, body: { cards: [CARD, BOB] } });
    render(<MonsoonApp />);
    await ready();
    await user.type(screen.getByLabelText("Notes"), "demo day");
    await user.selectOptions(screen.getByLabelText("Role"), "introducer");
    await pickPhoto(user);
    expect(await screen.findByText("2 cards found")).toBeInTheDocument();
    expect(screen.getByText("Jane Tan · Acme Capital")).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toHaveValue("introducer");
    expect(screen.getByLabelText("Note")).toHaveValue("demo day");
    expect(screen.getByRole("group", { name: "Estate" })).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("one card still fills the single form", async () => {
    const user = userEvent.setup();
    signedIn();
    m.readCards.mockResolvedValue({ status: 200, body: { cards: [CARD] } });
    render(<MonsoonApp />);
    await ready();
    await pickPhoto(user);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan"));
    expect(screen.queryByText(/cards found/)).toBeNull();
  });

  it("zero cards leaves the form usable", async () => {
    const user = userEvent.setup();
    signedIn();
    m.readCards.mockResolvedValue({ status: 200, body: { cards: [] } });
    render(<MonsoonApp />);
    await ready();
    await user.type(screen.getByLabelText("Name"), "Old");
    await user.type(screen.getByLabelText("Notes"), "keep me");
    await pickPhoto(user);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue(""));
    expect(screen.getByLabelText("Notes")).toHaveValue("keep me");
    expect(screen.queryByText(/cards found/)).toBeNull();
    await typeName(user);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("keeps the batch across a 401", async () => {
    const user = userEvent.setup();
    m.signIn.mockResolvedValue({ status: 200, body: { ok: true } });
    m.saveCard
      .mockResolvedValueOnce(ADDED)
      .mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } } as never);
    await openBatch(user);
    await user.click(screen.getByRole("button", { name: "Save all (2)" }));
    await user.type(await screen.findByLabelText("Passcode"), "a-long-passcode-here");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("2 cards found")).toBeInTheDocument();
    expect(screen.getByText("Jane Tan added to Traxo.")).toBeInTheDocument();
    expect(screen.getByText("Bob Lee · bob@x.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all (1)" })).toBeEnabled();
  });

  it("estate buttons are disabled once a batch card is saved", async () => {
    const user = userEvent.setup();
    m.saveCard
      .mockResolvedValueOnce(ADDED)
      .mockResolvedValueOnce({ status: 400, body: { error: "bad" } } as never);
    await openBatch(user);
    expect(screen.getByRole("button", { name: "Zero One" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save all (2)" }));
    await screen.findByText("bad");
    expect(screen.getByRole("button", { name: "Zero One" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Traxo" })).toBeDisabled();
  });

  it("switching estate before saving resets the batch role", async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValue(ADDED);
    await openBatch(user);
    await user.click(screen.getByRole("button", { name: /Jane Tan/ }));
    await user.selectOptions(screen.getByLabelText("Card role"), "introducer");
    await user.click(screen.getByRole("button", { name: "Zero One" }));
    expect(screen.getByLabelText("Role")).toHaveValue("investor");
    expect(screen.getByLabelText("Card role")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save all (2)" }));
    await screen.findByText("2 saved to Zero One.");
    expect(m.saveCard.mock.calls.map((c) => [c[0].estate, c[0].role])).toEqual([
      ["zeroone", "investor"],
      ["zeroone", "investor"],
    ]);
  });

  it("Done returns to the single form with the summary message", async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValue(ADDED);
    await openBatch(user);
    await user.click(screen.getByRole("button", { name: "Save all (2)" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(await screen.findByText("2 saved to Traxo.")).toBeInTheDocument();
    expect(screen.queryByText(/cards found/)).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Zero One" })).toBeEnabled();
  });

  describe("spoken notes", () => {
    const FIELDS = { name: "Jane Tan", title: "Partner", org: "Acme Capital", email: "jane@acme.com", phone: "", linkedin: "" };
    const refined = (fields: Record<string, string>, notes: string) =>
      ({ status: 200, body: { fields, notes } }) as never;

    async function loadCard(user: User) {
      signedIn();
      m.readCards.mockResolvedValue({ status: 200, body: { cards: [CARD] } });
      render(<MonsoonApp />);
      await ready();
      await pickPhoto(user);
      await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan"));
    }

    async function speak(user: User, text: string) {
      if (!screen.queryByRole("textbox", { name: "Spoken notes" })) {
        await user.click(screen.getByRole("button", { name: "Speak notes" }));
      }
      const box = screen.getByRole("textbox", { name: "Spoken notes" });
      await user.clear(box);
      await user.type(box, text);
      await user.click(screen.getByRole("button", { name: "Apply" }));
    }

    it("applying spoken notes updates notes and a corrected field, highlighted with the old value", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...FIELDS, title: "CIO" }, "Now CIO.\nCall next week."));
      await loadCard(user);
      await speak(user, "she is CIO now, call next week");
      await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("CIO"));
      expect(m.refineCard).toHaveBeenCalledWith({
        fields: FIELDS,
        notes: "",
        spoken: "she is CIO now, call next week",
      });
      expect(screen.getByLabelText("Notes")).toHaveValue("Now CIO.\nCall next week.");
      expect(screen.getByText("was: Partner")).toBeInTheDocument();
      expect(screen.getByText("was empty")).toBeInTheDocument();
      expect(screen.getByLabelText("Title").closest("[data-changed]")).not.toBeNull();
      expect(screen.getByLabelText("Notes").closest("[data-changed]")).not.toBeNull();
      expect(screen.getByLabelText("Name").closest("[data-changed]")).toBeNull();
      expect(m.saveCard).not.toHaveBeenCalled();
    });

    it("Undo restores the form", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...FIELDS, title: "CIO" }, "Now CIO."));
      await loadCard(user);
      await speak(user, "x");
      await user.click(await screen.findByRole("button", { name: "Undo" }));
      expect(screen.getByLabelText("Title")).toHaveValue("Partner");
      expect(screen.getByLabelText("Notes")).toHaveValue("");
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(screen.queryByText("was: Partner")).toBeNull();
    });

    it("editing a highlighted field clears only its highlight", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...FIELDS, title: "CIO" }, "Now CIO."));
      await loadCard(user);
      await speak(user, "x");
      await screen.findByText("was: Partner");
      await user.type(screen.getByLabelText("Title"), "!");
      expect(screen.getByLabelText("Title").closest("[data-changed]")).toBeNull();
      expect(screen.queryByText("was: Partner")).toBeNull();
      expect(screen.getByLabelText("Notes").closest("[data-changed]")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    });

    it("a second apply keeps the original snapshot for Undo", async () => {
      const user = userEvent.setup();
      m.refineCard
        .mockResolvedValueOnce(refined({ ...FIELDS, title: "CIO" }, "Now CIO."))
        .mockResolvedValueOnce(refined({ ...FIELDS, title: "CEO" }, "Now CEO."));
      await loadCard(user);
      await speak(user, "first");
      await screen.findByText("was: Partner");
      await speak(user, "second");
      await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("CEO"));
      expect(m.refineCard).toHaveBeenLastCalledWith({
        fields: { ...FIELDS, title: "CIO" },
        notes: "Now CIO.",
        spoken: "second",
      });
      expect(screen.getByText("was: Partner")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getByLabelText("Title")).toHaveValue("Partner");
      expect(screen.getByLabelText("Notes")).toHaveValue("");
    });

    it("spoken draft survives a 401", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
      m.signIn.mockResolvedValue({ status: 200, body: { ok: true } });
      await loadCard(user);
      await speak(user, "keep this");
      await user.type(await screen.findByLabelText("Passcode"), "a-long-passcode-here");
      await user.click(screen.getByRole("button", { name: "Unlock" }));
      await ready();
      expect(screen.getByLabelText("Name")).toHaveValue("Jane Tan");
      await user.click(screen.getByRole("button", { name: "Speak notes" }));
      expect(screen.getByRole("textbox", { name: "Spoken notes" })).toHaveValue("keep this");
    });

    it("the save body after an apply carries the refined fields and notes", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...FIELDS, title: "CIO" }, "Now CIO.\nCall next week."));
      m.saveCard.mockResolvedValue({ status: 200, body: { outcome: "added", person: "p", org: null } } as never);
      await loadCard(user);
      await speak(user, "x");
      await screen.findByText("was: Partner");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(m.saveCard).toHaveBeenCalledTimes(1));
      const body = m.saveCard.mock.calls[0][0];
      expect(body.fields).toMatchObject({ ...FIELDS, title: "CIO", notes: "Now CIO.\nCall next week." });
      expect(body.extracted).toEqual(CARD);
      // A successful save clears the highlights and the snapshot.
      await screen.findByText(/Saved|saved|Added|added/);
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    });

    it("a new photo clears the snapshot and the draft", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...FIELDS, title: "CIO" }, "Now CIO."));
      await loadCard(user);
      await speak(user, "x");
      await screen.findByRole("button", { name: "Undo" });
      await user.click(screen.getByRole("button", { name: "Speak notes" }));
      await user.type(screen.getByRole("textbox", { name: "Spoken notes" }), "leftover");
      await pickPhoto(user);
      await waitFor(() => expect(m.readCards).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
      expect(screen.getByRole("textbox", { name: "Spoken notes" })).toHaveValue("");
    });
  });
});
