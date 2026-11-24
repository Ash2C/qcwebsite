// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AskSheet from "./AskSheet";

afterEach(cleanup);

describe("AskSheet", () => {
  it("is a modal dialog named Ask holding its children and a Close button", () => {
    render(
      <AskSheet busy={false} onClose={() => {}}>
        <p>inside</p>
      </AskSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Ask" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toContainElement(screen.getByText("inside"));
    expect(dialog).toContainElement(screen.getByRole("button", { name: "Close" }));
  });

  it("Close, the backdrop and Escape each close it; a tap inside does not", () => {
    const onClose = vi.fn();
    render(
      <AskSheet busy={false} onClose={onClose}>
        <p>inside</p>
      </AskSheet>,
    );
    fireEvent.click(screen.getByText("inside"));
    fireEvent.click(screen.getByRole("dialog"));
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("ask-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("nothing closes it while busy, and it closes again once released", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <AskSheet busy onClose={onClose}>
        <p>inside</p>
      </AskSheet>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("ask-backdrop"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(
      <AskSheet busy={false} onClose={onClose}>
        <p>inside</p>
      </AskSheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops the page behind from scrolling while open and restores it after", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(
      <AskSheet busy={false} onClose={() => {}}>
        <p>inside</p>
      </AskSheet>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });
});
