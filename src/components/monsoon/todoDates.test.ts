import { describe, expect, it } from "vitest";
import { addDays, bucketOf, dayOf, formatDay, shortDate } from "./todoDates";

const NOW = new Date(2026, 10, 26, 9, 30); // Thu 26 Nov 2026, local

describe("todoDates", () => {
  it("dayOf reads the local calendar day, not the UTC one", () => {
    expect(dayOf(new Date(2026, 0, 5, 0, 10))).toBe("2026-01-05");
    expect(dayOf(new Date(2026, 11, 31, 23, 50))).toBe("2026-12-31");
  });

  it("addDays moves by calendar days across months and years", () => {
    expect(addDays("2026-11-26", 1)).toBe("2026-11-27");
    expect(addDays("2026-11-26", 7)).toBe("2026-12-03");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("buckets a due date against today with the week ending today + 7", () => {
    const today = "2026-11-26";
    expect(bucketOf(null, today)).toBe("undated");
    expect(bucketOf("2026-11-25", today)).toBe("overdue");
    expect(bucketOf("2026-11-26", today)).toBe("today");
    expect(bucketOf("2026-11-27", today)).toBe("week");
    expect(bucketOf("2026-12-03", today)).toBe("week");
    expect(bucketOf("2026-12-04", today)).toBe("later");
  });

  it("formats a day with its weekday, and the year only when it is not this year", () => {
    expect(formatDay("2026-11-23", NOW)).toBe("Mon 23 Nov");
    expect(formatDay("2027-01-04", NOW)).toBe("Mon 4 Jan 2027");
  });

  it("shortDate takes a day or a time and drops the year for this year", () => {
    expect(shortDate("2026-11-19", NOW)).toBe("19 Nov");
    expect(shortDate("2025-11-19", NOW)).toBe("19 Nov 2025");
    expect(shortDate(new Date(2026, 10, 19, 15, 0).toISOString(), NOW)).toBe("19 Nov");
    expect(shortDate("not a date", NOW)).toBe("");
  });
});
