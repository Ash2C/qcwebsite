import { describe, expect, it } from "vitest";
import { mergeRefine } from "./merge";

const F = { name: "Jane", title: "Partner", org: "Acme", email: "", phone: "", linkedin: "" };

describe("mergeRefine", () => {
  it("writes only fields that differ from what was sent", () => {
    const current = { fields: { ...F, name: "Janet" }, notes: "typed later" };
    const sent = { fields: F, notes: "old" };
    const out = mergeRefine(current, sent, { fields: { ...F, title: "CIO" }, notes: "tidy" });
    expect(out.fields).toEqual({ ...F, name: "Janet", title: "CIO" });
    expect(out.notes).toBe("tidy");
  });

  it("keeps current notes when the model returned the sent notes", () => {
    const out = mergeRefine(
      { fields: F, notes: "edited" },
      { fields: F, notes: "old" },
      { fields: F, notes: "old" },
    );
    expect(out.notes).toBe("edited");
  });
});
