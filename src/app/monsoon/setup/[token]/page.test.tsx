// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadSetupPage = vi.fn();
vi.mock("@/lib/monsoon/accounts/setup-link", async (orig) => ({
  ...(await orig<typeof import("@/lib/monsoon/accounts/setup-link")>()),
  loadSetupPage: (...a: unknown[]) => loadSetupPage(...a),
}));

import SetupLinkPage from "./page";
import { SETUP_EXPIRED } from "@/lib/monsoon/accounts/setup-link";

const TOKEN = "t".repeat(43);
async function renderPage() {
  render(await SetupLinkPage({ params: Promise.resolve({ token: TOKEN }) }));
}

describe("setup link page", () => {
  beforeEach(() => loadSetupPage.mockReset());
  afterEach(cleanup);

  it("a key link shows the exact instruction text and the form", async () => {
    loadSetupPage.mockResolvedValue({ kind: "ok", purpose: "key", claudeKeyOnFile: false });
    await renderPage();
    expect(
      screen.getByText(
        "Enter your Claude API key. Monsoon tests it before keeping it. You can create a key in the Claude Console at platform.claude.com (a claude.ai subscription can't be used).",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Claude API key")).toBeInTheDocument();
  });

  it("an expired link shows SETUP_EXPIRED and no form", async () => {
    loadSetupPage.mockResolvedValue({ kind: "expired" });
    await renderPage();
    expect(screen.getByText(SETUP_EXPIRED)).toBeInTheDocument();
    expect(document.querySelector("form")).toBeNull();
  });

  it("the page never renders a SQL script", async () => {
    loadSetupPage.mockResolvedValue({ kind: "ok", purpose: "key", claudeKeyOnFile: true });
    await renderPage();
    expect(document.querySelector("pre")).toBeNull();
    expect(document.body.textContent).not.toContain("CREATE TABLE");
  });
});
