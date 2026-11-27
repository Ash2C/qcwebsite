// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ASK, type AskState } from "./AskPanel";
import { useAsk, type AskOutcome } from "./useAsk";
import * as api from "./api";

vi.mock("./api", () => ({ askCrm: vi.fn() }));
const m = vi.mocked(api);

const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "x", available: true, todos: true, roles: [] };
const OTHER = { ...ESTATE, key: "zeroone", label: "Zero One" };

function answer(text: string, extra: Record<string, unknown> = {}) {
  return { status: 200, body: { answer: text, refs: [], proposals: [], ...extra } } as never;
}

function setup(initial: AskState = EMPTY_ASK) {
  const onUnauthorized = vi.fn();
  const hook = renderHook(() => {
    const [state, setState] = useState<AskState>(initial);
    const [estate, setEstate] = useState(ESTATE);
    const ask = useAsk({ estate, state, onChange: setState, viewing: null, onUnauthorized });
    return { ask, state, setState, setEstate };
  });
  return { ...hook, onUnauthorized };
}

function pending() {
  let resolve!: (v: never) => void;
  m.askCrm.mockImplementationOnce(() => new Promise((r) => (resolve = r as never)));
  return (v: never) => resolve(v);
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("useAsk", () => {
  it("a successful send appends the user and assistant turns and returns the turn", async () => {
    m.askCrm.mockResolvedValueOnce(answer("Jane is hot."));
    const { result } = setup({ turns: [], draft: "Who is hot?" });
    let out!: AskOutcome;
    await act(async () => {
      out = await result.current.ask.send();
    });
    expect(result.current.state.turns.map((t) => [t.role, t.content])).toEqual([
      ["user", "Who is hot?"],
      ["assistant", "Jane is hot."],
    ]);
    expect(result.current.state.draft).toBe("");
    expect(out).toEqual({ ok: true, turn: result.current.state.turns[1], audio: null, captions: [] });
    expect(result.current.ask.asking).toBe(false);
    const body = m.askCrm.mock.calls[0][0];
    expect(body.spoken).toBeUndefined();
    expect(body.sound).toBeUndefined();
    expect(result.current.state.turns[1].spoken).toBeUndefined();
  });

  it("a given text leaves the draft alone", async () => {
    m.askCrm.mockResolvedValueOnce(answer("ok"));
    const { result } = setup({ turns: [], draft: "typed" });
    await act(async () => {
      await result.current.ask.send("Prepare me");
    });
    expect(result.current.state.draft).toBe("typed");
    expect(m.askCrm.mock.calls[0][0].messages).toEqual([{ role: "user", content: "Prepare me" }]);
  });

  it("passes spoken and sound on, marks the answer spoken and returns its audio and captions", async () => {
    const captions = [{ text: "Jane is hot.", start: 0, end: 1.2 }];
    m.askCrm.mockResolvedValueOnce(answer("Jane is hot.", { audio: "QUJD", captions }));
    const { result } = setup();
    let out!: AskOutcome;
    await act(async () => {
      out = await result.current.ask.send("Who is hot?", { spoken: true, sound: true });
    });
    const body = m.askCrm.mock.calls[0][0];
    expect(body.spoken).toBe(true);
    expect(body.sound).toBe(true);
    expect(result.current.state.turns[1].spoken).toBe(true);
    expect(out).toEqual({ ok: true, turn: result.current.state.turns[1], audio: "QUJD", captions });
  });

  it("a second send while the first is in flight returns busy and sends once", async () => {
    const resolve = pending();
    const { result } = setup();
    let first!: Promise<AskOutcome>;
    let second!: AskOutcome;
    await act(async () => {
      first = result.current.ask.send("one");
      second = await result.current.ask.send("two");
    });
    expect(second).toEqual({ ok: false, reason: "busy" });
    expect(result.current.ask.asking).toBe(true);
    expect(m.askCrm).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(answer("ok"));
      await first;
    });
    expect(result.current.ask.asking).toBe(false);
  });

  it("an empty question sends nothing", async () => {
    const { result } = setup({ turns: [], draft: "   " });
    let out!: AskOutcome;
    await act(async () => {
      out = await result.current.ask.send();
    });
    expect(out).toEqual({ ok: false, reason: "empty" });
    expect(m.askCrm).not.toHaveBeenCalled();
  });

  it("a 401 puts the question back, calls onUnauthorized and returns unauthorized", async () => {
    m.askCrm.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } });
    const { result, onUnauthorized } = setup({ turns: [], draft: "Why?" });
    let out!: AskOutcome;
    await act(async () => {
      out = await result.current.ask.send();
    });
    expect(out).toEqual({ ok: false, reason: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ turns: [], draft: "Why?" });
    expect(result.current.ask.failure).toBeNull();
  });

  it("a 502 puts the question back, sets the failure and returns failed", async () => {
    m.askCrm.mockResolvedValueOnce({ status: 502, body: { error: "x" } });
    const { result } = setup({ turns: [], draft: "Why?" });
    let out!: AskOutcome;
    await act(async () => {
      out = await result.current.ask.send();
    });
    expect(out).toEqual({ ok: false, reason: "failed" });
    expect(result.current.state).toEqual({ turns: [], draft: "Why?" });
    expect(result.current.ask.failure).toBe("Could not get an answer. Check signal and try again.");
    act(() => result.current.ask.clearFailure());
    expect(result.current.ask.failure).toBeNull();
  });

  it("drops a late answer when the conversation is cleared mid-question", async () => {
    const resolve = pending();
    const { result } = setup();
    let first!: Promise<AskOutcome>;
    act(() => {
      first = result.current.ask.send("q");
    });
    const before = result.current.ask.generation();
    act(() => result.current.setState(EMPTY_ASK));
    expect(result.current.ask.generation()).toBeGreaterThan(before);
    let out!: AskOutcome;
    await act(async () => {
      resolve(answer("stale answer"));
      out = await first;
    });
    expect(out).toEqual({ ok: false, reason: "stale" });
    expect(result.current.state.turns).toEqual([]);
    expect(result.current.ask.asking).toBe(false);
  });

  it("keeps an answer sent from a child's mount effect, which runs before the hook's own effects", async () => {
    m.askCrm.mockResolvedValueOnce(answer("Here you go."));
    const outcomes: AskOutcome[] = [];
    function Child({ send }: { send: ReturnType<typeof useAsk>["send"] }) {
      useEffect(() => {
        void send("Prepare me").then((o) => outcomes.push(o));
        // Once, on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    }
    let turns = 0;
    function Parent() {
      const [state, setState] = useState<AskState>(EMPTY_ASK);
      const ask = useAsk({ estate: ESTATE, state, onChange: setState, viewing: null, onUnauthorized: () => {} });
      turns = state.turns.length;
      return <Child send={ask.send} />;
    }
    render(<Parent />);
    await waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0].ok).toBe(true);
    expect(turns).toBe(2);
  });

  it("drops a late answer when the estate changes mid-question", async () => {
    const resolve = pending();
    const { result } = setup();
    let first!: Promise<AskOutcome>;
    act(() => {
      first = result.current.ask.send("q");
    });
    act(() => result.current.setEstate(OTHER));
    let out!: AskOutcome;
    await act(async () => {
      resolve(answer("stale answer"));
      out = await first;
    });
    expect(out).toEqual({ ok: false, reason: "stale" });
    expect(result.current.state.turns.map((t) => t.content)).toEqual(["q"]);
    await waitFor(() => expect(result.current.ask.asking).toBe(false));
  });
});
