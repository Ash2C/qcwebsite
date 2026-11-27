// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AskWindow from "./AskWindow";

afterEach(cleanup);

type Props = Partial<React.ComponentProps<typeof AskWindow>>;
function setup(props: Props = {}) {
  const onCollapsed = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <AskWindow
      busy={false}
      collapsed={false}
      onCollapsed={onCollapsed}
      onClose={onClose}
      looking={null}
      hasConversation={false}
      sound={null}
      {...props}
    >
      <p>inside</p>
    </AskWindow>,
  );
  return { onCollapsed, onClose, ...utils };
}

describe("AskWindow", () => {
  it("is a non-modal dialog named Ask holding its children", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Ask" });
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(document.querySelector("[aria-modal]")).toBeNull();
    expect(dialog).toContainElement(screen.getByText("inside"));
    expect(screen.queryByTestId("ask-backdrop")).toBeNull();
  });

  it("leaves the page behind alone: no inert, no scroll lock", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(
      <div>
        <main data-testid="page" />
        <AskWindow busy={false} collapsed={false} onCollapsed={() => {}} onClose={() => {}} looking={null} hasConversation={false} sound={null}>
          <p>inside</p>
        </AskWindow>
      </div>,
    );
    expect(screen.getByTestId("page")).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("auto");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });

  it("shows the looking line when expanded, and none when null", () => {
    const { unmount } = setup({ looking: "Looking at Anna Lee · Northwind" });
    expect(screen.getByText("Looking at Anna Lee · Northwind")).toBeInTheDocument();
    unmount();
    setup({ looking: null });
    expect(screen.queryByText(/Looking at/)).toBeNull();
  });

  it("the header toggles collapse and reports aria-expanded", () => {
    const { onCollapsed } = setup();
    const header = screen.getByRole("button", { expanded: true });
    fireEvent.click(header);
    expect(onCollapsed).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    expect(onCollapsed).toHaveBeenCalledTimes(2);
  });

  it("collapsed keeps children mounted but hidden, and their state survives collapse and expand", () => {
    const Wrap = ({ collapsed }: { collapsed: boolean }) => (
      <AskWindow busy={false} collapsed={collapsed} onCollapsed={() => {}} onClose={() => {}} looking={null} hasConversation sound={null}>
        <input aria-label="draft" />
      </AskWindow>
    );
    const { rerender } = render(<Wrap collapsed={false} />);
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "typed text" } });
    rerender(<Wrap collapsed />);
    const input = screen.getByLabelText("draft", { selector: "input" });
    expect(input).toBeInTheDocument();
    expect(input).not.toBeVisible();
    rerender(<Wrap collapsed={false} />);
    expect(screen.getByLabelText("draft")).toBeVisible();
    expect(screen.getByLabelText("draft")).toHaveValue("typed text");
  });

  it("collapsed shows only the header and offers to return or to ask", () => {
    const { onCollapsed, unmount } = setup({ collapsed: true, hasConversation: true, looking: "Looking at Anna Lee" });
    expect(screen.getByText("inside")).not.toBeVisible();
    expect(screen.getByText("Tap to return to your conversation")).toBeInTheDocument();
    expect(screen.queryByText(/Looking at/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onCollapsed).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Expand Ask" }));
    expect(onCollapsed).toHaveBeenCalledTimes(2);
    unmount();
    setup({ collapsed: true, hasConversation: false });
    expect(screen.getByText("Tap to ask a question")).toBeInTheDocument();
  });

  it("Close is disabled while busy and calls onClose when idle", () => {
    const first = setup({ busy: true });
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    first.unmount();
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes when idle, not when busy, not during IME composition", () => {
    const busy = setup({ busy: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(busy.onClose).not.toHaveBeenCalled();
    busy.unmount();
    const idle = setup();
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    fireEvent.keyDown(document, { key: "a" });
    expect(idle.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(idle.onClose).toHaveBeenCalledTimes(1);
  });

  it("sound null renders no sound button; otherwise it reflects on and toggles", () => {
    const none = setup({ sound: null });
    expect(screen.queryByRole("button", { name: /spoken answers/ })).toBeNull();
    none.unmount();
    const onToggle = vi.fn();
    const on = setup({ sound: { on: true, onToggle } });
    const btn = screen.getByRole("button", { name: "Turn spoken answers off" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    on.unmount();
    setup({ sound: { on: false, onToggle } });
    expect(screen.getByRole("button", { name: "Turn spoken answers on" })).toHaveAttribute("aria-pressed", "false");
  });
});
