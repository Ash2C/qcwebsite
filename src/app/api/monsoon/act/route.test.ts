import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/monsoon/auth";
import { signProposal, type Proposal } from "@/lib/monsoon/ask/proposal";

const withEstateDb = vi.fn();
const addNote = vi.fn();
const moveStage = vi.fn();
const vocabulary = vi.fn();
vi.mock("@/lib/monsoon/db", () => ({
  withEstateDb: (...args: unknown[]) => withEstateDb(...args),
}));
vi.mock("@/lib/monsoon/ask/actions", () => ({
  addNote: (...args: unknown[]) => addNote(...args),
  moveStage: (...args: unknown[]) => moveStage(...args),
}));
vi.mock("@/lib/monsoon/ask/queries", () => ({
  vocabulary: (...args: unknown[]) => vocabulary(...args),
}));

import { POST } from "./route";

const MEMBER = "11111111-1111-4111-8111-111111111111";
const fakeClient = { fake: true };

function noteProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    kind: "add_note",
    estate: "traxo",
    memberId: MEMBER,
    memberKind: "company",
    memberName: "Northwind Capital",
    company: null,
    about: null,
    expires: Date.now() + 10 * 60 * 1000,
    ...over,
  } as Proposal;
}
function stageProposal(over: Record<string, unknown> = {}): Proposal {
  return {
    kind: "move_stage",
    estate: "traxo",
    memberId: MEMBER,
    memberKind: "person",
    memberName: "Li Wei",
    company: "Acme Capital",
    about: null,
    fromStage: "contacted",
    toStage: "engaged",
    expires: Date.now() + 10 * 60 * 1000,
    ...over,
  } as Proposal;
}

function post(body: unknown, authenticated = true): Request {
  return new Request("http://localhost/api/monsoon/act", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Cookie: `monsoon_session=${signSession()}` } : {}),
    },
  });
}
function signed(proposal: Proposal, extra: Record<string, unknown> = {}) {
  return { estate: proposal.estate, proposal, signature: signProposal(proposal), ...extra };
}

beforeEach(() => {
  withEstateDb.mockReset();
  addNote.mockReset();
  moveStage.mockReset();
  vocabulary.mockReset();
  withEstateDb.mockImplementation(async (_estate, fn) => fn(fakeClient));
  vocabulary.mockResolvedValue({
    stages: [
      { key: "contacted", label: "Contacted", ord: 1, terminal: false },
      { key: "engaged", label: "Engaged", ord: 2, terminal: false },
      { key: "client", label: "Client", ord: 3, terminal: true },
    ],
    roles: [],
    owners: [],
  });
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function nothingCalled() {
  expect(withEstateDb).not.toHaveBeenCalled();
  expect(addNote).not.toHaveBeenCalled();
  expect(moveStage).not.toHaveBeenCalled();
}

describe("POST /api/monsoon/act", () => {
  it("answers 401 without a session and calls nothing", async () => {
    const res = await POST(post(signed(noteProposal(), { text: "hi" }), false));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    nothingCalled();
  });

  it("answers 401 before looking at an oversized or malformed body", async () => {
    expect((await POST(post("{", false))).status).toBe(401);
    expect((await POST(post("x".repeat(20000), false))).status).toBe(401);
  });

  it("answers 413 to an over-cap body after a valid session", async () => {
    const res = await POST(post("x".repeat(16385)));
    expect(res.status).toBe(413);
    nothingCalled();
  });

  it("answers 400 for malformed JSON and for an unknown estate", async () => {
    expect((await POST(post("{"))).status).toBe(400);
    const res = await POST(post({ ...signed(noteProposal(), { text: "hi" }), estate: "qforce" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown estate" });
    nothingCalled();
  });

  it("act refuses an unsigned proposal", async () => {
    const res = await POST(post({ estate: "traxo", proposal: noteProposal(), text: "hi" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This change has expired. Ask again." });
    nothingCalled();
  });

  it("refuses a tampered member id", async () => {
    const body = signed(noteProposal(), { text: "hi" });
    body.proposal = { ...body.proposal, memberId: "22222222-2222-4222-8222-222222222222" } as Proposal;
    expect((await POST(post(body))).status).toBe(403);
    nothingCalled();
  });

  it("refuses an expired proposal", async () => {
    const res = await POST(post(signed(noteProposal({ expires: Date.now() - 1 }), { text: "hi" })));
    expect(res.status).toBe(403);
    nothingCalled();
  });

  it("refuses a proposal signed for another estate", async () => {
    const res = await POST(post({ ...signed(noteProposal(), { text: "hi" }), estate: "zeroone" }));
    expect(res.status).toBe(403);
    nothingCalled();
  });

  it("refuses a bad body shape", async () => {
    const cases: [unknown, number][] = [
      [null, 400],
      [[], 400],
      ["x", 400],
      [{ estate: "traxo" }, 403],
      [{ estate: "traxo", proposal: 5, signature: 5 }, 403],
    ];
    for (const [body, status] of cases) {
      const res = await POST(post(body));
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
    nothingCalled();
  });

  it.each([
    ["missing", undefined],
    ["not a string", 5],
    ["blank", "   \n"],
  ])("answers 400 Note text is required when the text is %s", async (_l, text) => {
    const res = await POST(post(signed(noteProposal(), { text })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Note text is required" });
    nothingCalled();
  });

  it("answers 400 Note is too long over 2,000 characters after trimming", async () => {
    const res = await POST(post(signed(noteProposal(), { text: "x".repeat(2001) })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Note is too long" });
    nothingCalled();
    addNote.mockResolvedValue({ status: "added" });
    const ok = await POST(post(signed(noteProposal(), { text: `  ${"x".repeat(2000)}  ` })));
    expect(ok.status).toBe(200);
  });

  it("adds the edited, trimmed note and says so", async () => {
    addNote.mockResolvedValue({ status: "added" });
    const res = await POST(post(signed(noteProposal(), { text: "  my edited note \n" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "added", message: "Done. Note added to Northwind Capital." });
    expect(addNote).toHaveBeenCalledTimes(1);
    expect(addNote).toHaveBeenCalledWith(fakeClient, MEMBER, "my edited note");
    expect(withEstateDb.mock.calls[0][0].key).toBe("traxo");
  });

  it("reports a duplicate note as done", async () => {
    addNote.mockResolvedValue({ status: "duplicate" });
    const res = await POST(post(signed(noteProposal(), { text: "hi" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "duplicate", message: "Done. Note added to Northwind Capital." });
  });

  it.each([
    ["moved", "engaged", "Done. Li Wei moved to Engaged."],
    ["already", "engaged", "Li Wei is already in Engaged; nothing changed."],
    ["changed", "client", "Li Wei is now in Client; nothing changed."],
    ["missing", null, "Li Wei is no longer on the pipeline; nothing changed."],
  ])("maps moveStage %s to its message", async (status, stage, message) => {
    moveStage.mockResolvedValue({ status, stage });
    const res = await POST(post(signed(stageProposal())));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status, message });
    expect(moveStage).toHaveBeenCalledWith(fakeClient, MEMBER, "contacted", "engaged");
  });

  it("falls back to the stage key when a label is unknown", async () => {
    moveStage.mockResolvedValue({ status: "changed", stage: "mystery" });
    const res = await POST(post(signed(stageProposal())));
    expect((await res.json()).message).toBe("Li Wei is now in mystery; nothing changed.");
  });

  it("answers 200 missing when the contact is gone (foreign-key violation) instead of 502", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    addNote.mockRejectedValue(Object.assign(new Error('insert or update on table "touches" violates foreign key constraint'), { code: "23503" }));
    const res = await POST(post(signed(noteProposal(), { text: "hello" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "missing", message: "Northwind Capital is no longer on the pipeline; nothing changed." });
    expect(log).not.toHaveBeenCalled();
  });

  it("still answers 502 for any other database error code while adding a note", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    addNote.mockRejectedValue(Object.assign(new Error("boom"), { code: "57014" }));
    const res = await POST(post(signed(noteProposal(), { text: "hello" })));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not reach the Traxo CRM" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("answers 502 without leaking details when the database call throws", async () => {
    const secretUrl = "postgresql://user:hunter2@db.internal.example:5432/x";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    withEstateDb.mockRejectedValue(new Error(`boom ${secretUrl} secret note`));
    const res = await POST(post(signed(noteProposal(), { text: "secret note" })));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not reach the Traxo CRM" });
    expect(text).not.toContain("hunter2");
    expect(log).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.mock.calls);
    for (const leak of ["hunter2", "boom", "secret note", "Northwind"]) expect(logged).not.toContain(leak);
  });
});
