// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import OfferedTodos, { appendOffered } from "./OfferedTodos";
import type { OfferedTodo } from "@/lib/monsoon/refine";

afterEach(cleanup);

const A: OfferedTodo = { title: "Send the deck", due: "2026-11-27" };
const B: OfferedTodo = { title: "Call back", due: null };
let latest: OfferedTodo[] = [];

function Harness({ initial }: { initial: OfferedTodo[] }) {
  const [todos, setTodos] = useState(initial);
  latest = todos;
  return <OfferedTodos todos={todos} onChange={setTodos} />;
}

describe("OfferedTodos", () => {
  it("shows the heading and one line per to-do, with or without a date", () => {
    render(<Harness initial={[A, B]} />);
    expect(screen.getByRole("heading", { name: "To do" })).toBeInTheDocument();
    expect(screen.getByText("Send the deck · 27 Nov")).toBeInTheDocument();
    expect(screen.getByText("Call back · no date")).toBeInTheDocument();
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<Harness initial={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("removes one to-do and Undo puts it back in place", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[A, B]} />);
    await user.click(screen.getByRole("button", { name: "Remove to-do: Send the deck" }));
    expect(latest).toEqual([B]);
    expect(screen.queryByText("Send the deck · 27 Nov")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest).toEqual([A, B]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("keeps Undo after the last one is removed", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[B]} />);
    await user.click(screen.getByRole("button", { name: "Remove to-do: Call back" }));
    expect(latest).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(latest).toEqual([B]);
  });
});

describe("appendOffered", () => {
  it("skips an exact title already listed and stops at 5", () => {
    expect(appendOffered([A], [A, B])).toEqual([A, B]);
    const many = ["1", "2", "3", "4", "5", "6"].map((title) => ({ title, due: null }));
    expect(appendOffered([A], many)).toHaveLength(5);
    expect(appendOffered([A], undefined)).toEqual([A]);
  });
});
