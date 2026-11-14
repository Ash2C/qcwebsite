// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { useCardConfirm, type AskCard } from "./useCardConfirm";

vi.mock("./api", () => ({ actOnCrm: vi.fn() }));
const m = vi.mocked(api);

const PROPOSAL = { kind: "apply_research", estate: "traxo", person: { id: "p1", name: "Jane Tan" } } as never;
const card: AskCard = { id: "c1", signed: { proposal: PROPOSAL, signature: "real-signature" }, text: "Summary.", state: "open" };

beforeEach(() => {
  vi.resetAllMocks();
  m.actOnCrm.mockResolvedValue({ status: 200, body: { status: "saved", message: "Done." } } as never);
});

function setup(extras: (c: AskCard) => Record<string, unknown>) {
  const patch = vi.fn();
  const hook = renderHook(() =>
    useCardConfirm({
      estateKey: "traxo",
      stateOf: () => "open",
      patch,
      generation: () => 0,
      onUnauthorized: vi.fn(),
      extras,
    }),
  );
  return { hook, patch };
}

describe("useCardConfirm extras", () => {
  it("sends extras with the request", async () => {
    const { hook } = setup((c) => ({ ticked: ["f1"], text: c.text }));
    await hook.result.current.confirm(card);
    expect(m.actOnCrm).toHaveBeenCalledWith({
      ticked: ["f1"], text: "Summary.", estate: "traxo", proposal: PROPOSAL, signature: "real-signature",
    });
  });

  it("does not let extras override the estate, proposal or signature", async () => {
    const { hook } = setup(() => ({ estate: "zeroone", proposal: { kind: "move_stage" }, signature: "forged", ticked: ["f1"] }));
    await hook.result.current.confirm(card);
    const sent = m.actOnCrm.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.estate).toBe("traxo");
    expect(sent.proposal).toBe(PROPOSAL);
    expect(sent.signature).toBe("real-signature");
    expect(sent.ticked).toEqual(["f1"]);
  });
});
