import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/monsoon/auth";

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
      ...(authenticated ? { Cookie: `monsoon_session=${signSession()}` } : {}),
    },
  });
}
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
    const good = { memberId: "m1", name: "Jane", company: "Acme", kind: "person" };
    const co = { memberId: "m2", name: "Northwind", company: null, kind: "company" };
    const res = await POST(
      post(
        valid({
          messages: [
            user("who?"),
            {
              role: "assistant",
              content: "Jane.",
              refs: [good, { memberId: 1, name: "x" }, "junk", { ...good, kind: "robot" }, co],
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
    expect(messages).toEqual([
      user("who?"),
      { role: "assistant", content: "Jane.", refs: [good, co] },
      { role: "assistant", content: "No refs", refs: [] },
      user("move her"),
    ]);
    expect(ctorOptions).toEqual([{ timeout: 20_000, maxRetries: 0 }]);
  });

  it("answers 502 and logs only the error name and status when the loop throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = Object.assign(new Error("secret question text postgres://u:pw@h"), { name: "APIError", status: 529 });
    runAsk.mockRejectedValue(err);
    const res = await POST(post(valid()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not get an answer" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["monsoon: ask failed for traxo", "APIError", 529]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  });

  it("answers 502 when the database cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    withEstateDb.mockRejectedValue(new Error("TRAXO_CRM_DATABASE_URL is not set"));
    expect((await POST(post(valid()))).status).toBe(502);
  });
});
