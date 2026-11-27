// @vitest-environment jsdom
import React, { useRef, useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import DictatedField, { type DictatedHandle } from "./DictatedField";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
});

function Field(props: { max?: number; readOnly?: boolean; initial?: string; onHandle?: (h: DictatedHandle | null) => void }) {
  const [value, setValue] = useState(props.initial ?? "");
  const handle = useRef<DictatedHandle | null>(null);
  props.onHandle?.(handle.current);
  return <DictatedField label="Notes" value={value} max={props.max ?? 20} readOnly={props.readOnly} onChange={setValue} handleRef={handle} />;
}

describe("DictatedField", () => {
  it("shows the label and takes typing", async () => {
    const user = userEvent.setup();
    render(<Field />);
    await user.type(screen.getByLabelText("Notes"), "hello");
    expect(screen.getByLabelText("Notes")).toHaveValue("hello");
  });

  it("limits the text to max characters", async () => {
    const user = userEvent.setup();
    render(<Field max={5} />);
    await user.type(screen.getByLabelText("Notes"), "abcdefgh");
    expect(screen.getByLabelText("Notes")).toHaveValue("abcde");
  });

  it("read-only keeps the text and disables the microphone", async () => {
    const user = userEvent.setup();
    render(<Field readOnly initial="kept" />);
    await user.type(screen.getByLabelText("Notes"), "more");
    expect(screen.getByLabelText("Notes")).toHaveValue("kept");
    expect(screen.getByRole("button", { name: "Speak: Notes" })).toBeDisabled();
  });

  it("uses the given microphone names", () => {
    render(<DictatedField label="What" value="" max={5} onChange={() => {}} speakLabel="Speak the to-do" />);
    expect(screen.getByRole("button", { name: "Speak the to-do" })).toBeInTheDocument();
  });

  it("says so when the browser cannot listen", async () => {
    const user = userEvent.setup();
    render(<Field />);
    await user.click(screen.getByRole("button", { name: "Speak: Notes" }));
    expect(screen.getByText("This browser cannot listen. Use the microphone on the keyboard.")).toBeInTheDocument();
  });

  it("adds what is heard after what is typed, and Stop listening is offered while listening", async () => {
    const user = userEvent.setup();
    let rec: { onresult?: (e: unknown) => void } = {};
    class FakeRec {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror = null;
      onend = null;
      constructor() {
        rec = this as never;
      }
      start() {}
      stop() {}
      abort() {}
    }
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRec;
    render(<Field initial="Hi" />);
    await user.click(screen.getByRole("button", { name: "Speak: Notes" }));
    expect(screen.getByRole("button", { name: "Stop listening: Notes" })).toBeInTheDocument();
    const { act } = await import("@testing-library/react");
    act(() => rec.onresult?.({ results: [[{ transcript: "there" }]] }));
    expect(screen.getByLabelText("Notes")).toHaveValue("Hi there");
  });
});
