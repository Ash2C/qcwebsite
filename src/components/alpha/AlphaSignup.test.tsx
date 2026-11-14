// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AlphaSignup from "./AlphaSignup";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has no canvas; the rain simply does not draw.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Monsoon alpha sign-up page", () => {
  it("shows the logo, the line, and the email form", () => {
    render(<AlphaSignup />);
    expect(screen.getByRole("img", { name: "Monsoon" })).toHaveAttribute("src", "/monsoon/brand/monsoon-logo-on-dark.svg");
    expect(screen.getByRole("heading", { name: "Make it rain." })).toBeInTheDocument();
    expect(screen.getByText("Private alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/monsoon");
  });

  it("an invalid email shows a message and sends nothing", async () => {
    render(<AlphaSignup />);
    await userEvent.type(screen.getByLabelText("Email"), "jane@");
    await userEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(screen.getByText("Enter an email we can send your invite to.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a valid email is sent with an empty honeypot and shows the confirmation", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<AlphaSignup />);
    await userEvent.type(screen.getByLabelText("Email"), "jane@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Request access" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You're on the list."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/monsoon/alpha");
    expect(JSON.parse(init.body)).toEqual({ email: "jane@example.com", website: "" });
  });

  it("a server error shows its message and keeps the email for a retry", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Could not save your email. Try again in a moment." }), { status: 502 }));
    render(<AlphaSignup />);
    await userEvent.type(screen.getByLabelText("Email"), "jane@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Request access" }));
    await waitFor(() => expect(screen.getByText("Could not save your email. Try again in a moment.")).toBeInTheDocument());
    expect(screen.getByLabelText("Email")).toHaveValue("jane@example.com");
    expect(screen.getByRole("button", { name: "Request access" })).toBeEnabled();
  });

  it("no connection shows a connection message", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<AlphaSignup />);
    await userEvent.type(screen.getByLabelText("Email"), "jane@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Request access" }));
    await waitFor(() => expect(screen.getByText("Could not reach us. Check your connection and try again.")).toBeInTheDocument());
  });
});
