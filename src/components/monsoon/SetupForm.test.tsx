// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupForm from "./SetupForm";

const TOKEN = "t".repeat(43);
const fetchMock = vi.fn();

describe("SetupForm", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows one field, Claude API key, and posts only token and claudeKey", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, message: "Connected. You can close this page." })));
    render(<SetupForm token={TOKEN} />);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(document.querySelectorAll("input")).toHaveLength(1);
    expect(screen.getByLabelText("Claude API key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Claude API key")).toBeRequired();
    for (const label of ["Project reference", "Pooler host", "monsoon_app password"]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Claude API key"), "sk-ant-key");
    await user.click(screen.getByRole("button", { name: "Test and connect" }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/monsoon/setup");
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN, claudeKey: "sk-ant-key" });
  });

  it("clears and hides the form after success", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, message: "Connected. You can close this page." })));
    render(<SetupForm token={TOKEN} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Claude API key"), "sk-ant-key");
    await user.click(screen.getByRole("button", { name: "Test and connect" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Connected. You can close this page.");
    expect(screen.queryByLabelText("Claude API key")).not.toBeInTheDocument();
  });

  it("shows the server error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "That Claude key didn't work. Check it in the Claude Console.", failure: "claude_key" }), {
        status: 422,
      }),
    );
    render(<SetupForm token={TOKEN} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Claude API key"), "sk-ant-key");
    await user.click(screen.getByRole("button", { name: "Test and connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That Claude key didn't work.");
    expect(screen.getByLabelText("Claude API key")).toBeInTheDocument();
  });
});
