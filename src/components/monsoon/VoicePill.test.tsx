// @vitest-environment jsdom
import React, { createRef } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoicePill from "./VoicePill";
import type { useVoiceAsk } from "./useVoiceAsk";

type Voice = ReturnType<typeof useVoiceAsk>;

function voiceOf(over: Partial<Voice> = {}): Voice {
  return {
    phase: "idle",
    heard: "",
    caption: "",
    notice: null,
    secondsLeft: 20,
    canReplay: false,
    lastTurn: null,
    onPill: vi.fn(),
    replay: vi.fn(),
    stop: vi.fn(),
    clearNotice: vi.fn(),
    ...over,
  };
}

function setup(over: Partial<Voice> = {}, props: Partial<React.ComponentProps<typeof VoicePill>> = {}) {
  const voice = voiceOf(over);
  const onKeyboard = vi.fn();
  const onRate = vi.fn();
  const buttonRef = createRef<HTMLButtonElement>();
  const view = render(
    <VoicePill
      voice={voice}
      disabled={false}
      buttonRef={buttonRef}
      onKeyboard={onKeyboard}
      onRate={onRate}
      rating={null}
      chips={[]}
      {...props}
    />,
  );
  return { ...view, voice, onKeyboard, onRate, buttonRef };
}

const strip = () => screen.queryByRole("status");

afterEach(cleanup);

describe("VoicePill", () => {
  it("idle: reads Ask, taps start listening, and the ref points at the pill", async () => {
    const user = userEvent.setup();
    const { voice, buttonRef } = setup();
    const pill = screen.getByRole("button", { name: "Ask: tap and speak your question" });
    expect(pill).toHaveTextContent("Ask");
    expect(buttonRef.current).toBe(pill);
    await user.click(pill);
    expect(voice.onPill).toHaveBeenCalledTimes(1);
    expect(strip()).toBeNull();
  });

  it("listening: red, Tap when done, and the strip counts down with the words heard", () => {
    setup({ phase: "listening", secondsLeft: 14, heard: "who is warm" });
    const pill = screen.getByRole("button", { name: "Stop listening and ask" });
    expect(pill).toHaveTextContent("Tap when done");
    expect(pill.className).toContain("bg-red-600");
    expect(strip()).toHaveTextContent("Listening · 14s");
    expect(strip()).toHaveTextContent("who is warm");
  });

  it("listening with nothing heard yet shows the placeholder", () => {
    setup({ phase: "listening" });
    expect(strip()).toHaveTextContent("Listening · 20s");
    expect(strip()).toHaveTextContent("Ask about your CRM…");
  });

  it("thinking: the loader, Thinking, disabled; the strip shows You asked and the question", () => {
    setup({ phase: "thinking", heard: "Who is warm?" });
    const pill = screen.getByRole("button", { name: "Thinking" });
    expect(pill).toBeDisabled();
    expect(within(pill).getByTestId("monsoon-loader")).toBeInTheDocument();
    expect(strip()).toHaveTextContent("You asked");
    expect(strip()).toHaveTextContent("Who is warm?");
  });

  it("speaking: a stop square, Stop, and the caption in the strip", async () => {
    const user = userEvent.setup();
    const { voice } = setup({ phase: "speaking", caption: "Anna Lee is at Northwind." });
    const pill = screen.getByRole("button", { name: "Stop the answer" });
    expect(pill).toHaveTextContent("Stop");
    expect(strip()).toHaveTextContent("Anna Lee is at Northwind.");
    await user.click(pill);
    expect(voice.onPill).toHaveBeenCalledTimes(1);
  });

  it("disabled: idle is disabled, but listening and speaking can still be stopped", () => {
    const idle = setup({}, { disabled: true });
    expect(screen.getByRole("button", { name: "Ask: tap and speak your question" })).toBeDisabled();
    idle.unmount();
    const listening = setup({ phase: "listening" }, { disabled: true });
    expect(screen.getByRole("button", { name: "Stop listening and ask" })).toBeEnabled();
    listening.unmount();
    setup({ phase: "speaking", caption: "x" }, { disabled: true });
    expect(screen.getByRole("button", { name: "Stop the answer" })).toBeEnabled();
  });

  it("the not-heard notice shows in the strip", () => {
    setup({ notice: "not_heard" });
    expect(strip()).toHaveTextContent("I did not catch that. Tap and try again.");
  });

  it("the keyboard button shows only when idle and opens typing", async () => {
    const user = userEvent.setup();
    const { onKeyboard, unmount } = setup();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    expect(onKeyboard).toHaveBeenCalledTimes(1);
    unmount();
    for (const phase of ["listening", "thinking", "speaking"] as const) {
      const v = setup({ phase });
      expect(screen.queryByRole("button", { name: "Type a question instead" })).toBeNull();
      v.unmount();
    }
  });

  it("replay and thumbs show only while replay is offered", async () => {
    const user = userEvent.setup();
    const none = setup();
    expect(screen.queryByRole("button", { name: "Replay the answer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Good answer" })).toBeNull();
    none.unmount();
    const { voice, onRate } = setup({ canReplay: true }, { rating: "up" });
    await user.click(screen.getByRole("button", { name: "Replay the answer" }));
    expect(voice.replay).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Good answer" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Poor answer" }));
    expect(onRate).toHaveBeenCalledWith("down");
  });

  it("shows at most three chips under the caption while replay is offered; a tap opens one", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const chips = ["Anna Lee", "Bo Chen", "Cy Park", "Di Ross"].map((name) => ({ key: name, name, onOpen: () => onOpen(name) }));
    setup({ canReplay: true }, { chips });
    const row = within(strip()!).getByRole("group", { name: "Contacts mentioned" });
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Anna Lee", "Bo Chen", "Cy Park"]);
    await user.click(within(row).getByRole("button", { name: "Bo Chen" }));
    expect(onOpen).toHaveBeenCalledWith("Bo Chen");
  });

  it("no chips once replay is no longer offered", () => {
    setup({ canReplay: false }, { chips: [{ key: "a", name: "Anna Lee", onOpen: () => {} }] });
    expect(screen.queryByRole("button", { name: "Anna Lee" })).toBeNull();
  });

  it("the strip is a polite live region, fixed just above the pill row, or above the minimised bar", () => {
    const low = setup({ phase: "listening" });
    expect(strip()).toHaveAttribute("aria-live", "polite");
    expect(strip()!.className).toContain("max-h-[7.5rem]");
    expect(strip()!.className).toContain("overflow-y-auto");
    expect(strip()!.parentElement!.className).toContain("bottom-[calc(5.5rem+env(safe-area-inset-bottom))]");
    low.unmount();
    setup({ phase: "listening" }, { raised: true });
    expect(strip()!.parentElement!.className).toContain("bottom-[calc(9.5rem+env(safe-area-inset-bottom))]");
  });

  it("reports the strip's height while it shows and zero once it goes", () => {
    const onStripHeight = vi.fn();
    const v = setup({ phase: "listening" }, { onStripHeight });
    expect(onStripHeight).toHaveBeenCalled();
    v.rerender(
      <VoicePill
        voice={voiceOf()}
        disabled={false}
        buttonRef={createRef()}
        onKeyboard={() => {}}
        onRate={() => {}}
        rating={null}
        chips={[]}
        onStripHeight={onStripHeight}
      />,
    );
    expect(onStripHeight).toHaveBeenLastCalledWith(0);
  });
});
