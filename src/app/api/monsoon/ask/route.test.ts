import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAsk = vi.fn();
vi.mock("@/lib/monsoon/ask/loop", () => ({ runAsk: (...a: unknown[]) => runAsk(...a) }));
const getProfile = vi.fn();
vi.mock("@/lib/monsoon/contacts", () => ({ getProfile: (...a: unknown[]) => getProfile(...a) }));
const loadAskContext = vi.fn();
vi.mock("@/lib/monsoon/accounts/profile", () => ({ loadAskContext: (...a: unknown[]) => loadAskContext(...a) }));
const readGranolaKeyForAsk = vi.fn();
const recordGranolaStatus = vi.fn();
vi.mock("@/lib/monsoon/accounts/granola-key", () => ({
  readGranolaKeyForAsk: (...a: unknown[]) => readGranolaKeyForAsk(...a),
  recordGranolaStatus: (...a: unknown[]) => recordGranolaStatus(...a),
}));
const todosReady = vi.fn();
vi.mock("@/lib/monsoon/todos", () => ({ todosReady: (...a: unknown[]) => todosReady(...a) }));
const speak = vi.fn();
vi.mock("@/lib/monsoon/ask/speech", async (orig) => ({
  ...(await orig<typeof import("@/lib/monsoon/ask/speech")>()),
  speak: (...a: unknown[]) => speak(...a),
}));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import type { Account } from "@/lib/monsoon/accounts/account";
import { TrialPaused } from "@/lib/monsoon/accounts/not-connected";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { MAX_SPOKEN_CHARS, POST, SPOKEN_DAILY_LIMIT } from "./route";

const fakeDb = { fake: true };
const fakeMessages = { create: vi.fn() };
const RESULT = { answer: "Hi.", refs: [], proposals: [] };
const CUSTOMER = "c0000000-0000-4000-8000-00000000000a";
const PIPELINES = [
  { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", connected: true },
  { key: "zeroone", label: "Zero One", defaultRole: "investor", connected: true },
];
let account: Account;
let withDb: MockInstance<Account["withDb"]>;
let anthropic: MockInstance<Account["anthropic"]>;

function post(body: unknown, authenticated = true): Request {
  if (!authenticated) signOut();
  return new Request("http://localhost/api/monsoon/ask", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const user = (content: string) => ({ role: "user", content });
const valid = (over: Record<string, unknown> = {}) => ({
  estate: "traxo",
  today: "2026-11-13",
  messages: [user("hello")],
  ...over,
});

beforeEach(() => {
  runAsk.mockReset().mockResolvedValue(RESULT);
  speak.mockReset().mockResolvedValue({ audio: "QUJD", captions: [{ text: "Hi.", start: 0, end: 1 }] });
  todosReady.mockReset().mockResolvedValue(false);
  getProfile.mockReset();
  loadAskContext.mockReset().mockResolvedValue(null);
  readGranolaKeyForAsk.mockReset().mockResolvedValue(null);
  recordGranolaStatus.mockReset().mockResolvedValue(undefined);
  account = fakeAccount({
    customer: { id: CUSTOMER },
    person: { name: "Ann Lee", ownerKey: "AL" },
    pipelines: PIPELINES,
    db: fakeDb,
    claude: { messages: fakeMessages },
    model: "claude-sonnet-5-5",
  });
  withDb = vi.spyOn(account, "withDb");
  anthropic = vi.spyOn(account, "anthropic");
  signInAs(account);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// 31 turns of 2,000 characters would also trip the count cap; use 30 turns of 2,001 to hit the total cap.
const longAssistant = { role: "assistant", content: "y".repeat(30_000) };

describe("POST /api/monsoon/ask", () => {
  it("answers 401 without a session and runs nothing", async () => {
    const res = await POST(post(valid(), false));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(runAsk).not.toHaveBeenCalled();
    expect(withDb).not.toHaveBeenCalled();
  });

  const cases: [string, unknown][] = [
    ["malformed JSON", "{nope"],
    ["a non-object body", []],
    ["an estate that is not one of the account's pipelines", valid({ estate: "acme" })],
    ["a missing estate", { messages: [user("hi")] }],
    ["messages not an array", valid({ messages: "hi" })],
    ["empty messages", valid({ messages: [] })],
    ["31 messages", valid({ messages: Array.from({ length: 31 }, () => user("x")) })],
    ["over 60,000 characters", valid({ messages: [longAssistant, longAssistant, longAssistant, user("x")] })],
    ["an entry of the wrong shape", valid({ messages: [{ role: "user" }, user("x")] })],
    ["an unknown role", valid({ messages: [{ role: "system", content: "x" }, user("x")] })],
    ["a last entry that is not a user turn", valid({ messages: [user("x"), { role: "assistant", content: "y" }] })],
    ["a first entry that is an assistant turn", valid({ messages: [{ role: "assistant", content: "hi" }, user("x")] })],
    ["refs that push the total over 60,000", valid({ messages: [user("a"), { role: "assistant", content: "y".repeat(59_990), refs: [{ memberId: M1, name: "n".repeat(200), company: "c".repeat(200), kind: "person" }] }, user("x")] })],
    ["a blank user turn", valid({ messages: [user("   ")] })],
    ["a user turn over 2,000 characters", valid({ messages: [user("x".repeat(2001))] })],
  ];
  it.each(cases)("answers 400 for %s", async (_name, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(runAsk).not.toHaveBeenCalled();
  });

  it("accepts 30 messages and a 2,000 character user turn", async () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" }));
    msgs[29] = user("x".repeat(2000));
    msgs[28] = { role: "assistant", content: "y" };
    expect((await POST(post(valid({ messages: msgs })))).status).toBe(200);
  });

  it("uses the server's UTC date when today is out of range or malformed", async () => {
    for (const today of ["2026-11-20", "2026-11-11", "nonsense", "2026-02-31", 5, undefined]) {
      runAsk.mockClear();
      await POST(post(valid({ today })));
      expect(runAsk.mock.calls[0][0].today).toBe("2026-11-13");
    }
    for (const today of ["2026-11-12", "2026-11-13", "2026-11-14"]) {
      runAsk.mockClear();
      await POST(post(valid({ today })));
      expect(runAsk.mock.calls[0][0].today).toBe(today);
    }
  });

  it("calls runAsk once with estate, label, date and messages, dropping malformed refs", async () => {
    const good = { memberId: M1, name: "Jane", company: "Acme", kind: "person" };
    const co = { memberId: M2, name: "Northwind", company: null, kind: "company" };
    const res = await POST(
      post(
        valid({
          messages: [
            user("who?"),
            {
              role: "assistant",
              content: "Jane.",
              refs: [
                good,
                { memberId: 1, name: "x" },
                "junk",
                { ...good, kind: "robot" },
                { ...good, memberId: "m1" },
                { ...good, name: "n".repeat(201) },
                { ...good, company: "c".repeat(201) },
                co,
                ...Array.from({ length: 40 }, () => good),
              ],
            },
            { role: "assistant", content: "No refs", refs: "nope" },
            user("move her"),
          ],
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(runAsk).toHaveBeenCalledTimes(1);
    const [deps, messages] = runAsk.mock.calls[0];
    expect(deps).toMatchObject({
      db: fakeDb,
      customerId: CUSTOMER,
      estate: "traxo",
      estateLabel: "Traxo",
      defaultRole: "lp_prospect",
      person: { name: "Ann Lee", ownerKey: "AL" },
      model: "claude-sonnet-5-5",
      today: "2026-11-13",
      client: fakeMessages,
    });
    expect(withDb.mock.calls[0][0]).toBe("traxo");
    expect(typeof deps.now()).toBe("number");
    expect(deps.startedAt).toBe(new Date("2026-11-13T10:00:00Z").getTime());
    expect(messages).toEqual([
      user("who?"),
      { role: "assistant", content: "Jane.", refs: [good, co, ...Array.from({ length: 28 }, () => good)] },
      { role: "assistant", content: "No refs", refs: [] },
      user("move her"),
    ]);
    expect(anthropic).toHaveBeenCalledWith({ timeout: 20_000 });
    expect(account.record).toHaveBeenCalledTimes(1);
    expect(account.record).toHaveBeenCalledWith("ask", "traxo");
  });

  it("keeps a UUID-shaped personId on a ref and drops a malformed one, keeping the ref", async () => {
    const P = "33333333-3333-4333-8333-333333333333";
    const jane = { memberId: M1, name: "Jane", company: "Northwind", kind: "company" };
    await POST(
      post(
        valid({
          messages: [
            user("who?"),
            { role: "assistant", content: "Jane.", refs: [{ ...jane, personId: P }, { ...jane, personId: "nope" }, { ...jane, personId: 7 }, jane] },
            user("note her"),
          ],
        }),
      ),
    );
    const messages = runAsk.mock.calls[0][1];
    expect(messages[1].refs).toEqual([{ ...jane, personId: P }, jane, jane, jane]);
    expect(messages[1].refs[1]).not.toHaveProperty("personId");
  });

  it("keeps a UUID-shaped orgId on a ref and drops a malformed one, keeping the ref", async () => {
    const O = "44444444-4444-4444-8444-444444444444";
    const nw = { memberId: M1, name: "Northwind", company: null, kind: "company" };
    await POST(
      post(
        valid({
          messages: [
            user("who?"),
            { role: "assistant", content: "Northwind.", refs: [{ ...nw, orgId: O }, { ...nw, orgId: "nope" }, { ...nw, orgId: 7 }, nw] },
            user("set its website"),
          ],
        }),
      ),
    );
    const messages = runAsk.mock.calls[0][1];
    expect(messages[1].refs).toEqual([{ ...nw, orgId: O }, nw, nw, nw]);
    expect(messages[1].refs[1]).not.toHaveProperty("orgId");
  });

  it("counts a ref's org id toward the 60,000 character cap", async () => {
    const O = "44444444-4444-4444-8444-444444444444";
    const ref = (orgId?: string) => ({ memberId: M1, name: "n", company: null, kind: "company", ...(orgId ? { orgId } : {}) });
    const turn = (r: unknown) => valid({ messages: [user("a"), { role: "assistant", content: "y".repeat(59_961), refs: [r] }, user("x")] });
    expect((await POST(post(turn(ref())))).status).toBe(200);
    expect((await POST(post(turn(ref(O))))).status).toBe(400);
  });

  it("counts a ref's person id toward the 60,000 character cap", async () => {
    const P = "33333333-3333-4333-8333-333333333333";
    const ref = (personId?: string) => ({ memberId: M1, name: "n", company: null, kind: "company", ...(personId ? { personId } : {}) });
    // 2 user chars + 59,961 content + ref text (36 + 1) = 60,000: at the cap without a person id, over it with one
    const turn = (r: unknown) => valid({ messages: [user("a"), { role: "assistant", content: "y".repeat(59_961), refs: [r] }, user("x")] });
    expect((await POST(post(turn(ref())))).status).toBe(200);
    expect((await POST(post(turn(ref(P))))).status).toBe(400);
  });

  it("answers 503 claude_busy when Claude is overloaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    runAsk.mockRejectedValue(Object.assign(new Error("secret"), { name: "APIError", status: 529 }));
    const res = await POST(post(valid()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "claude_busy" });
    expect(account.record).not.toHaveBeenCalled();
  });

  it("answers 409 claude_key_rejected when Claude refuses the key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    runAsk.mockRejectedValue(Object.assign(new Error("secret"), { name: "APIError", status: 401 }));
    const res = await POST(post(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_key_rejected" });
  });

  it("answers 502 and logs only the error name and status when the loop throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = Object.assign(new Error("secret question text postgres://u:pw@h"), { name: "APIError", status: 422 });
    runAsk.mockRejectedValue(err);
    const res = await POST(post(valid()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not get an answer" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["monsoon: ask failed", "APIError", 422]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
    expect(account.record).not.toHaveBeenCalled();
  });

  it("answers 502 when the database cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    withDb.mockRejectedValue(new Error("postgres://u:pw@h"));
    expect((await POST(post(valid()))).status).toBe(502);
    expect(account.record).not.toHaveBeenCalled();
  });

  it("ignores a customer id in the body: the proposals are bound to the signed-in customer", async () => {
    await POST(post(valid({ customer: "c0000000-0000-4000-8000-00000000000b", customerId: "c0000000-0000-4000-8000-00000000000b" })));
    expect(runAsk.mock.calls[0][0].customerId).toBe(CUSTOMER);
  });

  it("answers 409 claude_key_missing without a Claude key and records nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    signInAs(fakeAccount({ pipelines: PIPELINES, db: fakeDb }));
    const res = await POST(post(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_key_missing" });
    expect(runAsk).not.toHaveBeenCalled();
  });

  describe("viewing: the contact open on the user's screen", () => {
    const PROFILE = {
      kind: "person",
      personId: M1,
      orgId: M2,
      name: "Jane Tan",
      company: "Acme Capital",
      member: { memberId: "33333333-3333-4333-8333-333333333333" },
    };
    const viewingOf = () => runAsk.mock.calls[0][0].viewing;

    it("reads the contact from the customer's database and hands runAsk its name, company and ids", async () => {
      getProfile.mockResolvedValue(PROFILE);
      const res = await POST(post(valid({ viewing: { personId: M1, name: "Mallory", company: "Evil" } })));
      expect(res.status).toBe(200);
      expect(getProfile).toHaveBeenCalledWith(fakeDb, { personId: M1 }, "2026-11-13", { timeoutMs: 3000 });
      expect(viewingOf()).toEqual({
        kind: "person",
        name: "Jane Tan",
        company: "Acme Capital",
        personId: M1,
        orgId: M2,
        memberId: "33333333-3333-4333-8333-333333333333",
      });
    });

    it("uses the first of person, company, member id and ignores the others", async () => {
      getProfile.mockResolvedValue({ ...PROFILE, kind: "company", personId: null, member: null, company: null, name: "Acme Capital" });
      await POST(post(valid({ viewing: { orgId: M2, memberId: M1 } })));
      expect(getProfile).toHaveBeenCalledWith(fakeDb, { orgId: M2 }, "2026-11-13", { timeoutMs: 3000 });
      expect(viewingOf()).toEqual({ kind: "company", name: "Acme Capital", company: null, personId: null, orgId: M2, memberId: null });
    });

    it("answers as usual with no viewing when the contact is not found", async () => {
      getProfile.mockResolvedValue(null);
      const res = await POST(post(valid({ viewing: { personId: M1 } })));
      expect(res.status).toBe(200);
      expect(viewingOf()).toBeUndefined();
    });

    it("answers as usual when the lookup fails", async () => {
      getProfile.mockRejectedValue(new Error("statement timeout"));
      const res = await POST(post(valid({ viewing: { personId: M1 } })));
      expect(res.status).toBe(200);
      expect(viewingOf()).toBeUndefined();
    });

    it.each([[{ personId: "not-a-uuid" }], ["x"], [{ name: "Mallory" }], [null], [[M1]], [undefined]])(
      "drops a malformed viewing (%j) without a lookup",
      async (viewing) => {
        const res = await POST(post(valid({ viewing })));
        expect(res.status).toBe(200);
        expect(getProfile).not.toHaveBeenCalled();
        expect(viewingOf()).toBeUndefined();
      },
    );
  });

  describe("about: the user's own page", () => {
    const PERSON = "00000000-0000-4000-8000-000000000002";
    const OTHER = "99999999-9999-4999-8999-999999999999";
    const PAGE = {
      person: { name: "Ann Lee", phone: "+65 1234", email: "ann@example.com" },
      work: { company: "Acme Capital", website: "https://acme.example", roleObjectives: "Raise Fund II" },
      notes: [
        { id: "n2", body: "Focus on Asia", at: "2026-11-12T09:00:00.000Z" },
        { id: "n1", body: "Short answers", at: "2026-11-10T09:00:00.000Z" },
      ],
      notesTotal: 7,
    };
    const ABOUT = {
      phone: "+65 1234",
      email: "ann@example.com",
      company: "Acme Capital",
      website: "https://acme.example",
      roleObjectives: "Raise Fund II",
      notes: [
        { body: "Focus on Asia", at: "2026-11-12T09:00:00.000Z" },
        { body: "Short answers", at: "2026-11-10T09:00:00.000Z" },
      ],
      notesTotal: 7,
    };
    const NAMES = { AL: "Ann Lee", VF: "Vincent F" };
    const depsOf = () => runAsk.mock.calls[0][0];

    it("looks the page up for the session's person and this estate, capped at 3 seconds", async () => {
      await POST(post(valid({ estate: "zeroone", personId: OTHER, customerId: OTHER, person: { id: OTHER } })));
      expect(loadAskContext).toHaveBeenCalledTimes(1);
      expect(loadAskContext).toHaveBeenCalledWith({ customerId: CUSTOMER, personId: PERSON }, "zeroone", { timeoutMs: 3000 });
    });

    it("hands runAsk the page as about, and the account names", async () => {
      loadAskContext.mockResolvedValue({ page: PAGE, ownerNames: NAMES });
      const res = await POST(post(valid()));
      expect(res.status).toBe(200);
      expect(depsOf().about).toEqual(ABOUT);
      expect(depsOf().ownerNames).toEqual(NAMES);
      // The name in the prompt's first line stays the session's.
      expect(depsOf().person).toEqual({ name: "Ann Lee", ownerKey: "AL" });
    });

    it("answers as usual, with neither, when the pipeline is unknown to the accounts database", async () => {
      loadAskContext.mockResolvedValue(null);
      const res = await POST(post(valid()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RESULT);
      expect(depsOf().about).toBeUndefined();
      expect(depsOf().ownerNames).toBeUndefined();
    });

    it("answers as usual, with neither and no log line, when the lookup fails or times out", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      loadAskContext.mockRejectedValue(new Error("Accounts lookup timed out"));
      const res = await POST(post(valid()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RESULT);
      expect(depsOf().about).toBeUndefined();
      expect(depsOf().ownerNames).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
    });

    it("answers as usual when the lookup throws before returning a promise", async () => {
      loadAskContext.mockImplementation(() => {
        throw new Error("no accounts database configured");
      });
      const res = await POST(post(valid()));
      expect(res.status).toBe(200);
      expect(depsOf().about).toBeUndefined();
    });

    it("starts the lookup before connecting to the CRM, so the two overlap", async () => {
      let finish: (value: unknown) => void = () => {};
      loadAskContext.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const pending = POST(post(valid()));
      // The CRM connection is asked for while the accounts lookup is still unanswered.
      await vi.waitFor(() => expect(withDb).toHaveBeenCalledTimes(1));
      expect(loadAskContext.mock.invocationCallOrder[0]).toBeLessThan(withDb.mock.invocationCallOrder[0]);
      expect(runAsk).not.toHaveBeenCalled();
      finish({ page: PAGE, ownerNames: NAMES });
      expect((await pending).status).toBe(200);
      expect(depsOf().about).toEqual(ABOUT);
    });

    it("runs alongside the contact lookup, not after it", async () => {
      let finish: (value: unknown) => void = () => {};
      loadAskContext.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      getProfile.mockResolvedValue(null);
      const pending = POST(post(valid({ viewing: { personId: M1 } })));
      await vi.waitFor(() => expect(getProfile).toHaveBeenCalledTimes(1));
      finish(null);
      expect((await pending).status).toBe(200);
    });

    it("does no lookup without a session or for an unknown estate", async () => {
      expect((await POST(post(valid({ estate: "nope" })))).status).toBe(400);
      expect((await POST(post(valid(), false))).status).toBe(401);
      expect(loadAskContext).not.toHaveBeenCalled();
    });
  });
});

describe("POST /api/monsoon/ask: the person's Granola key", () => {
  // Obviously fake: the shape of a key, never a real one.
  const KEY = "grn_FAKE_test_key_0000000000";
  const PERSON = "00000000-0000-4000-8000-000000000002";
  const OTHER = "99999999-9999-4999-8999-999999999999";
  const WHO = { customerId: CUSTOMER, personId: PERSON };
  const depsOf = () => runAsk.mock.calls[0][0];

  it("reads the key of the session's person, capped at 3 seconds, whoever the body names", async () => {
    await POST(post(valid({ personId: OTHER, customerId: OTHER, granola: { key: "grn_FAKE_from_the_body_000000" } })));
    expect(readGranolaKeyForAsk).toHaveBeenCalledTimes(1);
    expect(readGranolaKeyForAsk).toHaveBeenCalledWith(WHO, { timeoutMs: 3000 });
    expect(depsOf()).not.toHaveProperty("granola");
  });

  it("without a key runAsk is called exactly as before", async () => {
    readGranolaKeyForAsk.mockResolvedValue(null);
    const res = await POST(post(valid()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(Object.keys(depsOf()).sort()).toEqual(
      ["client", "customerId", "db", "defaultRole", "estate", "estateLabel", "model", "now", "person", "startedAt", "today", "viewing"].sort(),
    );
  });

  it("with a key hands it to runAsk, and never returns it", async () => {
    readGranolaKeyForAsk.mockResolvedValue(KEY);
    const res = await POST(post(valid()));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
    expect(depsOf().granola.key).toBe(KEY);
    expect(typeof depsOf().granola.onStatus).toBe("function");
  });

  it("answers as usual, with no key and no log line, when the read fails, throws at once or never answers in time", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: (() => void)[] = [
      () => readGranolaKeyForAsk.mockRejectedValue(new Error(`boom ${KEY}`)),
      () =>
        readGranolaKeyForAsk.mockImplementation(() => {
          throw new Error("no accounts database configured");
        }),
      () => readGranolaKeyForAsk.mockResolvedValue(undefined),
      () => readGranolaKeyForAsk.mockResolvedValue(42),
    ];
    for (const fail of failures) {
      runAsk.mockClear();
      readGranolaKeyForAsk.mockReset();
      fail();
      const res = await POST(post(valid()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RESULT);
      expect(depsOf()).not.toHaveProperty("granola");
    }
    expect(log).not.toHaveBeenCalled();
  });

  it("starts the read before connecting to the CRM, so the waits overlap", async () => {
    let finish: (value: unknown) => void = () => {};
    readGranolaKeyForAsk.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const pending = POST(post(valid()));
    await vi.waitFor(() => expect(withDb).toHaveBeenCalledTimes(1));
    expect(readGranolaKeyForAsk.mock.invocationCallOrder[0]).toBeLessThan(withDb.mock.invocationCallOrder[0]);
    expect(runAsk).not.toHaveBeenCalled();
    finish(KEY);
    expect((await pending).status).toBe(200);
    expect(depsOf().granola.key).toBe(KEY);
  });

  it("records a refused key for the session's person, once, without waiting for it", async () => {
    readGranolaKeyForAsk.mockResolvedValue(KEY);
    recordGranolaStatus.mockReturnValue(new Promise(() => {})); // never settles: the answer must not wait
    runAsk.mockImplementation(async (deps: { granola: { onStatus: (s: string) => void } }) => {
      deps.granola.onStatus("key_rejected");
      deps.granola.onStatus("key_rejected");
      return RESULT;
    });
    const res = await POST(post(valid()));
    expect(res.status).toBe(200);
    expect(recordGranolaStatus.mock.calls).toEqual([[WHO, "key_rejected"]]);
  });

  it("a status that cannot be recorded, or is not one, never breaks the answer", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    readGranolaKeyForAsk.mockResolvedValue(KEY);
    const statuses = ["no_access", "ok", "busy", undefined];
    for (const outcome of [() => Promise.reject(new Error("db")), () => { throw new Error("sync"); }]) {
      recordGranolaStatus.mockReset().mockImplementation(outcome);
      runAsk.mockReset().mockImplementation(async (deps: { granola: { onStatus: (s: unknown) => void } }) => {
        for (const s of statuses) deps.granola.onStatus(s);
        return RESULT;
      });
      const res = await POST(post(valid()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RESULT);
      // Only the two refusals are ever recorded from Ask.
      expect(recordGranolaStatus.mock.calls).toEqual([[WHO, "no_access"]]);
    }
    await new Promise((r) => setImmediate(r));
    expect(log).not.toHaveBeenCalled();
  });

  it("does no read without a session, for an unknown estate or without a Claude key", async () => {
    expect((await POST(post(valid({ estate: "nope" })))).status).toBe(400);
    expect((await POST(post(valid(), false))).status).toBe(401);
    signInAs(fakeAccount({ customer: { id: CUSTOMER }, pipelines: PIPELINES, db: fakeDb }));
    expect((await POST(post(valid()))).status).toBe(409);
    expect(readGranolaKeyForAsk).not.toHaveBeenCalled();
  });
});

describe("POST /api/monsoon/ask and the free trial", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("passes the AI gate once for the whole question, before Claude is asked", async () => {
    runAsk.mockImplementation(async () => {
      expect(account.beginAi).toHaveBeenCalledTimes(1);
      return RESULT;
    });
    expect((await POST(post(valid()))).status).toBe(200);
    expect(vi.mocked(account.beginAi).mock.calls).toEqual([["ask"]]);
  });

  it("does not pass the gate for a request it refuses", async () => {
    await POST(post(valid({ estate: "nope" })));
    signOut();
    await POST(post(valid()));
    expect(account.beginAi).not.toHaveBeenCalled();
  });

  it("a trial that is over answers as a missing key does today", async () => {
    const over = signInAs(fakeAccount({ customer: { id: CUSTOMER }, pipelines: PIPELINES, db: fakeDb }));
    const res = await POST(post(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_key_missing" });
    expect(over.beginAi).toHaveBeenCalledTimes(1);
    expect(runAsk).not.toHaveBeenCalled();
  });

  it("a paused trial answers 409 claude_trial_paused: Claude is never asked and the CRM is not opened", async () => {
    vi.mocked(account.beginAi).mockRejectedValue(new TrialPaused());
    const res = await POST(post(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_trial_paused" });
    expect(anthropic).not.toHaveBeenCalled();
    expect(withDb).not.toHaveBeenCalled();
    expect(runAsk).not.toHaveBeenCalled();
    expect(account.record).not.toHaveBeenCalled();
  });

  it("answers with what the account says a failed call means (a refused trial key is the pause)", async () => {
    const refusedKey = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    runAsk.mockRejectedValue(refusedKey);
    vi.mocked(account.aiError).mockReturnValue(new TrialPaused());
    const res = await POST(post(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_trial_paused" });
    expect(account.aiError).toHaveBeenCalledWith(refusedKey);
    expect(account.noteClaude).toHaveBeenCalledWith(refusedKey);
  });
});

describe("POST /api/monsoon/ask: to-do tools", () => {
  const depsOf = () => runAsk.mock.calls[0][0];

  it("hands runAsk the viewer when the CRM has the to-do table", async () => {
    todosReady.mockResolvedValue(true);
    const res = await POST(post(valid()));
    expect(res.status).toBe(200);
    expect(todosReady).toHaveBeenCalledWith(fakeDb);
    expect(depsOf().todos).toEqual({ viewer: { ownerKey: "AL", appOwnerKeys: ["AL"], solo: true } });
  });

  it("hands it nothing on an older CRM", async () => {
    await POST(post(valid()));
    expect(depsOf()).not.toHaveProperty("todos");
  });

  it("answers 502 rather than guessing when the check itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    todosReady.mockRejectedValue(new Error("connection lost"));
    const res = await POST(post(valid()));
    expect(res.status).toBe(502);
    expect(runAsk).not.toHaveBeenCalled();
  });
});

describe("POST /api/monsoon/ask: spoken answers", () => {
  const spokenBody = (over: Record<string, unknown> = {}) => valid({ spoken: true, ...over });
  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubEnv("MONSOON_VOICE_ID", "voice123");
  });

  it.each([["ELEVENLABS_API_KEY"], ["MONSOON_VOICE_ID"]])("without %s: captions only, nothing reserved and no synthesis", async (name) => {
    vi.stubEnv(name, "");
    const res = await POST(post(spokenBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(account.reserveSpeak).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
    expect(body.audio).toBeNull();
    expect(body.captions).toEqual([{ text: "Hi.", start: 0, end: expect.any(Number) }]);
  });

  it("returns audio and captions, reserves a speak slot first, and tells the loop it is spoken", async () => {
    const res = await POST(post(spokenBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...RESULT, audio: "QUJD", captions: [{ text: "Hi.", start: 0, end: 1 }] });
    expect(runAsk.mock.calls[0][0].spoken).toBe(true);
    expect(account.reserveSpeak).toHaveBeenCalledWith("traxo", SPOKEN_DAILY_LIMIT);
    expect(speak).toHaveBeenCalledWith("Hi.", { env: process.env });
    expect(account.record).toHaveBeenCalledWith("ask", "traxo");
    expect(account.record).not.toHaveBeenCalledWith("speak", expect.anything());
    expect(account.countInLastDay).not.toHaveBeenCalled();
  });

  it("reserves before it speaks", async () => {
    await POST(post(spokenBody()));
    expect(vi.mocked(account.reserveSpeak).mock.invocationCallOrder[0]).toBeLessThan(speak.mock.invocationCallOrder[0]);
  });

  it("sound: false never reserves or speaks and returns length-timed captions", async () => {
    const res = await POST(post(spokenBody({ sound: false })));
    const body = await res.json();
    expect(speak).not.toHaveBeenCalled();
    expect(account.reserveSpeak).not.toHaveBeenCalled();
    expect(body.audio).toBeNull();
    expect(body.captions).toEqual([{ text: "Hi.", start: 0, end: expect.any(Number) }]);
  });

  it("an answer over MAX_SPOKEN_CHARS gets captions only, with nothing reserved", async () => {
    expect(MAX_SPOKEN_CHARS).toBe(700);
    runAsk.mockResolvedValue({ ...RESULT, answer: "a".repeat(MAX_SPOKEN_CHARS + 1) });
    const res = await POST(post(spokenBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(speak).not.toHaveBeenCalled();
    expect(account.reserveSpeak).not.toHaveBeenCalled();
    expect(body.audio).toBeNull();
    expect(body.captions.length).toBe(1);
  });

  it("an answer of exactly MAX_SPOKEN_CHARS is still spoken", async () => {
    runAsk.mockResolvedValue({ ...RESULT, answer: "a".repeat(MAX_SPOKEN_CHARS) });
    await POST(post(spokenBody()));
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("a refused reservation (at the daily limit) never calls speak", async () => {
    vi.mocked(account.reserveSpeak).mockResolvedValue(false);
    const body = await (await POST(post(spokenBody()))).json();
    expect(speak).not.toHaveBeenCalled();
    expect(body.audio).toBeNull();
    expect(body.captions.length).toBe(1);
  });

  it("a failing reservation means captions only", async () => {
    vi.mocked(account.reserveSpeak).mockRejectedValue(new Error("db"));
    const res = await POST(post(spokenBody()));
    expect(res.status).toBe(200);
    expect(speak).not.toHaveBeenCalled();
    expect((await res.json()).audio).toBeNull();
  });

  it("audio null keeps the reservation, writes no further speak row and still answers", async () => {
    speak.mockResolvedValue({ audio: null, captions: [{ text: "Hi.", start: 0, end: 1 }] });
    const res = await POST(post(spokenBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toBe("Hi.");
    expect(body.audio).toBeNull();
    expect(account.reserveSpeak).toHaveBeenCalledTimes(1);
    expect(account.record).not.toHaveBeenCalledWith("speak", expect.anything());
  });

  it("a non-spoken request has no audio or captions key", async () => {
    const body = await (await POST(post(valid()))).json();
    expect(body).toEqual(RESULT);
    expect(speak).not.toHaveBeenCalled();
    expect(runAsk.mock.calls[0][0]).not.toHaveProperty("spoken");
  });

  it("treats spoken: \"yes\" as absent", async () => {
    const body = await (await POST(post(valid({ spoken: "yes" })))).json();
    expect(body).toEqual(RESULT);
    expect(speak).not.toHaveBeenCalled();
  });
});
