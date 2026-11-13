import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/monsoon/auth";

const refineContact = vi.fn();
vi.mock("@/lib/monsoon/refine", async (orig) => ({
  ...(await orig<typeof import("@/lib/monsoon/refine")>()),
  refineContact: (...args: unknown[]) => refineContact(...args),
}));

import { POST } from "./route";

const FIELDS = {
  name: "Jane Tan",
  title: "Partner",
  org: "Acme",
  email: "",
  phone: "",
  linkedin: "",
};
const OUT = { fields: { ...FIELDS, title: "CIO" }, notes: "Now CIO." };

function req(body: unknown, authenticated = true, raw?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authenticated) headers.Cookie = `monsoon_session=${signSession()}`;
  return new Request("http://localhost/api/monsoon/refine", {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
  });
}
const valid = (over: Record<string, unknown> = {}) => ({
  fields: FIELDS,
  notes: "met at demo",
  spoken: "she is CIO now",
  ...over,
});

beforeEach(() => {
  refineContact.mockReset();
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/refine", () => {
  it("answers 401 without a session and does not call the model", async () => {
    const res = await POST(req(valid(), false));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("400 on malformed JSON", async () => {
    const res = await POST(req(null, true, "{nope"));
    expect(res.status).toBe(400);
    expect(refineContact).not.toHaveBeenCalled();
  });

  it.each([
    ["missing fields", { notes: "", spoken: "x" }],
    ["a missing field key", valid({ fields: { name: "a" } })],
    ["a non-string field", valid({ fields: { ...FIELDS, org: 5 } })],
    ["non-string notes", valid({ notes: 1 })],
    ["non-string spoken", valid({ spoken: 1 })],
  ])("400 on %s", async (_n, body) => {
    expect((await POST(req(body))).status).toBe(400);
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("400 Nothing to tidy for blank spoken", async () => {
    const res = await POST(req(valid({ spoken: "  \n " })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Nothing to tidy" });
  });

  it("400 for spoken over 4000 characters, accepts exactly 4000", async () => {
    expect((await POST(req(valid({ spoken: "a".repeat(4001) })))).status).toBe(400);
    refineContact.mockResolvedValue(OUT);
    expect((await POST(req(valid({ spoken: "a".repeat(4000) })))).status).toBe(200);
  });

  it("400 Field too long for a 301-character org or 2001-character notes", async () => {
    const res = await POST(req(valid({ fields: { ...FIELDS, org: "o".repeat(301) } })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Field too long" });
    expect((await POST(req(valid({ notes: "n".repeat(2001) })))).status).toBe(400);
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("200 with the refined record, calling refineContact with exactly fields, notes, spoken", async () => {
    refineContact.mockResolvedValue(OUT);
    const res = await POST(req(valid({ extra: "ignored" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUT);
    expect(refineContact).toHaveBeenCalledWith({
      fields: FIELDS,
      notes: "met at demo",
      spoken: "she is CIO now",
    });
  });

  it("502 with a generic body, and the thrown message never reaches the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    refineContact.mockRejectedValue(new Error("secret dictated text Jane"));
    const res = await POST(req(valid()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not tidy the notes" });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("secret dictated text");
    expect(logged).not.toContain("Jane");
    expect(logged).not.toContain("she is CIO now");
  });

  it("413 to an over-cap body after a valid session, 401 first without one", async () => {
    const big = JSON.stringify(valid({ pad: "x".repeat(32_768) }));
    const res = await POST(req(null, true, big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request too large" });
    expect((await POST(req(null, false, big))).status).toBe(401);
    expect(refineContact).not.toHaveBeenCalled();
  });
});
