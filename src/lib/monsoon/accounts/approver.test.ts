import { describe, expect, it } from "vitest";
import { OWNER_CODE, canApprove } from "./approver";

describe("canApprove", () => {
  it("is true only for the key person of the customer quantcloud", () => {
    expect(OWNER_CODE).toBe("quantcloud");
    expect(canApprove({ customer: { code: "quantcloud" }, canChangeKey: true })).toBe(true);
    expect(canApprove({ customer: { code: "quantcloud" }, canChangeKey: false })).toBe(false);
    expect(canApprove({ customer: { code: "acme-co" }, canChangeKey: true })).toBe(false);
    expect(canApprove({ customer: { code: "Quantcloud" }, canChangeKey: true })).toBe(false);
    expect(canApprove({ customer: { code: "quantcloud" }, canChangeKey: "yes" as unknown as boolean })).toBe(false);
  });
});
