// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import GranolaKeyPanel from "./GranolaKeyPanel";

vi.mock("./api", () => ({
  loadGranolaKey: vi.fn(),
  saveGranolaKey: vi.fn(),
  testGranolaKey: vi.fn(),
  disconnectGranolaKey: vi.fn(),
}));
const m = vi.mocked(api);

const OK = {
  status: "ok" as const,
  last4: "4f2A",
  setAt: "2025-03-02T09:00:00Z",
  checkedAt: "2025-03-05T09:00:00Z",
};
const MISSING = { status: "missing" as const, last4: null, setAt: null, checkedAt: null };
const reply = (key: object) => ({ status: 200, body: { key } }) as never;
const FOOTER =
  "Monsoon only reads from Granola. Meeting text is sent to Claude when Ask uses it and is not stored in Monsoon. The key is stored encrypted and never shown again.";

let onBack: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn>;
let onStatus: ReturnType<typeof vi.fn>;
function view() {
  return render(<GranolaKeyPanel onBack={onBack} onUnauthorized={onUnauthorized} onStatus={onStatus} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  onBack = vi.fn();
  onUnauthorized = vi.fn();
  onStatus = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GranolaKeyPanel", () => {
  it("with no key: says so, shows the paste box, the steps, the plan line and the footer, and no key buttons", async () => {
    m.loadGranolaKey.mockResolvedValue(reply(MISSING));
    view();
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Granola" })).toBeInTheDocument();
    expect(screen.getByText("Connect Granola so Ask can use your meeting notes.")).toBeInTheDocument();
    expect(onStatus).toHaveBeenCalledWith("missing");
    const box = screen.getByLabelText("Granola API key");
    expect(box).toHaveAttribute("type", "password");
    expect(box).toHaveAttribute("autocomplete", "off");
    expect(box).toHaveAttribute("autocapitalize", "none");
    expect(box).toHaveAttribute("spellcheck", "false");
    expect(screen.getByRole("button", { name: "Test and save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Test again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.queryByText(/grn_/)).toBeNull();
    expect(screen.getByText("How to get a key")).toBeInTheDocument();
    for (const step of [
      "Open the Granola desktop app.",
      "Go to Settings, then Connectors, then API keys.",
      "Create a new key with access to your personal notes and to transcripts.",
      "Copy it and paste it here.",
    ]) {
      expect(screen.getByText(step)).toBeInTheDocument();
    }
    expect(screen.getByText("Granola API keys need a Business or Enterprise plan.")).toBeInTheDocument();
    expect(screen.getByText(FOOTER)).toBeInTheDocument();
  });

  it("with a working key: Connected, the key by its last four characters, and when it was added and checked", async () => {
    m.loadGranolaKey.mockResolvedValue(reply(OK));
    view();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Ask can search your Granola meetings.")).toBeInTheDocument();
    expect(screen.getByText("grn_…4f2A")).toBeInTheDocument();
    expect(screen.getByText("Added").parentElement).toHaveTextContent("Added2 Mar 2025");
    expect(screen.getByText("Last checked").parentElement).toHaveTextContent("Last checked5 Mar 2025");
    expect(screen.getByRole("button", { name: "Test again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(onStatus).toHaveBeenCalledWith("ok");
  });

  it("a refused key and a key without access each say what to do", async () => {
    m.loadGranolaKey.mockResolvedValue(reply({ ...OK, status: "key_rejected" }));
    view();
    expect(await screen.findByText("Key refused")).toBeInTheDocument();
    expect(screen.getByText("Granola refused this key. It may have been revoked. Paste a new one.")).toBeInTheDocument();
    cleanup();

    m.loadGranolaKey.mockResolvedValue(reply({ ...OK, status: "no_access" }));
    view();
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(
      screen.getByText("Granola accepted the key but will not give access. Check your Granola plan and the key's permissions."),
    ).toBeInTheDocument();
    expect(onStatus).toHaveBeenLastCalledWith("no_access");
  });

  it("saves a pasted key, clears the box and shows the new state", async () => {
    const user = userEvent.setup();
    m.loadGranolaKey.mockResolvedValue(reply(MISSING));
    m.saveGranolaKey.mockResolvedValue(reply({ ...OK, last4: "9zzQ" }));
    view();
    await user.type(await screen.findByLabelText("Granola API key"), " grn_fake_key_for_tests ");
    await user.click(screen.getByRole("button", { name: "Test and save" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(m.saveGranolaKey).toHaveBeenCalledWith("grn_fake_key_for_tests");
    expect(screen.getByText("grn_…9zzQ")).toBeInTheDocument();
    expect(screen.getByLabelText("Granola API key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Test and save" })).toBeDisabled();
    expect(onStatus).toHaveBeenLastCalledWith("ok");
  });

  it("says why a key was not saved, keeps it in the box and never puts it in the message", async () => {
    const user = userEvent.setup();
    m.loadGranolaKey.mockResolvedValue(reply(MISSING));
    view();
    await user.type(await screen.findByLabelText("Granola API key"), "grn_fake_bad_key");
    const save = screen.getByRole("button", { name: "Test and save" });
    const said = async (text: string) => {
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text));
      expect(screen.getByRole("alert").textContent).toBe(text);
      expect(document.body.textContent).not.toContain("grn_fake_bad_key");
      expect(screen.getByLabelText("Granola API key")).toHaveValue("grn_fake_bad_key");
      expect(screen.getByText("Not connected")).toBeInTheDocument();
    };

    m.saveGranolaKey.mockResolvedValue({ status: 422, body: { error: "granola_key_rejected" } });
    await user.click(save);
    await said("Granola refused that key. Check you copied all of it.");

    m.saveGranolaKey.mockResolvedValue({ status: 422, body: { error: "granola_no_access" } });
    await user.click(save);
    await said("Granola accepted the key but will not give access. Check your plan and the key's permissions.");

    m.saveGranolaKey.mockResolvedValue({ status: 503, body: { error: "granola_busy" } });
    await user.click(save);
    await said("Could not reach Granola. Try again.");

    // A server that echoes the key back in an error is still not quoted.
    m.saveGranolaKey.mockResolvedValue({ status: 400, body: { error: "bad key grn_fake_bad_key" } });
    await user.click(save);
    await waitFor(() => expect(m.saveGranolaKey).toHaveBeenCalledTimes(4));
    await said("Could not reach Granola. Try again.");

    m.saveGranolaKey.mockRejectedValue(new Error("net grn_fake_bad_key"));
    await user.click(save);
    await waitFor(() => expect(m.saveGranolaKey).toHaveBeenCalledTimes(5));
    await said("Could not reach Granola. Try again.");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("Test again shows the fresh result, or says Granola could not be reached", async () => {
    const user = userEvent.setup();
    m.loadGranolaKey.mockResolvedValue(reply(OK));
    view();
    const again = await screen.findByRole("button", { name: "Test again" });
    m.testGranolaKey.mockResolvedValue({ status: 503, body: { error: "granola_busy" } });
    await user.click(again);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Granola. Try again.");
    expect(screen.getByText("Connected")).toBeInTheDocument();

    m.testGranolaKey.mockResolvedValue(reply({ ...OK, status: "key_rejected" }));
    await user.click(again);
    expect(await screen.findByText("Key refused")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onStatus).toHaveBeenLastCalledWith("key_rejected");
  });

  it("Disconnect asks first: No leaves the key, Yes removes it", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    m.loadGranolaKey.mockResolvedValue(reply(OK));
    m.disconnectGranolaKey.mockResolvedValue(reply(MISSING));
    view();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(confirm).toHaveBeenCalledWith("Disconnect Granola? Ask will stop using your meetings.");
    expect(m.disconnectGranolaKey).not.toHaveBeenCalled();
    expect(screen.getByText("Connected")).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(m.disconnectGranolaKey).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/grn_/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(onStatus).toHaveBeenLastCalledWith("missing");
  });

  it("a Disconnect that fails says so and leaves the key shown", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    m.loadGranolaKey.mockResolvedValue(reply(OK));
    m.disconnectGranolaKey.mockResolvedValue({ status: 502, body: { error: "Could not reach the accounts database" } });
    view();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not disconnect. Check signal and try again.");
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("every button is off while a request is away, so nothing is sent twice", async () => {
    const user = userEvent.setup();
    m.loadGranolaKey.mockResolvedValue(reply(OK));
    let finish: (v: never) => void = () => {};
    m.saveGranolaKey.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    view();
    await user.type(await screen.findByLabelText("Granola API key"), "grn_fake_key_for_tests");
    await user.click(screen.getByRole("button", { name: "Test and save" }));
    expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test again" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    await user.type(screen.getByLabelText("Granola API key"), "{Enter}");
    expect(m.saveGranolaKey).toHaveBeenCalledTimes(1);
    finish(reply(OK));
    expect(await screen.findByRole("button", { name: "Test again" })).toBeEnabled();
  });

  it("a 401 from any call goes to sign-in", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const gone = { status: 401, body: { error: "unauthorized" } };
    m.loadGranolaKey.mockResolvedValueOnce(gone);
    view();
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();

    m.loadGranolaKey.mockResolvedValue(reply(OK));
    m.saveGranolaKey.mockResolvedValue(gone);
    m.testGranolaKey.mockResolvedValue(gone);
    m.disconnectGranolaKey.mockResolvedValue(gone);
    view();
    await user.type(await screen.findByLabelText("Granola API key"), "grn_fake_key_for_tests");
    await user.click(screen.getByRole("button", { name: "Test and save" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Test again" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(3));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a load that fails offers Try again, which loads; Back goes back", async () => {
    const user = userEvent.setup();
    m.loadGranolaKey.mockRejectedValueOnce(new Error("net"));
    view();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load. Check signal.");
    expect(screen.queryByLabelText("Granola API key")).toBeNull();
    m.loadGranolaKey.mockResolvedValueOnce({ status: 502, body: { error: "Could not reach the accounts database" } });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(m.loadGranolaKey).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load. Check signal.");
    m.loadGranolaKey.mockResolvedValue(reply(OK));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("a reply that arrives after the screen has gone changes nothing", async () => {
    const user = userEvent.setup();
    let finishLoad: (v: never) => void = () => {};
    m.loadGranolaKey.mockReturnValueOnce(new Promise((resolve) => (finishLoad = resolve)));
    const first = view();
    first.unmount();
    finishLoad({ status: 401, body: { error: "unauthorized" } } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();

    m.loadGranolaKey.mockResolvedValue(reply(MISSING));
    let finishSave: (v: never) => void = () => {};
    m.saveGranolaKey.mockReturnValue(new Promise((resolve) => (finishSave = resolve)));
    const second = view();
    await user.type(await screen.findByLabelText("Granola API key"), "grn_fake_key_for_tests");
    await user.click(screen.getByRole("button", { name: "Test and save" }));
    onStatus.mockClear();
    second.unmount();
    finishSave(reply(OK));
    await Promise.resolve();
    await Promise.resolve();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
