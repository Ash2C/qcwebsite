// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MonsoonLoader from "./MonsoonLoader";

describe("MonsoonLoader", () => {
  it("draws the drop and three bars, hidden from screen readers", () => {
    const { container } = render(<MonsoonLoader />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelectorAll("rect.ml-bar")).toHaveLength(3);
    expect(svg.classList.contains("monsoon-loader-blink")).toBe(true);
  });

  it("uses the rise animation when asked", () => {
    const { container } = render(<MonsoonLoader variant="rise" className="h-28 w-28" />);
    const svg = container.querySelector("svg")!;
    expect(svg.classList.contains("monsoon-loader-rise")).toBe(true);
    expect(svg.classList.contains("h-28")).toBe(true);
  });

  it("gives each instance its own gradient id", () => {
    const { container } = render(
      <>
        <MonsoonLoader />
        <MonsoonLoader />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
    for (const svg of container.querySelectorAll("svg")) {
      const id = svg.querySelector("linearGradient")!.id;
      expect(svg.querySelector("path")!.getAttribute("stroke")).toBe(`url(#${id})`);
    }
  });
});
