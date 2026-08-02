// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import Hero from "./Hero";
import Capabilities from "./Capabilities";
import Audience from "./Audience";
import Contact from "./Contact";
import Footer from "./Footer";

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

describe("QC AI analyst positioning", () => {
  it("covers broad research universes and publication-ready output", () => {
    const { container } = render(
      <>
        <Hero />
        <Capabilities />
        <Audience />
        <Contact />
        <Footer />
      </>
    );
    const copy = container.textContent || "";

    expect(copy).toMatch(/public companies/i);
    expect(copy).toMatch(/private companies/i);
    expect(copy).toMatch(/industr(?:y|ies)/i);
    expect(copy).toMatch(/themes/i);
    expect(copy).toMatch(/publication-ready/i);
    expect(copy).toMatch(/internal (?:use|decisions)/i);
  });

  it("keeps the customer-facing QC experience independent", () => {
    const { container } = render(
      <>
        <Hero />
        <Capabilities />
        <Audience />
        <Contact />
        <Footer />
      </>
    );
    const copy = container.textContent || "";

    expect(copy).not.toMatch(/Zero One|The Blade/i);
    expect(copy).not.toMatch(/marketing content/i);
    expect(copy).not.toMatch(/US-listed|US stocks/i);
  });
});
