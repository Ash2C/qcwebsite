// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import Home from "./page";

beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

describe("homepage scrolling", () => {
  it("clips horizontal decoration without creating a vertical scroll container", () => {
    const { container } = render(<Home />);
    const main = container.querySelector("main");

    expect(main).toHaveClass("overflow-x-clip");
    expect(main).not.toHaveClass("overflow-x-hidden");
  });
});
