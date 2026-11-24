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

  it("takes the keyboard focus on opening, unless something inside already has it", () => {
    const first = render(
      <AskSheet busy={false} onClose={() => {}}>
        <p>inside</p>
      </AskSheet>,
    );
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    first.unmount();
    render(
      <AskSheet busy={false} onClose={() => {}}>
        <input aria-label="question" autoFocus />
      </AskSheet>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("question"));
  });

  it("makes the page behind it inert while open, and gives it back after", () => {
    const { unmount } = render(
      <div>
        <main data-testid="page">
          <button>Save</button>
        </main>
        <aside data-testid="was-inert" inert />
        <AskSheet busy={false} onClose={() => {}}>
          <p>inside</p>
        </AskSheet>
      </div>,
    );
    expect(screen.getByTestId("page")).toHaveAttribute("inert");
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    unmount();
  });

  it("gives the page back exactly as it was: what was already inert stays inert", () => {
    function Page({ open }: { open: boolean }) {
      return (
        <div>
          <main data-testid="page" />
          <aside data-testid="was-inert" inert />
          {open ? (
            <AskSheet busy={false} onClose={() => {}}>
              <p>inside</p>
            </AskSheet>
          ) : null}
        </div>
      );
    }
    const { rerender } = render(<Page open />);
    expect(screen.getByTestId("page")).toHaveAttribute("inert");
    rerender(<Page open={false} />);
    expect(screen.getByTestId("page")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("was-inert")).toHaveAttribute("inert");
  });

  it("Escape pressed to finish typing with an input method does not close it", () => {
    const onClose = vi.fn();
    render(
      <AskSheet busy={false} onClose={onClose}>
        <p>inside</p>
      </AskSheet>,
    );
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
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
