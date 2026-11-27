// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import DueDatePicker from "./DueDatePicker";
import { dueFromChoice, type DateChoice } from "./todoDates";

afterEach(cleanup);

function Picker({ start = "today" as DateChoice }) {
  const [choice, setChoice] = useState<DateChoice>(start);
  const [picked, setPicked] = useState("");
  return (
    <>
      <DueDatePicker choice={choice} picked={picked} onChoice={setChoice} onPicked={setPicked} />
      <output data-testid="due">{String(dueFromChoice(choice, picked, "2026-11-26"))}</output>
    </>
  );
}

describe("DueDatePicker", () => {
  it("shows the five choices in order under When, with the current one pressed", () => {
    render(<Picker />);
    expect(screen.getByRole("group", { name: "When" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Today", "Tomorrow", "Next week", "Pick a date", "No date"]);
    expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");
  });

  it("choosing a choice changes the pressed one and the due date", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    await user.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect(screen.getByRole("button", { name: "Tomorrow" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("due")).toHaveTextContent("2026-11-27");
    await user.click(screen.getByRole("button", { name: "No date" }));
    expect(screen.getByTestId("due")).toHaveTextContent("null");
  });

  it("Pick a date shows a date box, and the picked day is the due date", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    expect(screen.queryByLabelText("Date")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pick a date" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-12-24" } });
    expect(screen.getByTestId("due")).toHaveTextContent("2026-12-24");
  });
});
