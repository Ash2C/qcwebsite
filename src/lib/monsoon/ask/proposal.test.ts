import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_TTL_MS, signProposal, verifyProposal, type Proposal, type SignedProposal } from "./proposal";

const NOW = 1_800_000_000_000;
const MEMBER = "11111111-1111-4111-8111-111111111111";

const note: Proposal = {
  kind: "add_note",
  estate: "zeroone",
  memberId: MEMBER,
  memberKind: "company",
  memberName: "Northwind Capital",
  company: null,
  about: "Jane Tan",
  expires: NOW + PROPOSAL_TTL_MS,
};
const stage: Proposal = {
  kind: "move_stage",
  estate: "traxo",
  memberId: MEMBER,
  memberKind: "person",
  memberName: "Li Wei",
  company: "Acme Capital",
  about: null,
  fromStage: "contacted",
  toStage: "engaged",
  expires: NOW + PROPOSAL_TTL_MS,
};

beforeEach(() => {
  vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proposal signing", () => {
  it("verifies what it signed", () => {
    expect(PROPOSAL_TTL_MS).toBe(1_800_000);
    for (const p of [note, stage]) {
      const sig = signProposal(p);
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyProposal(p, sig, NOW)).toBe(true);
    }
  });

  it("rejects any changed field", () => {
    const sig = signProposal(stage);
    const changes: Record<string, unknown> = {
      kind: "add_note",
      estate: "zeroone",
      memberId: "22222222-2222-4222-8222-222222222222",
      memberKind: "company",
      memberName: "Someone Else",
      company: "Other",
      about: "Jane Tan",
      fromStage: "uncontacted",
      toStage: "client",
      expires: stage.expires + 1,
    };
    for (const [key, value] of Object.entries(changes)) {
      expect(verifyProposal({ ...stage, [key]: value }, sig, NOW), key).toBe(false);
    }
  });

  it("rejects a changed signature character, a wrong length and non-hex", () => {
    const sig = signProposal(note);
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(verifyProposal(note, flipped, NOW)).toBe(false);
    expect(verifyProposal(note, sig.slice(0, 62), NOW)).toBe(false);
    expect(verifyProposal(note, sig + "00", NOW)).toBe(false);
    expect(verifyProposal(note, "z".repeat(64), NOW)).toBe(false);
    expect(verifyProposal(note, 5, NOW)).toBe(false);
    expect(verifyProposal(note, undefined, NOW)).toBe(false);
  });

  it("rejects a different secret", () => {
    const sig = signProposal(note);
    vi.stubEnv("MONSOON_SESSION_SECRET", "t".repeat(32));
    expect(verifyProposal(note, sig, NOW)).toBe(false);
  });

  it("rejects an expired proposal, and accepts up to the expiry", () => {
    const sig = signProposal(note);
    expect(verifyProposal(note, sig, note.expires - 1)).toBe(true);
    expect(verifyProposal(note, sig, note.expires)).toBe(false);
    expect(verifyProposal(note, sig, note.expires + 1)).toBe(false);
  });

  it("rejects non-objects, missing fields, extra fields, bad types and unknown kinds", () => {
    for (const bad of [null, undefined, "x", 5, [], [note]]) {
      expect(verifyProposal(bad, "a".repeat(64), NOW)).toBe(false);
    }
    const { memberName: _omit, ...missing } = note;
    expect(verifyProposal(missing, signProposal(note), NOW)).toBe(false);
    // a validly signed proposal of the wrong shape is still refused
    const extra = { ...note, sneaky: 1 } as unknown as Proposal;
    expect(verifyProposal(extra, signProposal(extra), NOW)).toBe(false);
    const wrongKind = { ...note, fromStage: "a", toStage: "b" } as unknown as Proposal;
    expect(verifyProposal(wrongKind, signProposal(wrongKind), NOW)).toBe(false);
    const unknownKind = { ...note, kind: "delete" } as unknown as Proposal;
    expect(verifyProposal(unknownKind, signProposal(unknownKind), NOW)).toBe(false);
    const badEstate = { ...note, estate: "qforce" } as unknown as Proposal;
    expect(verifyProposal(badEstate, signProposal(badEstate), NOW)).toBe(false);
    const badType = { ...note, expires: "soon" } as unknown as Proposal;
    expect(verifyProposal(badType, signProposal(badType), NOW)).toBe(false);
    const badKind = { ...note, memberKind: "robot" } as unknown as Proposal;
    expect(verifyProposal(badKind, signProposal(badKind), NOW)).toBe(false);
  });

  it("is independent of key order", () => {
    const shuffled = Object.fromEntries(Object.entries(stage).reverse()) as Proposal;
    expect(signProposal(shuffled)).toBe(signProposal(stage));
    expect(verifyProposal(shuffled, signProposal(stage), NOW)).toBe(true);
  });

  it("does not cover the suggested note text", () => {
    const withText: SignedProposal = { proposal: note, signature: signProposal(note), text: "one" };
    const edited: SignedProposal = { ...withText, text: "two" };
    expect(verifyProposal(edited.proposal, edited.signature, NOW)).toBe(true);
  });

  it("throws on signing, and refuses to verify, without a long enough secret", () => {
    const sig = signProposal(note);
    vi.stubEnv("MONSOON_SESSION_SECRET", "short");
    expect(() => signProposal(note)).toThrow();
    expect(verifyProposal(note, sig, NOW)).toBe(false);
    vi.stubEnv("MONSOON_SESSION_SECRET", "");
    expect(() => signProposal(note)).toThrow();
    expect(verifyProposal(note, sig, NOW)).toBe(false);
  });
});

// Computed with the code before update_details existed (note fixture, secret "s" x 32).
const OLD_NOTE_SIGNATURE = "7767d47b8f67253396e481193753bda1d68dbf95f4afed1c380c20cda292b160";
const PERSON = "33333333-3333-4333-8333-333333333333";
const details = {
  kind: "update_details",
  estate: "zeroone",
  target: { type: "person", id: PERSON },
  targetName: "Li Wei",
  company: "Acme Capital",
  changes: [
    { field: "title", from: "Analyst", to: "Director" },
    { field: "phone", from: null, to: "+65 5555 0100" },
  ],
  logMemberId: MEMBER,
  addsToPipeline: null,
  expires: NOW + PROPOSAL_TTL_MS,
} as Proposal;
const companyDetails = {
  ...details,
  target: { type: "company", id: PERSON },
  company: null,
  changes: [{ field: "website", from: null, to: "https://acme.example" }],
} as Proposal;

describe("update_details proposals", () => {
  const ok = (p: unknown) => verifyProposal(p, signProposal(p as Proposal), NOW);

  it("signs and verifies", () => {
    for (const p of [details, companyDetails]) {
      expect(verifyProposal(p, signProposal(p), NOW)).toBe(true);
    }
    const adds = { ...details, logMemberId: null, addsToPipeline: "investor" } as Proposal;
    expect(ok(adds)).toBe(true);
  });

  it("rejects a changed to, an added change, a changed target id, another estate, an extra key and expiry", () => {
    const sig = signProposal(details);
    const d = details as Extract<Proposal, { kind: "update_details" }>;
    const variants: unknown[] = [
      { ...d, changes: [{ ...d.changes[0], to: "CEO" }, d.changes[1]] },
      { ...d, changes: [...d.changes, { field: "country", from: null, to: "SG" }] },
      { ...d, target: { type: "person", id: "44444444-4444-4444-8444-444444444444" } },
      { ...d, estate: "traxo" },
      { ...d, sneaky: 1 },
    ];
    for (const v of variants) expect(verifyProposal(v, sig, NOW)).toBe(false);
    expect(verifyProposal(details, sig, d.expires)).toBe(false);
  });

  it("refuses a validly signed proposal of the wrong shape", () => {
    const d = details as Extract<Proposal, { kind: "update_details" }>;
    const change = (field: string, from: string | number | null, to: string | null) => ({ field, from, to });
    const bad: unknown[] = [
      { ...d, changes: [change("website", null, "x")] }, // website on a person
      { ...(companyDetails as object), changes: [change("title", null, "x")] }, // title on a company
      { ...d, changes: [change("title", "a", "b"), change("title", "c", "d")] }, // duplicate field
      { ...d, changes: [] },
      { ...d, changes: [change("title", "a", "a")] }, // from equals to
      { ...d, changes: [change("title", 1, "a")] },
      { ...d, changes: [change("name", "Li Wei", null)] }, // name cannot be cleared
      { ...d, changes: [change("title", null, "x".repeat(301))] },
      { ...d, changes: Array.from({ length: 9 }, () => change("title", null, "x")) },
      { ...d, target: { type: "robot", id: PERSON } },
      { ...d, target: { type: "person", id: "not-a-uuid" } },
      { ...d, logMemberId: "nope" },
      { ...d, addsToPipeline: 5 },
      { ...d, targetName: 5 },
      { ...d, company: 5 },
      { ...d, memberId: MEMBER },
    ];
    for (const p of bad) expect(ok(p), JSON.stringify(p)).toBe(false);
  });

  it("keeps the old key sets for the other two kinds", () => {
    expect(ok({ ...note, target: 1 })).toBe(false);
    expect(ok(note)).toBe(true);
    expect(ok(stage)).toBe(true);
  });

  it("verifies a note proposal signed before update_details existed", () => {
    expect(verifyProposal(note, OLD_NOTE_SIGNATURE, NOW)).toBe(true);
  });
});
