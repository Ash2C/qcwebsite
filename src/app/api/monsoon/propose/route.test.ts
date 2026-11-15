import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signLegacySession } from "@/lib/monsoon/auth";

const withEstateDb = vi.fn();
const proposeNote = vi.fn();
const proposeStage = vi.fn();
const proposeDetails = vi.fn();
const addNote = vi.fn();
const moveStage = vi.fn();
const applyDetails = vi.fn();
vi.mock("@/lib/monsoon/db", () => ({ withEstateDb: (...a: unknown[]) => withEstateDb(...a) }));
vi.mock("@/lib/monsoon/ask/actions", () => ({
  proposeNote: (...a: unknown[]) => proposeNote(...a),
  proposeStage: (...a: unknown[]) => proposeStage(...a),
  addNote: (...a: unknown[]) => addNote(...a),
  moveStage: (...a: unknown[]) => moveStage(...a),
}));
vi.mock("@/lib/monsoon/details", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/monsoon/details")>()),
  proposeDetails: (...a: unknown[]) => proposeDetails(...a),
  applyDetails: (...a: unknown[]) => applyDetails(...a),
}));

import { POST } from "./route";

const MEMBER = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const fakeClient = { fake: true };
const signed = { proposal: { kind: "x" }, signature: "y" };

function post(body: unknown, authenticated = true): Request {
  return new Request("http://localhost/api/monsoon/propose", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Cookie: `monsoon_session=${signLegacySession()}` } : {}),
    },
  });
}

function nothingCalled() {
  expect(withEstateDb).not.toHaveBeenCalled();
  for (const f of [proposeNote, proposeStage, proposeDetails]) expect(f).not.toHaveBeenCalled();
}
function neverWrites() {
  for (const f of [addNote, moveStage, applyDetails]) expect(f).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const f of [withEstateDb, proposeNote, proposeStage, proposeDetails, addNote, moveStage, applyDetails]) f.mockReset();
  withEstateDb.mockImplementation(async (_e, fn) => fn(fakeClient));
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/propose", () => {
  it("answers 401 first, before the body is read, and calls nothing", async () => {
    expect((await POST(post({ estate: "traxo" }, false))).status).toBe(401);
    expect((await POST(post("{", false))).status).toBe(401);
    expect((await POST(post("x".repeat(20000), false))).status).toBe(401);
    nothingCalled();
  });

  it("answers 413 over the cap, 400 for malformed JSON, estate, kind and body", async () => {
    expect((await POST(post("x".repeat(16385)))).status).toBe(413);
    expect((await POST(post("{"))).status).toBe(400);
    const cases: unknown[] = [
      null,
      [],
      "x",
      { kind: "add_note", target: {} },
      { estate: "qforce", kind: "add_note", target: {} },
      { estate: "traxo", kind: "delete", target: {} },
      { estate: "traxo", target: {} },
      { estate: "traxo", kind: "add_note" },
      { estate: "traxo", kind: "add_note", target: [] },
      { estate: "traxo", kind: "add_note", target: { memberId: 5 } },
      { estate: "traxo", kind: "update_details", target: {}, changes: [] },
      { estate: "traxo", kind: "update_details", target: {}, changes: { title: 5 } },
      { estate: "traxo", kind: "update_details", target: {}, changes: { shoeSize: "9" } },
      { estate: "traxo", kind: "update_details", target: {} },
      { estate: "traxo", kind: "add_note", target: {}, text: 5 },
      { estate: "traxo", kind: "move_stage", target: {}, stage: 5 },
    ];
    for (const body of cases) expect((await POST(post(body))).status, JSON.stringify(body)).toBe(400);
    nothingCalled();
  });

  it("maps add_note to proposeNote and passes the reason through as ok false", async () => {
    proposeNote.mockResolvedValue({ ok: true, signed });
    const res = await POST(post({ estate: "traxo", kind: "add_note", target: { memberId: MEMBER, orgId: PERSON }, text: "hi" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signed });
    expect(proposeNote).toHaveBeenCalledWith(fakeClient, "traxo", { memberId: MEMBER }, "hi", expect.any(Number));
    expect(withEstateDb.mock.calls[0][0].key).toBe("traxo");

    proposeNote.mockResolvedValue({ ok: false, reason: "The note is empty." });
    const no = await POST(post({ estate: "traxo", kind: "add_note", target: { personId: PERSON }, text: "" }));
    expect(no.status).toBe(200);
    expect(await no.json()).toEqual({ ok: false, reason: "The note is empty." });
    neverWrites();
  });

  it("maps move_stage to proposeStage", async () => {
    proposeStage.mockResolvedValue({ ok: true, signed });
    const res = await POST(post({ estate: "zeroone", kind: "move_stage", target: { personId: PERSON }, stage: "engaged" }));
    expect(await res.json()).toEqual({ ok: true, signed });
    expect(proposeStage).toHaveBeenCalledWith(fakeClient, "zeroone", { personId: PERSON }, "engaged", expect.any(Number));
    neverWrites();
  });

  it("maps update_details to proposeDetails with the estate's default role", async () => {
    proposeDetails.mockResolvedValue({ ok: true, signed });
    const body = {
      estate: "traxo",
      kind: "update_details",
      target: { personId: PERSON, orgId: MEMBER },
      changes: { title: "Director", phone: null },
      newCompany: true,
    };
    const res = await POST(post(body));
    expect(await res.json()).toEqual({ ok: true, signed });
    expect(proposeDetails).toHaveBeenCalledWith(
      fakeClient,
      "traxo",
      { personId: PERSON, orgId: MEMBER },
      { title: "Director", phone: null },
      { nowMs: expect.any(Number), defaultRole: "lp_prospect", newCompany: true },
    );
    await POST(post({ ...body, estate: "zeroone", newCompany: undefined }));
    expect(proposeDetails.mock.calls[1][4]).toEqual({ nowMs: expect.any(Number), defaultRole: "investor", newCompany: false });

    proposeDetails.mockResolvedValue({ ok: false, reason: "Nothing to change." });
    const no = await POST(post(body));
    expect(no.status).toBe(200);
    expect(await no.json()).toEqual({ ok: false, reason: "Nothing to change." });
    neverWrites();
  });

  it("answers 502 without leaking details when the database throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    proposeDetails.mockRejectedValue(Object.assign(new Error("boom hunter2 secret"), { code: "57014" }));
    const res = await POST(post({ estate: "traxo", kind: "update_details", target: { personId: PERSON }, changes: { title: "x" } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not reach the Traxo CRM" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/hunter2|secret|boom/);
    neverWrites();
  });
});
