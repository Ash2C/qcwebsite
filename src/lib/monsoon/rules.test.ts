import { describe, expect, it } from "vitest";
import fixtures from "./rules.fixtures.json";
import {
  actionLabel,
  captureOrigin,
  dueBucket,
  lastAction,
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

describe("dueBucket", () => {
  it.each(fixtures.due_bucket)("matches Python for %j", (c) => {
    expect(dueBucket(c.member, c.today)).toEqual(c.out);
  });

  it("accepts a Date for next_action_date", () => {
    expect(dueBucket({ next_action: "x", next_action_date: new Date(2026, 10, 14) }, "2026-11-13")).toBe("week");
  });
});

describe("lastAction", () => {
  it.each(fixtures.last_action)("matches Python for %j", (c) => {
    const got = lastAction(c.touches);
    expect(got).toBe(c.out === null ? null : c.touches[c.out]);
  });
});

describe("dueBucket with local-midnight Dates", () => {
  it("reads the local calendar day, like the string form", () => {
    const member = (d: string | Date) => ({ next_action: "x", next_action_date: d });
    expect(dueBucket(member(new Date(2026, 10, 14)), "2026-11-13")).toBe(dueBucket(member("2026-11-14"), "2026-11-13"));
    expect(dueBucket(member(new Date(2026, 10, 13)), "2026-11-13")).toBe("today");
    expect(dueBucket(member(new Date(2026, 10, 12)), "2026-11-13")).toBe("overdue");
  });
});

describe("lastAction with Date values", () => {
  it("a later Date beats an earlier one", () => {
    const early = { kind: "call", at: new Date("2026-02-01T00:00:00Z") };
    const late = { kind: "note", at: new Date("2026-11-13T00:00:00Z") };
    expect(lastAction([late, early])).toBe(late);
    expect(lastAction([early, late])).toBe(late);
  });

  it("a Date tie keeps the first", () => {
    const a = { kind: "call", at: new Date("2026-05-05T10:00:00Z") };
    const b = { kind: "email", at: new Date("2026-05-05T10:00:00Z") };
    expect(lastAction([a, b])).toBe(a);
  });

  it("only action kinds count", () => {
    const call = { kind: "call", at: new Date("2026-01-01T00:00:00Z") };
    const stage = { kind: "stage", at: new Date("2026-12-01T00:00:00Z") };
    expect(lastAction([stage, call])).toBe(call);
    expect(lastAction([stage])).toBeNull();
  });
});

describe("captureOrigin", () => {
  it("reads an entry written when a contact came in from an image as a photo capture, never as a meeting", () => {
    for (const text of [
      "Added from a photo of a business card",
      "Added from a photo of a badge: spoke about pricing",
      "Added from a screenshot",
      "Added from a photo (card shows Borealis Partners)",
      "Omar Reyes: Added from a photo of a badge",
      // Entries written before the wording changed.
      "Badge captured in person",
      "Captured from a screenshot: note",
      "Captured from a photo",
      "Omar Reyes: Badge captured in person: met at SFF",
    ]) {
      expect(captureOrigin(text), text).toBe("photo");
    }
  });

  it("reads a hand-typed entry, and the old wording that covered both, as simply added", () => {
    for (const text of ["Added by hand", "Added by hand: met at SFF", "Card captured in person", "Jonathan Poe: Card captured in person"]) {
      expect(captureOrigin(text), text).toBe("added");
    }
  });

  it("leaves every other entry alone", () => {
    for (const text of ["Coffee at SFF", "Call: agreed pricing", "She added from a photo", "", "Note: Card captured in person was wrong"]) {
      expect(captureOrigin(text), text).toBeNull();
    }
  });

  it("labels a last action: only a meeting entry that records the adding is renamed", () => {
    expect(actionLabel("meeting", "Added from a photo of a badge")).toBe("photo capture");
    expect(actionLabel("meeting", "Card captured in person")).toBe("added");
    expect(actionLabel("meeting", "Lunch at SFF")).toBe("meeting");
    expect(actionLabel("note", "Added from a photo")).toBe("note");
    expect(actionLabel("call", null)).toBe("call");
  });
});
