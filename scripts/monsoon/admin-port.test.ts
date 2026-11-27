import { describe, expect, it } from "vitest";
import { ownerPort } from "./admin-commands";

describe("ownerPort", () => {
  it("defaults to the session pooler port", () => {
    expect(ownerPort({})).toBe("5432");
  });
  it("accepts the transaction pooler port", () => {
    expect(ownerPort({ MONSOON_OWNER_PORT: "6543" })).toBe("6543");
  });
  it("refuses any other port", () => {
    expect(ownerPort({ MONSOON_OWNER_PORT: "5433" })).toBeNull();
    expect(ownerPort({ MONSOON_OWNER_PORT: "" })).toBeNull();
  });
});
