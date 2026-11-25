// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RequestPage, { metadata } from "./page";

const RECEIVED = "Request received. You will get in as soon as it is approved. Come back and tap Sign in with Google.";
const WAITING = "Waiting for approval.";
const DECLINED = "This request was not approved.";
const PAUSED = "Sign-ups are paused for now. Try again later.";
const TAKEN = "That Google account is already linked to another Monsoon account.";
const ERROR = "Something went wrong. Try again.";
const ALL = [RECEIVED, WAITING, DECLINED, PAUSED, TAKEN, ERROR];

async function renderPage(searchParams: Record<string, string | string[] | undefined>) {
  render(await RequestPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("the request page", () => {
  afterEach(cleanup);

  it.each([
    ["received", RECEIVED],
    ["waiting", WAITING],
    ["declined", DECLINED],
    ["paused", PAUSED],
    ["taken", TAKEN],
    ["error", ERROR],
  ])("status %s shows its one message and a link back to Monsoon", async (status, message) => {
    await renderPage({ status });
    expect(screen.getByText(message)).toBeInTheDocument();
    for (const other of ALL.filter((m) => m !== message)) expect(screen.queryByText(other)).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/monsoon");
  });

  it("an unknown, missing or repeated status shows the last message, and never echoes what was sent", async () => {
    for (const searchParams of [{}, { status: "nope" }, { status: "<script>alert(1)</script>" }, { status: ["received", "waiting"] }, { status: "" }, { status: "RECEIVED" }]) {
      await renderPage(searchParams);
      expect(screen.getByText(ERROR)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("alert");
      expect(document.body.textContent).not.toContain("nope");
      cleanup();
    }
  });

  it("uses plain wording: no em dashes, and the words Sign in with Google", () => {
    for (const m of ALL) expect(m).not.toMatch(/[–—]/);
    expect(RECEIVED).toContain("Sign in with Google");
  });

  it("is kept out of search engines and sends no referrer", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });
});
