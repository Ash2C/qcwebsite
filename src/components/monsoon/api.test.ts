import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { actOnCrm, addUserNote, askCrm, disconnectGranolaKey, loadGranolaKey, saveGranolaKey, testGranolaKey, loadUserPage, saveUserPage, researchContact, loadEstates, loadProfile, proposeChange, searchContacts, readCards, refineCard, saveCard, signIn, actOnRequest, loadRequests, loadSignInOptions, mapImportColumns, checkImportRows, saveImportRows, loadImports, loadImportContacts, loadTodos, todoAction } from "./api";

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

const IMPORT_SAVE = {
  pipeline: "traxo",
  importId: "3f0c2a52-8a4e-4c56-9d0a-1b2c3d4e5f60",
  label: "LinkedIn import, Nov 2026",
  role: "lp_prospect",
  includePossible: false,
  first: true as const,
  rows: [{ rowNumber: 0, contact: { name: "Jane Tan" } }],
};

const PAGE_INPUT = { name: "Dana", phone: null, email: null, company: "Acme", website: null, roleObjectives: null };

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
  ["loadUserPage", "/api/monsoon/me?estate=zero+one", 15_000, () => loadUserPage("zero one")],
  ["loadGranolaKey", "/api/monsoon/granola-key", 15_000, () => loadGranolaKey()],
  ["testGranolaKey", "/api/monsoon/granola-key", 35_000, () => testGranolaKey()],
  ["saveGranolaKey", "/api/monsoon/granola-key", 35_000, () => saveGranolaKey("grn_fake_key_for_tests")],
  ["disconnectGranolaKey", "/api/monsoon/granola-key", 35_000, () => disconnectGranolaKey()],
  ["saveUserPage", "/api/monsoon/me", 35_000, () => saveUserPage("traxo", PAGE_INPUT)],
  ["addUserNote", "/api/monsoon/me/notes", 35_000, () => addUserNote("traxo", "A note")],
  ["loadSignInOptions", "/api/monsoon/version", 15_000, () => loadSignInOptions()],
  ["loadRequests", "/api/monsoon/requests", 15_000, () => loadRequests()],
  ["actOnRequest (approve)", "/api/monsoon/requests", 70_000, () => actOnRequest("id-1", "approve")],
  ["actOnRequest (decline)", "/api/monsoon/requests", 35_000, () => actOnRequest("id-1", "decline")],
  ["actOnRequest (reopen)", "/api/monsoon/requests", 35_000, () => actOnRequest("id-1", "reopen")],
  ["mapImportColumns", "/api/monsoon/import/map", 35_000, () => mapImportColumns(["Name"], [["Jane"]])],
  ["checkImportRows", "/api/monsoon/import/check", 35_000, () => checkImportRows("traxo", [{ name: "Jane" }, null])],
  ["saveImportRows", "/api/monsoon/import/save", 70_000, () => saveImportRows(IMPORT_SAVE)],
  ["loadImports", "/api/monsoon/contacts?estate=zero+one&imports=1", 15_000, () => loadImports("zero one")],
  [
    "loadImportContacts",
    `/api/monsoon/contacts?estate=traxo&import=LinkedIn+import%2C+Nov+2026&today=${LOCAL_DAY}`,
    15_000,
    () => loadImportContacts("traxo", "LinkedIn import, Nov 2026"),
  ],
  [
    "loadImportContacts (sifted)",
    `/api/monsoon/contacts?estate=traxo&import=A&today=${LOCAL_DAY}&high=1&sort=stage`,
    15_000,
    () => loadImportContacts("traxo", "A", { high: true, sort: "stage" }),
  ],
  ["loadTodos", `/api/monsoon/todos?estate=traxo&today=${LOCAL_DAY}`, 15_000, () => loadTodos("traxo")],
  ["todoAction", "/api/monsoon/todos", 35_000, () => todoAction("traxo", { action: "complete", id: "t1" })],
];

describe("to-do helpers", () => {
  it("loadTodos sends member and nudges=all when asked", async () => {
    await loadTodos("zero one", { member: "m1", allNudges: true });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/monsoon/todos?estate=zero+one&today=${LOCAL_DAY}&member=m1&nudges=all`);
  });
  it("todoAction posts the body with the estate and the local day", async () => {
    await todoAction("traxo", { action: "add", title: "Call", dueDate: null, target: { memberId: "m1" } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      estate: "traxo",
      today: LOCAL_DAY,
      action: "add",
      title: "Call",
      dueDate: null,
      target: { memberId: "m1" },
    });
  });
  it("returns the status and body as data", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ready: false }), { status: 200 }));
    expect(await loadTodos("traxo")).toEqual({ status: 200, body: { ready: false } });
  });
});

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

  it("the user's page is read fresh, saved with PUT and its notes added with POST, each naming the estate", async () => {
    await loadUserPage("traxo");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    await saveUserPage("traxo", PAGE_INPUT);
    const put = fetchMock.mock.calls[1][1] as RequestInit;
    expect(put.method).toBe("PUT");
    expect(put.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(put.body as string)).toEqual({ estate: "traxo", ...PAGE_INPUT });
    await addUserNote("traxo", "A note");
    const post = fetchMock.mock.calls[2][1] as RequestInit;
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body as string)).toEqual({ estate: "traxo", body: "A note" });
  });

  it("loadSignInOptions says yes only for a clear yes, and never rejects", async () => {
    const answer = (body: unknown, status = 200) =>
      fetchMock.mockImplementationOnce(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    answer({ build: "abc", google: true, signups: true });
    expect(await loadSignInOptions()).toEqual({ google: true, signups: true });
    expect(fetchMock.mock.calls[0][1].cache).toBe("no-store");
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    answer({ build: "abc", google: true, signups: false });
    expect(await loadSignInOptions()).toEqual({ google: true, signups: false });
    // Sign-ups without Google sign-in is not a thing.
    answer({ google: false, signups: true });
    expect(await loadSignInOptions()).toEqual({ google: false, signups: false });
    for (const [body, status] of [[{ build: "abc" }, 200], [{ google: "yes", signups: 1 }, 200], [null, 200], ["<html>", 200], [{ google: true, signups: true }, 503]] as const) {
      answer(body, status);
      expect(await loadSignInOptions()).toEqual({ google: false, signups: false });
    }
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await loadSignInOptions()).toEqual({ google: false, signups: false });
  });

  it("requests are read fresh, and answered with a POST naming the request and the action", async () => {
    await loadRequests();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/monsoon/requests");
    expect(fetchMock.mock.calls[0][1].cache).toBe("no-store");
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    await actOnRequest("id-1", "approve");
    await actOnRequest("id-2", "decline");
    await actOnRequest("id-3", "reopen");
    const bodies = fetchMock.mock.calls.slice(1).map(([url, init]) => {
      expect(url).toBe("/api/monsoon/requests");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
      return JSON.parse(init.body);
    });
    expect(bodies).toEqual([
      { id: "id-1", action: "approve" },
      { id: "id-2", action: "decline" },
      { id: "id-3", action: "reopen" },
    ]);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "busy" }), { status: 409 }));
    expect(await actOnRequest("id-1", "approve")).toEqual({ status: 409, body: { error: "busy" } });
  });

  it("the Granola key is read fresh, and tested, saved and disconnected with POST", async () => {
    await loadGranolaKey();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/monsoon/granola-key");
    expect(fetchMock.mock.calls[0][1].cache).toBe("no-store");
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    await testGranolaKey();
    await saveGranolaKey("grn_fake_key_for_tests");
    await disconnectGranolaKey();
    const bodies = fetchMock.mock.calls.slice(1).map(([url, init]) => {
      expect(url).toBe("/api/monsoon/granola-key");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
      return JSON.parse(init.body);
    });
    expect(bodies).toEqual([{ test: true }, { granolaKey: "grn_fake_key_for_tests" }, { disconnect: true }]);
  });

  it("the import calls post JSON: the headings and samples, the rows to check, and one batch to save", async () => {
    await mapImportColumns(["Name"], [["Jane"]]);
    await checkImportRows("traxo", [{ name: "Jane" }, null]);
    await saveImportRows(IMPORT_SAVE);
    const bodies = fetchMock.mock.calls.map(([, init]) => {
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
      return JSON.parse(init.body as string);
    });
    expect(bodies[0]).toEqual({ headers: ["Name"], samples: [["Jane"]] });
    expect(bodies[1]).toEqual({ pipeline: "traxo", rows: [{ name: "Jane" }, null] });
    expect(bodies[2]).toEqual(IMPORT_SAVE);
  });

  it("the imports and the contacts of one import are read fresh", async () => {
    await loadImports("traxo");
    await loadImportContacts("traxo", "A");
    for (const [, init] of fetchMock.mock.calls) expect(init.cache).toBe("no-store");
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

  it("saveCard sends the local day with offered to-dos, and nothing extra without them", async () => {
    const todos = [{ title: "Send the deck", due: "2026-11-27" }];
    await saveCard({ ...save, todos });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ ...save, todos, today: LOCAL_DAY });
    await saveCard({ ...save, todos: [] });
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ ...save, todos: [] });
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
