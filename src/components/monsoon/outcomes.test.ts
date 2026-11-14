import { describe, expect, it } from "vitest";
import { describeResult } from "./outcomes";

const ctx = {
  name: "Jane Tan",
  org: "Acme Capital",
  estateLabel: "Traxo",
  roleLabel: (k: string) => (k === "lp_prospect" ? "LP prospect" : k),
};
const PERSON = "6f1c2a3e-0000-4000-8000-000000000001";

describe("describeResult", () => {
  it("added", () => {
    expect(
      describeResult({ outcome: "added", person: PERSON, org: null, role: "lp_prospect", filled: [] }, ctx),
    ).toEqual({ kind: "done", text: "Jane Tan added to Traxo." });
  });

  it("existing with filled fields", () => {
    expect(
      describeResult(
        { outcome: "existing", person: PERSON, org: null, role: "lp_prospect", filled: ["email", "phone"] },
        ctx,
      ),
    ).toEqual({ kind: "done", text: "Jane Tan is already in Traxo as LP prospect; filled in email, phone." });
  });

  it("existing with nothing new", () => {
    expect(
      describeResult({ outcome: "existing", person: PERSON, org: null, role: "lp_prospect", filled: [] }, ctx),
    ).toEqual({ kind: "done", text: "Jane Tan is already in Traxo as LP prospect; nothing new." });
  });

  it("duplicate", () => {
    expect(describeResult({ outcome: "duplicate", person: PERSON, org: null }, ctx)).toEqual({
      kind: "done",
      text: "Jane Tan saved to Traxo.",
    });
  });

  it("org_lookalike with one similar names it", () => {
    expect(describeResult({ outcome: "org_lookalike", similar: ["Acme Capital Ltd"] }, ctx)).toEqual({
      kind: "prompt",
      text: "Acme Capital looks like Acme Capital Ltd, already on file.",
      prompt: { kind: "org_lookalike", similar: ["Acme Capital Ltd"] },
    });
  });

  it("org_lookalike with several does not name them", () => {
    expect(describeResult({ outcome: "org_lookalike", similar: ["A", "B"] }, ctx)).toEqual({
      kind: "prompt",
      text: "Acme Capital looks like a company already on file.",
      prompt: { kind: "org_lookalike", similar: ["A", "B"] },
    });
  });

  it("same_name", () => {
    const matches = [{ personId: "p1", org: "Beta" }];
    expect(describeResult({ outcome: "same_name", matches }, ctx)).toEqual({
      kind: "prompt",
      text: "Jane Tan is already on file at Beta. Same person?",
      prompt: { kind: "same_name", matches },
    });
  });

  it("same_name with no company on the first match", () => {
    expect(describeResult({ outcome: "same_name", matches: [{ personId: "p1", org: null }] }, ctx)).toMatchObject({
      text: "Jane Tan is already on file at no company. Same person?",
    });
  });

  it("uses the name on file when the server sends one", () => {
    const ctx = { name: "Jon Poe", org: "", estateLabel: "Traxo", roleLabel: (k: string) => k };
    expect(describeResult({ outcome: "added", person: PERSON, name: "Jonathan Poe", org: null, role: "investor", filled: [] }, ctx)).toEqual({
      kind: "done",
      text: "Jonathan Poe added to Traxo.",
    });
    expect(
      describeResult({ outcome: "filed", person: PERSON, name: "Jonathan Poe", org: "Northwind", role: "investor", filled: [], created: false }, ctx),
    ).toEqual({ kind: "done", text: "Jonathan Poe is already on file under Northwind; meeting logged." });
    expect(describeResult({ outcome: "existing", person: PERSON, name: "Jonathan Poe", org: null, role: "investor", filled: [] }, ctx)).toEqual({
      kind: "done",
      text: "Jonathan Poe is already in Traxo as investor; nothing new.",
    });
  });

  it("filed, new person", () => {
    expect(
      describeResult(
        { outcome: "filed", person: PERSON, org: "Northwind", role: "investor", filled: [], created: true },
        ctx,
      ),
    ).toEqual({ kind: "done", text: "Jane Tan filed under Northwind." });
  });

  it("filed, existing person, with and without filled fields", () => {
    const base = { outcome: "filed" as const, person: PERSON, org: "Northwind", role: "investor", created: false };
    expect(describeResult({ ...base, filled: [] }, ctx)).toEqual({
      kind: "done",
      text: "Jane Tan is already on file under Northwind; meeting logged.",
    });
    expect(describeResult({ ...base, filled: ["email", "phone"] }, ctx)).toEqual({
      kind: "done",
      text: "Jane Tan is already on file under Northwind; meeting logged; filled in email, phone.",
    });
  });

  it("needs_company", () => {
    expect(describeResult({ outcome: "needs_company", orgs: ["A"] }, ctx)).toEqual({
      kind: "info",
      text: "Add their company so I can tell them apart.",
    });
  });

  it("ambiguous", () => {
    expect(describeResult({ outcome: "ambiguous", orgs: ["A", null] }, ctx)).toEqual({
      kind: "info",
      text: "Several people are named Jane Tan. Add the company to say which one.",
    });
  });
});
