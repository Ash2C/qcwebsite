import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_TTL_MS, signProposal, verifyProposal, type Proposal, type SignedProposal } from "./proposal";

const NOW = 1_800_000_000_000;
const MEMBER = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "c0000000-0000-4000-8000-00000000000a";
const OTHER_CUSTOMER = "c0000000-0000-4000-8000-00000000000b";

const note: Proposal = {
  kind: "add_note",
  customer: CUSTOMER,
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
  customer: CUSTOMER,
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
      customer: OTHER_CUSTOMER,
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
    for (const estate of ["Main", "a", "x".repeat(33), "has space", "main/x", 5, null]) {
      const badEstate = { ...note, estate } as unknown as Proposal;
      expect(verifyProposal(badEstate, signProposal(badEstate), NOW), String(estate)).toBe(false);
    }
    const anyKey = { ...note, estate: "qforce-2" } as Proposal;
    expect(verifyProposal(anyKey, signProposal(anyKey), NOW)).toBe(true);
    for (const customer of ["not-a-uuid", "", 5, null]) {
      const badCustomer = { ...note, customer } as unknown as Proposal;
      expect(verifyProposal(badCustomer, signProposal(badCustomer), NOW), String(customer)).toBe(false);
    }
    const { customer: _c, ...noCustomer } = note;
    expect(verifyProposal(noCustomer, signProposal(noCustomer as unknown as Proposal), NOW)).toBe(false);
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

// Computed with the code before proposals named their customer (note fixture minus customer, secret "s" x 32).
const OLD_NOTE_SIGNATURE = "7767d47b8f67253396e481193753bda1d68dbf95f4afed1c380c20cda292b160";
const PERSON = "33333333-3333-4333-8333-333333333333";
const details = {
  kind: "update_details",
  customer: CUSTOMER,
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
      { ...d, customer: OTHER_CUSTOMER },
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

  it("caps `to` at 300 characters but allows a long stored `from` up to 2000", () => {
    const d = details as Extract<Proposal, { kind: "update_details" }>;
    const one = (from: string | null, to: string | null) => ({ ...d, changes: [{ field: "title", from, to }] });
    expect(ok(one("x".repeat(2000), "short"))).toBe(true);
    expect(ok(one("x".repeat(2001), "short"))).toBe(false);
    expect(ok(one(null, "x".repeat(300)))).toBe(true);
    expect(ok(one(null, "x".repeat(301)))).toBe(false);
  });

  it("keeps the old key sets for the other two kinds", () => {
    expect(ok({ ...note, target: 1 })).toBe(false);
    expect(ok(note)).toBe(true);
    expect(ok(stage)).toBe(true);
  });

  it("refuses a proposal signed before proposals named their customer", () => {
    const { customer: _c, ...old } = note;
    expect(verifyProposal(old, OLD_NOTE_SIGNATURE, NOW)).toBe(false);
    expect(verifyProposal(note, OLD_NOTE_SIGNATURE, NOW)).toBe(false);
  });
});

describe("apply_research proposals", () => {
  const PERSON = "33333333-3333-4333-8333-333333333333";
  const COMPANY = "44444444-4444-4444-8444-444444444444";
  const finding = (over: Record<string, unknown> = {}) => ({
    id: "f1",
    target: "person",
    field: "title",
    from: "Analyst",
    to: "Director",
    source: "https://example.com/team/jane",
    ...over,
  });
  const research = (over: Record<string, unknown> = {}): Proposal =>
    ({
      kind: "apply_research",
      customer: CUSTOMER,
      estate: "zeroone",
      person: { id: PERSON, name: "Jane Tan" },
      company: { id: COMPANY, name: "Northwind Capital" },
      identity: "Same firm and city as on file.",
      findings: [finding()],
      summarySources: ["https://example.com/news"],
      logMemberId: PERSON,
      addsToPipeline: null,
      expires: NOW + PROPOSAL_TTL_MS,
      ...over,
    }) as Proposal;
  const refused = (p: Proposal) => verifyProposal(p, signProposal(p), NOW);

  it("signs and verifies a valid proposal", () => {
    const p = research();
    expect(verifyProposal(p, signProposal(p), NOW)).toBe(true);
    const two = research({
      findings: [finding(), finding({ id: "f2", target: "company", field: "website", from: null, to: "https://northwind.example" })],
    });
    expect(refused(two)).toBe(true);
  });

  it("refuses malformed shapes", () => {
    const base = research() as unknown as Record<string, unknown>;
    expect(refused({ ...base, extra: 1 } as unknown as Proposal)).toBe(false);
    const { identity: _i, ...missing } = base;
    expect(refused(missing as unknown as Proposal)).toBe(false);
    expect(refused(research({ findings: [finding({ id: "f9" })] }))).toBe(false);
    expect(refused(research({ findings: [finding(), finding({ field: "country", from: null })] }))).toBe(false);
    expect(refused(research({ findings: [finding(), finding({ id: "f2" })] }))).toBe(false);
    expect(refused(research({ findings: [finding({ target: "person", field: "website" })] }))).toBe(false);
    expect(refused(research({ findings: [finding({ target: "company", field: "title" })] }))).toBe(false);
    expect(
      refused(research({ company: null, findings: [finding({ target: "company", field: "website", from: null })] })),
    ).toBe(false);
    expect(refused(research({ findings: [finding({ to: "x".repeat(301) })] }))).toBe(false);
    expect(refused(research({ findings: [finding({ from: "Director" })] }))).toBe(false);
    expect(refused(research({ findings: [finding({ source: "http://example.com/a" })] }))).toBe(false);
    expect(refused(research({ findings: [finding({ source: "not a url" })] }))).toBe(false);
    expect(refused(research({ summarySources: ["https://e.com/" + "a".repeat(500)] }))).toBe(false);
    expect(refused(research({ identity: "" }))).toBe(false);
    expect(refused(research({ person: { id: "nope", name: "Jane" } }))).toBe(false);
  });

  it("enforces count limits", () => {
    const fields = ["title", "linkedin", "country", "email", "phone"] as const;
    const nine = Array.from({ length: 9 }, (_, i) =>
      finding({ id: `f${(i % 8) + 1}`, field: fields[i % 5], target: i < 5 ? "person" : "company" }),
    );
    expect(refused(research({ findings: nine }))).toBe(false);
    expect(refused(research({ summarySources: Array.from({ length: 7 }, (_, i) => `https://e.com/${i}`) }))).toBe(false);
    expect(refused(research({ findings: [], summarySources: [] }))).toBe(false);
    expect(refused(research({ findings: [], summarySources: ["https://e.com/a"] }))).toBe(true);
  });

  it("refuses tampering, expiry, another customer and a malformed estate", () => {
    const p = research();
    const sig = signProposal(p);
    const changed = research({ findings: [finding({ to: "CEO" })] });
    expect(verifyProposal(changed, sig, NOW)).toBe(false);
    const added = research({ findings: [finding(), finding({ id: "f2", field: "country", from: null, to: "Singapore" })] });
    expect(verifyProposal(added, sig, NOW)).toBe(false);
    expect(verifyProposal(p, sig, p.expires)).toBe(false);
    expect(refused(research({ estate: "Nowhere" }))).toBe(false);
    expect(verifyProposal(research({ customer: OTHER_CUSTOMER }), sig, NOW)).toBe(false);
  });
});

describe("to-do proposals", () => {
  const TODO = "55555555-5555-4555-8555-555555555555";
  const base = { customer: CUSTOMER, estate: "traxo", expires: NOW + PROPOSAL_TTL_MS };
  const add = {
    kind: "add_todo", ...base, title: "Send deck", dueDate: "2026-12-01",
    memberId: MEMBER, memberKind: "company", memberName: "Northwind Capital", company: null,
    aboutPersonId: PERSON, about: "Jane Tan",
  } as Proposal;
  const addLoose = {
    kind: "add_todo", ...base, title: "Renew licence", dueDate: null,
    memberId: null, memberKind: null, memberName: null, company: null, aboutPersonId: null, about: null,
  } as Proposal;
  const complete = { kind: "complete_todo", ...base, todoId: TODO, title: "Send deck", memberName: "Jane Tan", outcome: "Sent, she liked it" } as Proposal;
  const move = { kind: "move_todo", ...base, todoId: TODO, title: "Send deck", memberName: "Jane Tan", fromDate: "2026-12-01", toDate: "2026-12-08" } as Proposal;
  const drop = { kind: "drop_todo", ...base, todoId: TODO, title: "Send deck", memberName: null } as Proposal;
  const ok = (p: unknown) => verifyProposal(p, signProposal(p as Proposal), NOW);

  it("round-trips sign and verify for all four kinds", () => {
    for (const p of [add, addLoose, complete, move, drop]) expect(verifyProposal(p, signProposal(p), NOW)).toBe(true);
    expect(ok({ ...complete, outcome: null })).toBe(true);
    expect(ok({ ...move, toDate: null })).toBe(true);
  });

  it("rejects a changed title or toDate, and any other changed field", () => {
    for (const p of [add, complete, move, drop]) {
      expect(verifyProposal({ ...p, title: "Send something else" }, signProposal(p), NOW), p.kind).toBe(false);
      expect(verifyProposal({ ...p, customer: OTHER_CUSTOMER }, signProposal(p), NOW), p.kind).toBe(false);
    }
    expect(verifyProposal({ ...move, toDate: "2026-12-09" }, signProposal(move), NOW)).toBe(false);
    expect(verifyProposal({ ...move, fromDate: "2026-11-30" }, signProposal(move), NOW)).toBe(false);
    expect(verifyProposal({ ...complete, outcome: "Other" }, signProposal(complete), NOW)).toBe(false);
    expect(verifyProposal({ ...add, dueDate: "2026-12-02" }, signProposal(add), NOW)).toBe(false);
    expect(verifyProposal({ ...add, aboutPersonId: MEMBER }, signProposal(add), NOW)).toBe(false);
  });

  it("refuses a validly signed proposal of the wrong shape", () => {
    const bad: unknown[] = [
      { ...add, title: "" },
      { ...add, title: "x".repeat(301) },
      { ...add, dueDate: "2026-02-30x" },
      { ...add, memberId: "nope" },
      { ...addLoose, memberName: "Someone" },
      { ...add, memberKind: "robot" },
      { ...complete, todoId: "nope" },
      { ...complete, outcome: "   " },
      { ...complete, outcome: "x".repeat(2001) },
      { ...move, fromDate: move.kind === "move_todo" ? move.toDate : null },
      { ...move, toDate: "tomorrow" },
      { ...drop, sneaky: 1 },
      { ...drop, memberName: 5 },
    ];
    for (const p of bad) expect(ok(p)).toBe(false);
  });
});
