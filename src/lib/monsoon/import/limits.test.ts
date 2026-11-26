import { describe, expect, it } from "vitest";
import { BODY_SHARE, CHECK_MAX_BODY, SAVE_MAX_BODY, bySize, jsonBytes, requestBudget, utf8Bytes } from "./limits";
import { MAX_FIELD, MAX_NOTES, cleanContact } from "./mapping";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("import request sizes", () => {
  it("counts bytes as the request body will be sent", () => {
    for (const text of ["", "plain", "café", "注釈", "a😀b", '"quoted"\n']) {
      expect(utf8Bytes(text)).toBe(bytes(text));
      expect(jsonBytes({ text })).toBe(bytes(JSON.stringify({ text })));
    }
  });

  it("fills a request to 60% of the route's limit", () => {
    expect(BODY_SHARE).toBe(0.6);
    expect(requestBudget(SAVE_MAX_BODY)).toBe(157_286);
    expect(requestBudget(CHECK_MAX_BODY)).toBe(314_572);
  });

  it("splits by count and by size, in order", () => {
    const items = [10, 10, 10, 10, 10, 10, 10];
    expect(bySize(items, (n) => n, { maxCount: 3, maxBytes: 1000, baseBytes: 0 }).chunks.map((c) => c.length)).toEqual([3, 3, 1]);
    // 20 for the envelope, 11 an item with its comma: four fit under 64.
    expect(bySize(items, (n) => n, { maxCount: 50, maxBytes: 64, baseBytes: 20 }).chunks.map((c) => c.length)).toEqual([4, 3]);
    expect(bySize([], (n: number) => n, { maxCount: 3, maxBytes: 10, baseBytes: 0 })).toEqual({ chunks: [], tooLarge: [] });
  });

  it("an item too large for a request of its own is set aside, and the rest still go", () => {
    const r = bySize(["a", "huge", "b", "c"], (s) => (s === "huge" ? 500 : 10), { maxCount: 2, maxBytes: 100, baseBytes: 20 });
    expect(r).toEqual({ chunks: [["a", "b"], ["c"]], tooLarge: ["huge"] });
  });

  it("50 rows of the longest CJK text a contact can hold never go in one save request", () => {
    const wide = (n: number) => "注".repeat(n);
    const contact = cleanContact({
      name: wide(MAX_FIELD),
      org: wide(MAX_FIELD),
      title: wide(MAX_FIELD),
      email: `${wide(MAX_FIELD - 5)}@x.tw`,
      phone: wide(MAX_FIELD),
      linkedin: wide(MAX_FIELD),
      country: wide(MAX_FIELD),
      notes: wide(MAX_NOTES),
      connectedOn: "2021-03-12",
    });
    const rows = Array.from({ length: 50 }, (_, rowNumber) => ({ rowNumber, contact }));
    expect(jsonBytes(rows)).toBeGreaterThan(SAVE_MAX_BODY);
    const { chunks, tooLarge } = bySize(rows, jsonBytes, { maxCount: 50, maxBytes: requestBudget(SAVE_MAX_BODY), baseBytes: 400 });
    expect(tooLarge).toEqual([]);
    expect(chunks.flat()).toEqual(rows);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(400 + jsonBytes(chunk)).toBeLessThanOrEqual(requestBudget(SAVE_MAX_BODY));
  });
});
