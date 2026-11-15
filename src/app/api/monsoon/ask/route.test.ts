import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signLegacySession } from "@/lib/monsoon/auth";

const withEstateDb = vi.fn();
const runAsk = vi.fn();
const ctorOptions: unknown[] = [];
vi.mock("@/lib/monsoon/db", () => ({ withEstateDb: (...a: unknown[]) => withEstateDb(...a) }));
vi.mock("@/lib/monsoon/ask/loop", () => ({ runAsk: (...a: unknown[]) => runAsk(...a) }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(options?: unknown) {
      ctorOptions.push(options);
    }
    messages = { create: vi.fn() };
  },
}));

import { POST } from "./route";

const fakeDb = { fake: true };
const RESULT = { answer: "Hi.", refs: [], proposals: [] };

function post(body: unknown, authenticated = true): Request {
  return new Request("http://localhost/api/monsoon/ask", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Cookie: `monsoon_session=${signLegacySession()}` } : {}),
    },
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
  withEstateDb.mockReset().mockImplementation(async (_e, fn) => fn(fakeDb));
  runAsk.mockReset().mockResolvedValue(RESULT);
  ctorOptions.length = 0;
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
    expect(withEstateDb).not.toHaveBeenCalled();
  });

  const cases: [string, unknown][] = [
    ["malformed JSON", "{nope"],
    ["a non-object body", []],
    ["an unknown estate", valid({ estate: "acme" })],
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
    expect(deps).toMatchObject({ db: fakeDb, estate: "traxo", estateLabel: "Traxo", today: "2026-11-13" });
    expect(typeof deps.now()).toBe("number");
    expect(deps.startedAt).toBe(new Date("2026-11-13T10:00:00Z").getTime());
    expect(messages).toEqual([
      user("who?"),
      { role: "assistant", content: "Jane.", refs: [good, co, ...Array.from({ length: 28 }, () => good)] },
      { role: "assistant", content: "No refs", refs: [] },
      user("move her"),
    ]);
    expect(ctorOptions).toEqual([{ timeout: 20_000, maxRetries: 0 }]);
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

  it("answers 502 and logs only the error name and status when the loop throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = Object.assign(new Error("secret question text postgres://u:pw@h"), { name: "APIError", status: 529 });
    runAsk.mockRejectedValue(err);
    const res = await POST(post(valid()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not get an answer" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["monsoon: ask failed", "APIError", 529]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  });

  it("answers 502 when the database cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    withEstateDb.mockRejectedValue(new Error("TRAXO_CRM_DATABASE_URL is not set"));
    expect((await POST(post(valid()))).status).toBe(502);
  });
});
