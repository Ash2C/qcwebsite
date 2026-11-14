import { describe, expect, it } from "vitest";
import type { CardMatch, MatchCandidate } from "@/lib/monsoon/match";
import { changeOf, choiceAfter, confidentId, matchTag, needsChoice } from "./matchState";

const cand = (by: MatchCandidate["by"], nameAgrees = true): MatchCandidate => ({
  personId: "p1",
  name: "Jane Tan",
  title: null,
  company: "Acme",
  email: null,
  member: null,
  memberOf: null,
  by,
  nameAgrees,
});
const exact = (c: MatchCandidate): CardMatch => ({ match: "exact", candidates: [c] });

describe("confidentId and matchTag", () => {
  it("name and company: confident, On file", () => {
    expect(confidentId(exact(cand("name_company")))).toBe("p1");
    expect(matchTag(exact(cand("name_company")))).toBe("On file");
  });
  it("email with the name agreeing: confident, On file", () => {
    expect(confidentId(exact(cand("email", true)))).toBe("p1");
    expect(matchTag(exact(cand("email", true)))).toBe("On file");
  });
  it("email under another name: not confident, Check", () => {
    expect(confidentId(exact(cand("email", false)))).toBeUndefined();
    expect(matchTag(exact(cand("email", false)))).toBe("Check");
  });
  it("same name, several, none, no information", () => {
    expect(confidentId({ match: "same_name", candidates: [cand("name")] })).toBeUndefined();
    expect(matchTag({ match: "same_name", candidates: [cand("name")] })).toBe("Check");
    expect(matchTag({ match: "several", candidates: [cand("name"), cand("name")] })).toBe("Check");
    expect(matchTag({ match: "none", candidates: [] })).toBe("New");
    expect(matchTag(null)).toBeNull();
    expect(confidentId(null)).toBeUndefined();
  });
});

describe("needsChoice", () => {
  const same: CardMatch = { match: "same_name", candidates: [cand("name")] };
  it("same name, blank company, nothing chosen", () => {
    expect(needsChoice(same, "  ", undefined, undefined)).toBe(true);
  });
  it("not when a company is typed, a choice or an answer exists, or the match is another kind", () => {
    expect(needsChoice(same, "Acme", undefined, undefined)).toBe(false);
    expect(needsChoice(same, "", false, undefined)).toBe(false);
    expect(needsChoice(same, "", "p1", undefined)).toBe(false);
    expect(needsChoice(same, "", undefined, false)).toBe(false);
    expect(needsChoice(exact(cand("name_company")), "", undefined, undefined)).toBe(false);
    expect(needsChoice(null, "", undefined, undefined)).toBe(false);
  });
  it("an email match under another name needs a choice too, but not one whose name agrees", () => {
    expect(needsChoice(exact(cand("email", false)), "", undefined, undefined)).toBe(true);
    expect(needsChoice(exact(cand("email", false)), "Acme", undefined, undefined)).toBe(false);
    expect(needsChoice(exact(cand("email", false)), "", false, undefined)).toBe(false);
    expect(needsChoice(exact(cand("email", true)), "", undefined, undefined)).toBe(false);
  });
});

describe("changeOf and choiceAfter", () => {
  const a = { name: "Jane", org: "Acme", email: "j@a.com" };
  it("classifies the edit", () => {
    expect(changeOf(a, { ...a })).toBe("same");
    expect(changeOf(a, { ...a, org: "B" })).toBe("company");
    expect(changeOf(a, { ...a, name: "Jan" })).toBe("person");
    expect(changeOf(a, { ...a, email: "x" })).toBe("person");
    expect(changeOf(a, { ...a, name: "Jan", org: "B" })).toBe("person");
  });
  it("a company edit keeps only Different person", () => {
    expect(choiceAfter("p1", "company")).toBeUndefined();
    expect(choiceAfter(false, "company")).toBe(false);
    expect(choiceAfter(false, "person")).toBeUndefined();
    expect(choiceAfter("p1", "same")).toBe("p1");
  });
});
