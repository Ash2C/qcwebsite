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
});
