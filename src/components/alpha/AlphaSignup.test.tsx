// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
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

describe("Monsoon alpha sign-up page (paused)", () => {
  it("shows the logo, the line, and the sign-in link", () => {
    render(<AlphaSignup />);
    expect(screen.getByRole("img", { name: "Monsoon" })).toHaveAttribute("src", "/monsoon/brand/monsoon-logo-on-dark.svg");
    expect(screen.getByRole("heading", { name: "Make it rain." })).toBeInTheDocument();
    expect(screen.getByText("Private alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/monsoon");
  });

  it("while paused the form says Opening soon and cannot send anything", async () => {
    render(<AlphaSignup />);
    const button = screen.getByRole("button", { name: "Opening soon" });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    await userEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without Sign in with Google the page is as it was: the paused form, no Google button, no extra line", () => {
    render(<AlphaSignup google={false} signups={true} />);
    expect(screen.getByRole("button", { name: "Opening soon" })).toBeDisabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Google/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});

describe("Monsoon home page with Sign in with Google", () => {
  it("replaces the paused form with the button and one line", () => {
    render(<AlphaSignup google signups />);
    const link = screen.getByRole("link", { name: "Sign in with Google" });
    expect(link).toHaveAttribute("href", "/api/monsoon/google/start");
    expect(link).not.toHaveAttribute("target");
    expect(link.className).toContain("google");
    expect(screen.getByText("Sign in with Google to request access.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // The rest of the page stays.
    expect(screen.getByRole("heading", { name: "Make it rain." })).toBeInTheDocument();
    expect(screen.getByText("Private alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/monsoon");
    expect(document.querySelector("img[src*='google' i]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing about requesting access while new sign-ups cannot be taken", () => {
    render(<AlphaSignup google signups={false} />);
    expect(screen.getByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/api/monsoon/google/start");
    expect(screen.queryByText("Sign in with Google to request access.")).not.toBeInTheDocument();
    expect(screen.queryByText(/request access/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });
});
