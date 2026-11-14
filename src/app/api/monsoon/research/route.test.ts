import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyProposal } from "@/lib/monsoon/ask/proposal";
import { signSession } from "@/lib/monsoon/auth";

const withEstateDb = vi.fn();
const readSubject = vi.fn();
const runResearch = vi.fn();
vi.mock("@/lib/monsoon/db", () => ({ withEstateDb: (...a: unknown[]) => withEstateDb(...a) }));
vi.mock("@/lib/monsoon/research-subject", () => ({ readSubject: (...a: unknown[]) => readSubject(...a) }));
vi.mock("@/lib/monsoon/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/monsoon/research")>()),
  runResearch: (...a: unknown[]) => runResearch(...a),
}));

import { POST } from "./route";

const MEMBER = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const LOGM = "44444444-4444-4444-8444-444444444444";
const fakeClient = { fake: true };

const subject = {
  name: "Jane Tan",
  company: "Northwind Capital",
  companyWebsite: null,
  title: "Analyst",
  email: null,
  phone: null,
  linkedin: null,
  country: null,
};
const read = (over: Record<string, unknown> = {}) => ({
  ok: true,
  subject,
  person: { id: PERSON, name: "Jane Tan" },
  company: { id: ORG, name: "Northwind Capital" },
  logMemberId: LOGM,
  ...over,
});
const finding = (n: number) => ({
  target: "person",
  field: n === 1 ? "title" : "country",
  from: null,
  to: `Value ${n}`,
  source: `https://news.example/p${n}`,
});
const vetted = (over: Record<string, unknown> = {}) => ({
  vetted: {
    outcome: "findings",
    identity: "Matches name and company.",
    findings: [finding(1), finding(2)],
    summary: "Jane Tan is an analyst.",
    summarySources: ["https://news.example/p1"],
    ...over,
  },
});

function post(body: unknown, authenticated = true): Request {
  return new Request("http://localhost/api/monsoon/research", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Cookie: `monsoon_session=${signSession()}` } : {}),
    },
  });
}

const calls = (f: unknown) => JSON.stringify((f as { mock: { calls: unknown[] } }).mock.calls);

let dbDone = false;
beforeEach(() => {
  for (const f of [withEstateDb, readSubject, runResearch]) f.mockReset();
  dbDone = false;
  withEstateDb.mockImplementation(async (_e, fn) => {
    const out = await fn(fakeClient);
    dbDone = true;
    return out;
  });
  readSubject.mockResolvedValue(read());
  runResearch.mockResolvedValue(vetted());
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function none(res: Response, message: string) {
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "none", message });
}

describe("POST /api/monsoon/research", () => {
  it("answers 401 before reading the body and calls nothing", async () => {
    expect((await POST(post({ estate: "traxo", memberId: MEMBER }, false))).status).toBe(401);
    expect((await POST(post("{", false))).status).toBe(401);
    expect(withEstateDb).not.toHaveBeenCalled();
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("answers 413 over the cap and 400 for bad JSON, estate and ids", async () => {
    expect((await POST(post("x".repeat(3000)))).status).toBe(413);
    expect((await POST(post("{"))).status).toBe(400);
    const bodies: unknown[] = [
      null,
      [],
      { estate: "nope", memberId: MEMBER },
      { estate: "traxo" },
      { estate: "traxo", memberId: 5 },
      { estate: "traxo", memberId: "nope" },
    ];
    for (const b of bodies) expect((await POST(post(b))).status).toBe(400);
    expect(withEstateDb).not.toHaveBeenCalled();
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown contact and 502 when the read fails", async () => {
    readSubject.mockResolvedValue({ ok: false, reason: "missing" });
    const r = await POST(post({ estate: "traxo", memberId: MEMBER }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "No such contact." });
    readSubject.mockRejectedValue(Object.assign(new Error("secret host"), { code: "ECONNREFUSED" }));
    const r2 = await POST(post({ estate: "traxo", memberId: MEMBER }));
    expect(r2.status).toBe(502);
    expect(await r2.json()).toEqual({ error: "Could not reach the Traxo CRM" });
    expect(calls(console.error)).not.toContain("secret host");
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("explains that research works on a person for a company member", async () => {
    readSubject.mockResolvedValue({ ok: false, reason: "company" });
    await none(await POST(post({ estate: "traxo", memberId: MEMBER })), "Research works on a person. Open a person's profile.");
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("does not call the model when there is no anchor", async () => {
    readSubject.mockResolvedValue(read({ subject: { ...subject, company: null }, company: null }));
    await none(await POST(post({ estate: "traxo", personId: PERSON })), "Add a company or email first so I research the right person.");
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("returns a signed proposal with ids f1.. and the summary outside the signature", async () => {
    const res = await POST(post({ estate: "zeroone", memberId: MEMBER }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("findings");
    expect(body.summary).toBe("Jane Tan is an analyst.");
    expect(Object.keys(body.signed).sort()).toEqual(["proposal", "signature"]);
    const p = body.signed.proposal;
    expect(verifyProposal(p, body.signed.signature, Date.now())).toBe(true);
    expect(p.kind).toBe("apply_research");
    expect(p.estate).toBe("zeroone");
    expect(p.findings.map((f: { id: string }) => f.id)).toEqual(["f1", "f2"]);
    expect(p.person).toEqual({ id: PERSON, name: "Jane Tan" });
    expect(p.company).toEqual({ id: ORG, name: "Northwind Capital" });
    expect(p.summarySources).toEqual(["https://news.example/p1"]);
    expect(p.logMemberId).toBe(LOGM);
    expect(p.expires).toBeGreaterThan(Date.now());
  });

  it("sets addsToPipeline only when there is no log member, from the estate default", async () => {
    const a = await (await POST(post({ estate: "zeroone", memberId: MEMBER }))).json();
    expect(a.signed.proposal.addsToPipeline).toBeNull();
    readSubject.mockResolvedValue(read({ logMemberId: null }));
    const b = await (await POST(post({ estate: "traxo", personId: PERSON }))).json();
    expect(b.signed.proposal.logMemberId).toBeNull();
    expect(b.signed.proposal.addsToPipeline).toBe("lp_prospect");
    expect(verifyProposal(b.signed.proposal, b.signed.signature, Date.now())).toBe(true);
  });

  it("never returns more than eight findings", async () => {
    const fs = ["title", "linkedin", "country", "email", "phone"].map((field, i) => ({
      target: "person", field, from: null, to: `v${i}`, source: "https://news.example/a",
    }));
    const web = { target: "company", field: "website", from: null, to: "https://nw.example", source: "https://nw.example/a" };
    // Six distinct findings fit; nine cannot all be distinct, so the extra are cut and what is left must verify or be refused.
    runResearch.mockResolvedValue(vetted({ findings: [...fs, web] }));
    const ok = await (await POST(post({ estate: "traxo", memberId: MEMBER }))).json();
    expect(ok.status).toBe("findings");
    expect(ok.signed.proposal.findings).toHaveLength(6);
    runResearch.mockResolvedValue(vetted({ findings: [...fs, web, ...fs] }));
    const body = await (await POST(post({ estate: "traxo", memberId: MEMBER }))).json();
    if (body.status === "findings") expect(body.signed.proposal.findings.length).toBeLessThanOrEqual(8);
    else expect(body.message).toBe("Nothing I'd trust. No changes suggested.");
  });

  it("answers nothing when the built proposal would not verify", async () => {
    runResearch.mockResolvedValue(vetted({ identity: "" }));
    await none(await POST(post({ estate: "traxo", memberId: MEMBER })), "Nothing I'd trust. No changes suggested.");
  });

  it("maps research outcomes to the exact messages", async () => {
    const cases: [unknown, string][] = [
      [{ vetted: { outcome: "not_identified" } }, "I found several people with this name and can't tell which is yours."],
      [{ vetted: { outcome: "nothing" } }, "Nothing I'd trust. No changes suggested."],
      [{ failed: "refused" }, "Nothing I'd trust. No changes suggested."],
      [{ failed: "malformed" }, "Nothing I'd trust. No changes suggested."],
      [{ failed: "timeout" }, "Research took too long. Try again."],
    ];
    for (const [result, message] of cases) {
      runResearch.mockResolvedValue(result);
      await none(await POST(post({ estate: "traxo", memberId: MEMBER })), message);
    }
  });

  it("answers 502 when the model call throws, logging only the class and status", async () => {
    class RateLimitError extends Error {
      status = 429;
    }
    runResearch.mockRejectedValue(new RateLimitError("secret query about Jane Tan"));
    const res = await POST(post({ estate: "traxo", memberId: MEMBER }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not run research. Check signal and try again." });
    const logged = calls(console.error);
    expect(logged).toContain("monsoon: research failed");
    expect(logged).toContain("RateLimitError");
    expect(logged).toContain("429");
    expect(logged).not.toContain("secret query");
  });

  it("answers 502 when the model id is not allowed", async () => {
    runResearch.mockRejectedValue(new Error("MONSOON_RESEARCH_MODEL must not be an Opus or Fable model"));
    expect((await POST(post({ estate: "traxo", memberId: MEMBER }))).status).toBe(502);
  });

  it("finishes the database callback before the model call starts, with a 45 s timeout", async () => {
    runResearch.mockImplementation(async (_c, _s, opts) => {
      expect(dbDone).toBe(true);
      expect(opts).toEqual({ timeoutMs: 45_000 });
      return vetted();
    });
    expect((await POST(post({ estate: "traxo", memberId: MEMBER }))).status).toBe(200);
    expect(runResearch).toHaveBeenCalledTimes(1);
  });

  it("logs one outcome line with no contact data", async () => {
    await POST(post({ estate: "traxo", memberId: MEMBER }));
    const all = calls(console.log) + calls(console.error);
    expect(all).toContain("monsoon: research findings");
    expect(all).not.toContain("Jane");
  });
});
