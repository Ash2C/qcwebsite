// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UpdateBanner, { isNewer } from "./UpdateBanner";
import { claudeStatusOf, onClaudeStatus, reportClaudeStatus } from "./claudeStatus";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const live = (build: unknown, ok = true) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => ({ build }) })));

describe("isNewer", () => {
  it("is true only for two known, different builds", () => {
    expect(isNewer("aaa", "bbb")).toBe(true);
    expect(isNewer("aaa", "aaa")).toBe(false);
    expect(isNewer("dev", "bbb")).toBe(false);
    expect(isNewer("aaa", "dev")).toBe(false);
    expect(isNewer("aaa", "")).toBe(false);
    expect(isNewer("aaa", undefined)).toBe(false);
  });
});

describe("UpdateBanner", () => {
  it("offers Update when a different build is live", async () => {
    live("bbb");
    render(<UpdateBanner mine="aaa" />);
    expect(await screen.findByText("A new version of Monsoon is ready.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/monsoon/version", { cache: "no-store" });
  });

  it("shows nothing for the same build, a failed answer or no connection", async () => {
    live("aaa");
    render(<UpdateBanner mine="aaa" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    cleanup();

    live("bbb", false);
    render(<UpdateBanner mine="aaa" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    render(<UpdateBanner mine="aaa" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });
});

describe("claudeStatus", () => {
  it("reads what a Claude route's answer says about the key", () => {
    expect(claudeStatusOf({ status: 200, body: { cards: [] } })).toBe("ok");
    expect(claudeStatusOf({ status: 200, body: { status: "none" } }, false)).toBeNull();
    expect(claudeStatusOf({ status: 409, body: { error: "claude_key_missing" } })).toBe("missing");
    expect(claudeStatusOf({ status: 409, body: { error: "claude_key_rejected" } })).toBe("key_rejected");
    expect(claudeStatusOf({ status: 409, body: { error: "claude_no_credit" } })).toBe("no_credit");
    expect(claudeStatusOf({ status: 503, body: { error: "claude_busy" } })).toBeNull();
    expect(claudeStatusOf({ status: 502, body: { error: "Could not read the photo" } })).toBeNull();
    expect(claudeStatusOf({ status: 401, body: null })).toBeNull();
  });

  it("tells subscribers until they unsubscribe", () => {
    const fn = vi.fn();
    const off = onClaudeStatus(fn);
    reportClaudeStatus("no_credit");
    off();
    reportClaudeStatus("ok");
    expect(fn.mock.calls).toEqual([["no_credit"]]);
  });
});
