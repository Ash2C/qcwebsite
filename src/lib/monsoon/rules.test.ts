import { describe, expect, it } from "vitest";
import fixtures from "./rules.fixtures.json";
import {
  mergeFillEmpty,
  nameKey,
  orgNameCores,
  sequenceRatio,
  similarOrgNames,
} from "./rules";

describe("nameKey", () => {
  it.each(fixtures.name_key)("matches Python for %j", (c) => {
    expect(nameKey(c.in)).toEqual(c.out);
  });
});

describe("mergeFillEmpty", () => {
  it.each(fixtures.merge_fill_empty)("matches Python for %j", (c) => {
    expect(mergeFillEmpty(c.existing, c.incoming)).toEqual(c.out);
  });
});

describe("orgNameCores", () => {
  it.each(fixtures.org_name_cores)("matches Python for %j", (c) => {
    expect(orgNameCores(c.in)).toEqual(c.out);
  });
});

describe("sequenceRatio", () => {
  it.each(fixtures.ratio)("matches difflib for %j", (c) => {
    expect(sequenceRatio(c.a, c.b)).toBeCloseTo(c.out, 12);
  });
});

describe("similarOrgNames", () => {
  it.each(fixtures.similar_org_names)("matches Python for %j", (c) => {
    expect(similarOrgNames(c.name, c.existing)).toEqual(c.out);
  });

  it("treats the 0.85 threshold as inclusive, behind a six-character minimum", () => {
    expect(similarOrgNames("Corvanne", ["Corvane"])).toEqual(["Corvane"]);
    expect(similarOrgNames("Abcde", ["Abcdf"])).toEqual([]); // cores shorter than six
    // Ratio is 0.909 (above 0.85), so only the six-character minimum rejects it.
    expect(similarOrgNames("Abcde", ["Abcdef"])).toEqual([]);
  });
});
