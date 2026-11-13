import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST } from "./route";

const PASSCODE = "correct-horse-battery-staple";

function post(body: unknown): Request {
  return new Request("http://localhost/api/monsoon/session", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("MONSOON_PASSCODE", PASSCODE);
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST", () => {
  it("sets a hardened session cookie for the right passcode", async () => {
    const res = await POST(post({ passcode: PASSCODE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("monsoon_session=");
    for (const part of [
      "HttpOnly",
      "Secure",
      "SameSite=strict",
      "Max-Age=15552000",
      "Path=/",
    ]) {
      expect(cookie.toLowerCase()).toContain(part.toLowerCase());
    }
  });

  it("waits 1000 ms before rejecting a wrong passcode", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = POST(post({ passcode: "nope" })).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Wrong passcode" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("delays a non-string passcode too", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = POST(post({ passcode: 5 })).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(401);
  });

  it("returns 500 immediately when not configured", async () => {
    vi.stubEnv("MONSOON_PASSCODE", "a".repeat(15));
    vi.useFakeTimers();
    const res = await POST(post({ passcode: "a".repeat(15) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Monsoon is not configured" });
  });

  it("returns 400 for bad JSON", async () => {
    const res = await POST(post("{"));
    expect(res.status).toBe(400);
  });

  it("returns 413 for an over-cap body, streamed or declared, before any passcode check", async () => {
    vi.useFakeTimers();
    const big = JSON.stringify({ passcode: "x".repeat(4096) });
    const res = await POST(post(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request too large" });
    const declared = new Request("http://localhost/api/monsoon/session", {
      method: "POST",
      body: "{}",
      headers: { "Content-Length": "999999" },
    });
    expect((await POST(declared)).status).toBe(413);
  });
});

describe("DELETE", () => {
  it("clears the cookie", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("monsoon_session=");
    expect(cookie).toContain("Max-Age=0");
  });
});
