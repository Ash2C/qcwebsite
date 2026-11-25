// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const google = { googleConfigured: vi.fn(), signupsConfigured: vi.fn() };
vi.mock("@/lib/monsoon/google", () => ({
  googleConfigured: () => google.googleConfigured(),
  signupsConfigured: () => google.signupsConfigured(),
}));
// The font is fetched at build time; here it is only a class name.
vi.mock("next/font/google", () => ({ Sora: () => ({ className: "sora" }) }));
import Home, * as page from "./page";

beforeEach(() => {
  // jsdom has no canvas; the rain simply does not draw.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  google.googleConfigured.mockReturnValue(false);
  google.signupsConfigured.mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("the quantcloud.com home page", () => {
  it("is rendered per request, so it follows the server's settings as they are now", () => {
    expect((page as { dynamic?: string }).dynamic).toBe("force-dynamic");
  });

  it("with Sign in with Google off, is the page of before: the paused form and no Google button", () => {
    google.signupsConfigured.mockReturnValue(true);
    render(<Home />);
    expect(screen.getByRole("button", { name: "Opening soon" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Google/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/monsoon");
  });

  it("with Google on and sign-ups ready, shows the button and the request line", () => {
    google.googleConfigured.mockReturnValue(true);
    google.signupsConfigured.mockReturnValue(true);
    render(<Home />);
    expect(screen.getByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/api/monsoon/google/start");
    expect(screen.getByText("Sign in with Google to request access.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Opening soon" })).not.toBeInTheDocument();
  });

  it("with Google on but the shared database not set, shows the button without the request line", () => {
    google.googleConfigured.mockReturnValue(true);
    render(<Home />);
    expect(screen.getByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.queryByText("Sign in with Google to request access.")).not.toBeInTheDocument();
  });
});
