import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { actOnCrm, askCrm, researchContact, loadEstates, loadProfile, proposeChange, searchContacts, readCards, refineCard, saveCard, signIn } from "./api";

// `fetch` is stubbed: nothing here touches the network.
const fetchMock = vi.fn();
let timeoutSpy: MockInstance<typeof AbortSignal.timeout>;

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  timeoutSpy = vi.spyOn(AbortSignal, "timeout");
});
afterEach(() => {
  timeoutSpy.mockRestore();
  vi.unstubAllGlobals();
});

const refine = { fields: { name: "A", title: "", org: "", email: "", phone: "", linkedin: "" }, notes: "", spoken: "x" };
const save = { estate: "traxo", captureId: "c", role: "r", fields: { name: "A" } };
const act = { estate: "traxo", proposal: { kind: "add_note" } as never, signature: "s" };

// The phone's local date, as the client sends it with the Contacts list.
const NOW = new Date();
const LOCAL_DAY = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`;
const CALLS: [string, string, number, () => Promise<unknown>][] = [
  ["signIn", "/api/monsoon/session", 15_000, () => signIn("acme", "pass")],
  ["loadEstates", "/api/monsoon/estates", 15_000, () => loadEstates()],
  ["readCards", "/api/monsoon/read", 90_000, () => readCards(new Blob(["x"]), "traxo")],
  ["saveCard", "/api/monsoon/save", 35_000, () => saveCard(save)],
  ["refineCard", "/api/monsoon/refine", 35_000, () => refineCard(refine)],
  ["actOnCrm", "/api/monsoon/act", 35_000, () => actOnCrm(act)],
  ["researchContact", "/api/monsoon/research", 70_000, () => researchContact({ estate: "traxo", personId: "p1" })],
  ["searchContacts", `/api/monsoon/contacts?estate=traxo&q=jane+tan&today=${LOCAL_DAY}`, 15_000, () => searchContacts("traxo", "jane tan")],
  [
    "searchContacts (sifted)",
    `/api/monsoon/contacts?estate=traxo&q=&today=${LOCAL_DAY}&high=1&sort=next`,
    15_000,
    () => searchContacts("traxo", "", { high: true, sort: "next" }),
  ],
  ["loadProfile", "/api/monsoon/contact?estate=traxo&today=2026-11-13&personId=p1", 15_000, () => loadProfile("traxo", { personId: "p1" }, "2026-11-13")],
  ["proposeChange", "/api/monsoon/propose", 35_000, () => proposeChange({ estate: "traxo", kind: "add_note", target: { memberId: "m1" }, text: "hi" })],
  ["askCrm", "/api/monsoon/ask", 70_000, () => askCrm({ estate: "traxo", today: "2026-11-13", messages: [] })],
];

describe("client timeouts", () => {
  it.each(CALLS)("%s passes an abort signal that times out after the right limit", async (_name, url, ms, call) => {
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(ms);
  });

  it("readCards sends the estate beside the image and returns cards with matches", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ cards: [], matches: [{ match: "none", candidates: [] }] }), { status: 200 }),
    );
    const res = await readCards(new Blob(["x"]), "zeroone");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const form = init.body as FormData;
    expect(form.get("estate")).toBe("zeroone");
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(res.body).toEqual({ cards: [], matches: [{ match: "none", candidates: [] }] });
  });

  it("keeps each call's own method, headers and body beside the signal", async () => {
    await saveCard(save);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(save);
    await loadEstates();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: "no-store" });
  });

  it("an aborted request rejects like a network failure, and a late response is never used", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
        }),
    );
    timeoutSpy.mockImplementation(() => {
      const c = new AbortController();
      queueMicrotask(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")));
      return c.signal;
    });
    await expect(askCrm({ estate: "traxo", today: "2026-11-13", messages: [] })).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(saveCard(save)).rejects.toThrow();
  });

  it("actOnCrm sends the ticked ids and the summary text in the body", async () => {
    await actOnCrm({ ...act, ticked: ["f1", "f3"], text: "Summary." });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      estate: "traxo", proposal: { kind: "add_note" }, signature: "s", ticked: ["f1", "f3"], text: "Summary.",
    });
  });

  it("still returns a non-2xx status as data, not an exception", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 502 }));
    await expect(actOnCrm(act)).resolves.toEqual({ status: 502, body: { error: "nope" } });
  });

  describe("without AbortSignal.timeout (older iOS Safari)", () => {
    let original: typeof AbortSignal.timeout;
    beforeEach(() => {
      vi.useFakeTimers();
      timeoutSpy.mockRestore();
      original = AbortSignal.timeout;
      Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });
    });
    afterEach(() => {
      Object.defineProperty(AbortSignal, "timeout", { value: original, configurable: true, writable: true });
      vi.useRealTimers();
    });

    it("aborts the request from a timer after the limit", async () => {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_res, rej) => {
            init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
          }),
      );
      const pending = loadEstates();
      const settled = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(14_999);
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
    });

    it("clears the timer once the request settles", async () => {
      await loadEstates();
      expect(vi.getTimerCount()).toBe(0);
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });
  });
});
