import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = { listSignups: vi.fn(), declineSignup: vi.fn(), reopenSignup: vi.fn() };
vi.mock("@/lib/monsoon/accounts/signups", () => ({
  listSignups: (...a: unknown[]) => lib.listSignups(...a),
  declineSignup: (...a: unknown[]) => lib.declineSignup(...a),
  reopenSignup: (...a: unknown[]) => lib.reopenSignup(...a),
}));
const approveSignup = vi.fn();
vi.mock("@/lib/monsoon/accounts/approve", () => ({ approveSignup: (...a: unknown[]) => approveSignup(...a) }));
const signupsConfigured = vi.fn();
vi.mock("@/lib/monsoon/google", () => ({ signupsConfigured: () => signupsConfigured() }));
const trialKeyHealth = vi.fn();
vi.mock("@/lib/monsoon/accounts/trial", () => ({ trialKeyHealth: () => trialKeyHealth() }));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import * as route from "./route";

const { GET, POST, maxDuration } = route;
const ID = "5f0c2a47-6a3e-4c1f-9d55-2f7a3c1e8b10";
const CUSTOMER = "0b9d2a47-6a3e-4c1f-9d55-2f7a3c1e8b10";
const SUB = "109876543210987654321";
const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  sub: SUB,
  email: "gil@example.com",
  name: "Gil Hale",
  status: "pending",
  customerId: null,
  createdAt: "2026-11-25T10:00:00.000Z",
  ...over,
});

const URL_ = "http://localhost/api/monsoon/requests";
const get = () => new Request(URL_);
const post = (body: unknown) =>
  new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

const vincent = () => fakeAccount({ customer: { code: "quantcloud" }, canChangeKey: true });
const calledNothing = () => {
  for (const f of [lib.listSignups, lib.declineSignup, lib.reopenSignup, approveSignup]) expect(f).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of [...Object.values(lib), approveSignup, signupsConfigured, trialKeyHealth]) f.mockReset();
  trialKeyHealth.mockResolvedValue("ok");
  lib.listSignups.mockResolvedValue([row(), row({ id: "id-2", status: "approved", customerId: CUSTOMER })]);
  lib.declineSignup.mockResolvedValue(true);
  lib.reopenSignup.mockResolvedValue(true);
  approveSignup.mockResolvedValue({ ok: true, customerId: CUSTOMER, already: false });
  signupsConfigured.mockReturnValue(true);
  signInAs(vincent());
});

describe("who may use /api/monsoon/requests", () => {
  const everyMethod = () => [
    ["GET", () => GET(get())],
    ["POST approve", () => POST(post({ id: ID, action: "approve" }))],
    ["POST decline", () => POST(post({ id: ID, action: "decline" }))],
    ["POST reopen", () => POST(post({ id: ID, action: "reopen" }))],
    ["POST nonsense", () => POST(post("not json"))],
    ["PUT", () => route.PUT(new Request(URL_, { method: "PUT" }))],
    ["PATCH", () => route.PATCH(new Request(URL_, { method: "PATCH" }))],
    ["DELETE", () => route.DELETE(new Request(URL_, { method: "DELETE" }))],
  ] as const;

  it("answers 401 to anyone signed out, for every method", async () => {
    signOut();
    for (const [name, call] of everyMethod()) expect((await call()).status, name).toBe(401);
    calledNothing();
  });

  it("answers 404 to every signed-in person who is not the key person of quantcloud, for every method", async () => {
    const others = [
      fakeAccount({ canChangeKey: true }), // the key person of another customer
      fakeAccount({ customer: { code: "quantcloud" }, canChangeKey: false }), // a colleague at quantcloud
      fakeAccount({ customer: { code: "quantcloud-x7k2" }, canChangeKey: true }), // a sign-up client named after it
      fakeAccount({ customer: { code: "QUANTCLOUD" }, canChangeKey: true }),
      fakeAccount({ customer: { name: "quantcloud", code: "acme-co" }, canChangeKey: true }),
    ];
    for (const account of others) {
      signInAs(account);
      for (const [name, call] of everyMethod()) {
        const res = await call();
        expect(res.status, `${account.customer.code} ${name}`).toBe(404);
        expect(await res.json()).toEqual({ error: "Not found" });
      }
    }
    calledNothing();
  });

  it("has no other methods for the key person of quantcloud either", async () => {
    for (const m of ["PUT", "PATCH", "DELETE"] as const) expect((await route[m](new Request(URL_, { method: m }))).status).toBe(404);
  });

  it("gives approving a minute", () => {
    expect(maxDuration).toBe(60);
  });
});

describe("GET /api/monsoon/requests", () => {
  it("lists the requests without the Google id, uncached, and says whether approving is set up", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      requests: [
        { id: ID, email: "gil@example.com", name: "Gil Hale", status: "pending", customerId: null, createdAt: "2026-11-25T10:00:00.000Z" },
        { id: "id-2", email: "gil@example.com", name: "Gil Hale", status: "approved", customerId: CUSTOMER, createdAt: "2026-11-25T10:00:00.000Z" },
      ],
      configured: true,
      trialKey: "ok",
    });
    expect(JSON.stringify(body)).not.toContain(SUB);
  });

  it("says how the free trial key is doing: unset, ok, refused or out of credit, and never the key", async () => {
    vi.stubEnv("MONSOON_TRIAL_CLAUDE_KEY", "sk-ant-api03-TRIALKEY-0123456789-tttt");
    try {
      for (const health of ["unset", "ok", "key_rejected", "no_credit"]) {
        trialKeyHealth.mockResolvedValue(health);
        const res = await GET(get());
        const text = await res.text();
        expect(JSON.parse(text).trialKey).toBe(health);
        expect(text).not.toContain("TRIALKEY");
        expect(text).not.toContain("tttt");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not look at the trial key for anyone but the approver", async () => {
    signInAs(fakeAccount({ customer: { code: "acme-co" }, canChangeKey: true }));
    expect((await GET(get())).status).toBe(404);
    expect(trialKeyHealth).not.toHaveBeenCalled();
  });

  it("says configured false without the shared database setting, and still lists", async () => {
    signupsConfigured.mockReturnValue(false);
    const body = await (await GET(get())).json();
    expect(body.configured).toBe(false);
    expect(body.requests).toHaveLength(2);
  });

  it("answers 502 without detail when the lookup fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    lib.listSignups.mockRejectedValue(new Error("connect ECONNREFUSED postgresql://u:secret-pw@db.internal:5432/x"));
    const res = await GET(get());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not reach the accounts database" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-pw");
  });
});

describe("POST /api/monsoon/requests", () => {
  it("approve: approves that request as the signed-in person and answers ok with nothing else", async () => {
    const account = signInAs(vincent());
    const res = await POST(post({ id: ID, action: "approve" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    expect(approveSignup).toHaveBeenCalledTimes(1);
    expect(approveSignup).toHaveBeenCalledWith(ID, { approver: { customerId: account.customer.id, personId: account.person.id } });
  });

  it("approve: 503 without the shared database setting, and nothing is tried", async () => {
    signupsConfigured.mockReturnValue(false);
    const res = await POST(post({ id: ID, action: "approve" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Sign-ups are not set up" });
    expect(approveSignup).not.toHaveBeenCalled();
    // Declining and re-opening need no shared database.
    expect((await POST(post({ id: ID, action: "decline" }))).status).toBe(200);
    expect((await POST(post({ id: ID, action: "reopen" }))).status).toBe(200);
  });

  it("approve: says what happened without detail when it does not go through", async () => {
    const cases = [
      [{ ok: false, reason: "failed" }, 502, "Could not finish. Try again."],
      [{ ok: false, reason: "busy" }, 409, "This request is being approved right now."],
      [{ ok: false, reason: "declined" }, 409, "This request was declined. Re-open it first."],
      [{ ok: false, reason: "not_found" }, 404, "No such request"],
    ] as const;
    for (const [result, status, error] of cases) {
      approveSignup.mockResolvedValue(result);
      const res = await POST(post({ id: ID, action: "approve" }));
      expect(res.status, result.reason).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });

  it("approve: a thrown error is a 502 that carries and logs no detail", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    approveSignup.mockRejectedValue(new Error(`role monsoon_c_x at postgresql://postgres.ref:secret-pw@host/db for ${SUB}`));
    const res = await POST(post({ id: ID, action: "approve" }));
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json()) + JSON.stringify(spy.mock.calls);
    for (const secret of ["secret-pw", "postgresql://", SUB, "monsoon_c_x"]) expect(text).not.toContain(secret);
  });

  it("the answer to an approval never carries the customer id, the Google id or an address", async () => {
    const res = await POST(post({ id: ID, action: "approve" }));
    const text = await res.text();
    for (const secret of [CUSTOMER, SUB, "postgres", "sub"]) expect(text).not.toContain(secret);
  });

  it("decline and reopen change the status, and say so when the request is not in that state", async () => {
    expect(await (await POST(post({ id: ID, action: "decline" }))).json()).toEqual({ ok: true });
    expect(lib.declineSignup).toHaveBeenCalledWith(ID);
    expect(await (await POST(post({ id: ID, action: "reopen" }))).json()).toEqual({ ok: true });
    expect(lib.reopenSignup).toHaveBeenCalledWith(ID);
    expect(approveSignup).not.toHaveBeenCalled();

    lib.declineSignup.mockResolvedValue(false);
    lib.reopenSignup.mockResolvedValue(false);
    for (const action of ["decline", "reopen"]) {
      const res = await POST(post({ id: ID, action }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "That request has already changed. Refresh and try again." });
    }
  });

  it("refuses a body that is not exactly an id and a known action", async () => {
    const bad = [
      "not json",
      {},
      [],
      null,
      { id: ID },
      { action: "approve" },
      { id: ID, action: "delete" },
      { id: ID, action: "APPROVE" },
      { id: "1; DROP TABLE signups", action: "approve" },
      { id: 7, action: "approve" },
      { id: [ID], action: "approve" },
      { id: ID, action: ["approve"] },
    ];
    for (const body of bad) {
      const res = await POST(post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
    }
    for (const f of [lib.declineSignup, lib.reopenSignup, approveSignup]) expect(f).not.toHaveBeenCalled();
  });

  it("refuses an over-long body", async () => {
    const res = await POST(post({ id: ID, action: "approve", pad: "x".repeat(5000) }));
    expect([400, 413]).toContain(res.status);
    expect(approveSignup).not.toHaveBeenCalled();
  });

  it("a database failure while declining is a 502 without detail", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    lib.declineSignup.mockRejectedValue(new Error("postgresql://u:secret-pw@h/db"));
    const res = await POST(post({ id: ID, action: "decline" }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json()) + JSON.stringify(spy.mock.calls)).not.toContain("secret-pw");
  });
});
