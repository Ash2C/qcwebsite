// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupForm from "./SetupForm";

const TOKEN = "t".repeat(43);
const fetchMock = vi.fn();

async function fill() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Project reference"), "abcdefghij0123456789");
  await user.type(screen.getByLabelText("Pooler host"), "aws-1-us-east-1.pooler.supabase.com");
  await user.type(screen.getByLabelText("monsoon_app password"), "secret-password-123");
  await user.type(screen.getByLabelText("Claude API key"), "sk-ant-key");
  return user;
}

describe("SetupForm", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses password fields for the password and key", () => {
    render(<SetupForm token={TOKEN} purpose="connect" />);
    expect(screen.getByLabelText("monsoon_app password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Claude API key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Project reference")).toBeRequired();
  });

  it("posts the fields with the token, then clears and hides the form on success", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, message: "Connected. You can close this page." })));
    render(<SetupForm token={TOKEN} purpose="connect" />);
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Test and connect" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Connected. You can close this page.");
    expect(screen.queryByLabelText("monsoon_app password")).not.toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/monsoon/setup");
    expect(JSON.parse(init.body)).toEqual({
      token: TOKEN,
      projectRef: "abcdefghij0123456789",
      poolerHost: "aws-1-us-east-1.pooler.supabase.com",
      password: "secret-password-123",
      claudeKey: "sk-ant-key",
    });
  });

  it("shows the server's message and keeps the form on failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "That Claude key didn't work. Check it in your Anthropic console.", failure: "claude_key" }), {
        status: 422,
      }),
    );
    render(<SetupForm token={TOKEN} purpose="connect" />);
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Test and connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That Claude key didn't work.");
    expect(screen.getByLabelText("Pooler host")).toBeInTheDocument();
  });

  it("a connect link with a Claude key on file lets the key be left blank", () => {
    render(<SetupForm token={TOKEN} purpose="connect" claudeKeyOnFile />);
    expect(screen.getByLabelText("Claude API key")).not.toBeRequired();
    expect(screen.getByLabelText("Claude API key")).toHaveAttribute(
      "placeholder",
      "Leave blank to keep the Claude key already on file",
    );
    expect(screen.getByText("Leave blank to keep the Claude key already on file.")).toBeInTheDocument();
    expect(screen.getByLabelText("Project reference")).toBeRequired();
  });

  it("a connect link without a key on file still requires it", () => {
    render(<SetupForm token={TOKEN} purpose="connect" />);
    expect(screen.getByLabelText("Claude API key")).toBeRequired();
  });

  it("replace links make every field optional", () => {
    render(<SetupForm token={TOKEN} purpose="replace" />);
    expect(screen.getByLabelText("Claude API key")).not.toBeRequired();
    expect(screen.getByLabelText("Claude API key")).toHaveAttribute("placeholder", "Leave blank to keep the current one");
  });
});
