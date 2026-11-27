import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import type { Account } from "@/lib/monsoon/accounts/account";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { POST } from "./route";

const PIPELINES = [{ key: "traxo", label: "Traxo", defaultRole: "lp_prospect", connected: true }];
let account: Account;

function post(body: unknown, authenticated = true): Request {
  if (!authenticated) signOut();
  return new Request("http://localhost/api/monsoon/ask/feedback", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
const valid = (over: Record<string, unknown> = {}) => ({ estate: "traxo", kind: "up", mode: "voice", ...over });

beforeEach(() => {
  account = fakeAccount({ customer: { id: "c0000000-0000-4000-8000-00000000000a" }, pipelines: PIPELINES });
  signInAs(account);
});

describe("POST /api/monsoon/ask/feedback", () => {
  it("answers 401 when signed out", async () => {
    expect((await POST(post(valid(), false))).status).toBe(401);
    expect(account.feedback).not.toHaveBeenCalled();
  });

  it.each([
    ["estate", { estate: "nowhere" }],
    ["kind", { kind: "sideways" }],
    ["mode", { mode: "shouted" }],
    ["body", "[1]"],
  ])("answers 400 for an unknown %s", async (_n, over) => {
    const res = await POST(post(typeof over === "string" ? over : valid(over)));
    expect(res.status).toBe(400);
    expect(account.feedback).not.toHaveBeenCalled();
  });

  it("answers 413 for a body over 2,048 bytes", async () => {
    expect((await POST(post(valid({ detail: "x".repeat(3000) })))).status).toBe(413);
  });

  it("stores no detail for a rating", async () => {
    const res = await POST(post(valid({ kind: "up", detail: "lovely" })));
    expect(res.status).toBe(204);
    expect(account.feedback).toHaveBeenCalledWith({ pipelineKey: "traxo", kind: "up", mode: "voice", detail: null });
  });

  it("cuts a long detail on a voice failure to 200 characters", async () => {
    const res = await POST(post(valid({ kind: "no_speech", detail: "a".repeat(500) })));
    expect(res.status).toBe(204);
    expect(account.feedback).toHaveBeenCalledWith({ pipelineKey: "traxo", kind: "no_speech", mode: "voice", detail: "a".repeat(200) });
  });

  it("strips control characters from a detail before storing it", async () => {
    const res = await POST(post(valid({ kind: "no_speech", detail: "heard\u001b[31m nothing\nat all\u0085" })));
    expect(res.status).toBe(204);
    expect(account.feedback).toHaveBeenCalledWith({ pipelineKey: "traxo", kind: "no_speech", mode: "voice", detail: "heard[31m nothingat all" });
  });

  it("strips control characters before the 200-character cut", async () => {
    await POST(post(valid({ kind: "no_speech", detail: "\u001b".repeat(50) + "a".repeat(300) })));
    expect(account.feedback).toHaveBeenCalledWith(expect.objectContaining({ detail: "a".repeat(200) }));
  });

  it("stores null for a missing or non-text detail on a failure kind", async () => {
    await POST(post(valid({ kind: "mic_blocked" })));
    await POST(post(valid({ kind: "unsupported", detail: 5 })));
    expect(account.feedback).toHaveBeenNthCalledWith(1, expect.objectContaining({ detail: null }));
    expect(account.feedback).toHaveBeenNthCalledWith(2, expect.objectContaining({ detail: null }));
  });

  it("uses the session's identity, not ids from the body, and still answers 204 when the daily limit dropped the row", async () => {
    vi.mocked(account.feedback).mockResolvedValueOnce(false);
    const res = await POST(post(valid({ customerId: "x", personId: "y" })));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(account.feedback).toHaveBeenCalledWith({ pipelineKey: "traxo", kind: "up", mode: "voice", detail: null });
  });
});
