import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SIGNUPS_OPEN is a const false in production; the getter lets a test open it.
const gate = vi.hoisted(() => ({ open: false }));
vi.mock("@/lib/monsoon/accounts/account", () => ({ withCustomerPipelineDb: vi.fn() }));
vi.mock("@/lib/monsoon/alpha", () => ({
  recordAlphaSignup: vi.fn(),
  get SIGNUPS_OPEN() {
    return gate.open;
  },
}));

import { withCustomerPipelineDb } from "@/lib/monsoon/accounts/account";
import { recordAlphaSignup } from "@/lib/monsoon/alpha";
import { POST } from "./route";

const withDb = vi.mocked(withCustomerPipelineDb);
const record = vi.mocked(recordAlphaSignup);

function post(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/monsoon/alpha", {
    method: "POST",
    body: text,
    headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length), ...headers },
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  withDb.mockReset();
  record.mockReset();
  withDb.mockImplementation(async (_code, _key, fn) => fn({} as never));
  gate.open = false;
  record.mockResolvedValue({ status: "added" });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("POST /api/monsoon/alpha (paused)", () => {
  it("answers 503 and never touches the CRM", async () => {
    const res = await POST(post({ email: "jane@example.com" }, { Origin: "https://quantcloud.com" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Sign-ups open soon." });
    expect(withDb).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("POST /api/monsoon/alpha (when open again)", () => {
  beforeEach(() => {
    gate.open = true;
  });

  it("saves a valid email to the Zero One CRM and answers ok", async () => {
    const res = await POST(post({ email: "  Jane@Example.com " }, { Origin: "https://quantcloud.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(withDb).toHaveBeenCalledTimes(1);
    expect(withDb.mock.calls[0].slice(0, 2)).toEqual(["quantcloud", "zeroone"]);
    expect(record).toHaveBeenCalledWith(expect.anything(), "jane@example.com", "VF");
  });

  it("answers the same for someone already on file, so it never reveals who has signed up", async () => {
    record.mockResolvedValue({ status: "repeat" });
    const res = await POST(post({ email: "jane@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts quantcloud.com, monsooncrm.com (with or without www) and localhost origins", async () => {
    expect((await POST(post({ email: "a@b.co" }, { Origin: "https://www.quantcloud.com" }))).status).toBe(200);
    expect((await POST(post({ email: "a@b.co" }, { Origin: "https://monsooncrm.com" }))).status).toBe(200);
    expect((await POST(post({ email: "a@b.co" }, { Origin: "https://www.monsooncrm.com" }))).status).toBe(200);
    expect((await POST(post({ email: "a@b.co" }, { Origin: "http://localhost:3000" }))).status).toBe(200);
  });

  it("refuses another site's origin without touching the database", async () => {
    const res = await POST(post({ email: "a@b.co" }, { Origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    for (const origin of ["http://monsooncrm.com", "https://monsooncrm.com.evil.example", "https://evilmonsooncrm.com"]) {
      expect((await POST(post({ email: "a@b.co" }, { Origin: origin }))).status, origin).toBe(403);
    }
    expect(withDb).not.toHaveBeenCalled();
  });

  it("a filled honeypot answers ok and writes nothing", async () => {
    const res = await POST(post({ email: "bot@spam.example", website: "http://spam" }));
    expect(res.status).toBe(200);
    expect(withDb).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ email: "" }], [{ email: "not-an-email" }], [{ email: "a@b" }], [{ email: `${"x".repeat(250)}@b.co` }], [{ email: 5 }], [[]], ["null"]])(
    "rejects %j with a plain message and no write",
    async (body) => {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Enter a valid email address." });
      expect(withDb).not.toHaveBeenCalled();
    },
  );

  it("refuses an oversized body", async () => {
    const res = await POST(post({ email: "a@b.co", pad: "x".repeat(3000) }));
    expect(res.status).toBe(413);
    expect(withDb).not.toHaveBeenCalled();
  });

  it("a database failure answers 502 and logs no email or message", async () => {
    withDb.mockRejectedValue(Object.assign(new Error("connect failed for jane@example.com"), { code: "08006" }));
    const res = await POST(post({ email: "jane@example.com" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not save your email. Try again in a moment." });
    expect(errorSpy).toHaveBeenCalledWith("monsoon: alpha sign-up failed", "Error", "08006");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("jane@example.com");
  });
});
