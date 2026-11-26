import { describe, expect, it } from "vitest";
import { contactKeys, judge, type Candidate } from "./classify";
import type { ImportContact } from "./mapping";
import { fileRepeats } from "./repeats";

/** What the check and the save decide, a row at a time against the rows before it. */
function byTheServerRule(contacts: (ImportContact | null)[]): boolean[] {
  const earlier: Candidate[] = [];
  return contacts.map((contact, i) => {
    if (contact === null) return false;
    const keys = contactKeys(contact);
    if (keys.nameKey === "") return false;
    const verdict = judge(keys, earlier);
    earlier.push({ ...keys, id: String(i) });
    return verdict.class === "existing";
  });
}

describe("fileRepeats", () => {
  it("a row repeats an earlier one with the same name and email, or the same name at the same company", () => {
    const rows: (ImportContact | null)[] = [
      { name: "Jane Tan", org: "Acme Capital", email: "jane@acme.com" },
      { name: "jane  tan", org: "ACME capital" }, // same name, same company
      { name: "Jane Tan", org: "Other", email: " JANE@acme.com " }, // same name, same email
      { name: "Jane Tan", org: "Third" }, // same name elsewhere: not a repeat
      { name: "Bob Lee", email: "jane@acme.com" }, // the email under another name: not a repeat
      null,
      { name: "Omar Haddad" },
      { name: "Omar Haddad" }, // no company on either side
      { name: "Omar Haddad", org: "Acme Capital" },
    ];
    expect(fileRepeats(rows)).toEqual([false, true, true, false, false, false, false, true, false]);
  });

  it("an email first seen under another name makes the row a possible match, not a repeat, as the server has it", () => {
    const rows: ImportContact[] = [
      { name: "Jane Tan", org: "Acme" },
      { name: "Bob Lee", org: "Zed", email: "shared@x.com" },
      { name: "Jane Tan", org: "Acme", email: "shared@x.com" },
    ];
    expect(fileRepeats(rows)).toEqual([false, false, false]);
    expect(fileRepeats(rows)).toEqual(byTheServerRule(rows));
  });

  it("agrees with the server's rule on a mixed file, and finds repeats any distance apart", () => {
    const names = ["Ann Lim", "ann lim", "Ben Ong", "Cy Wu", " "];
    const orgs = [undefined, "Acme", "acme", "Zed"];
    const emails = [undefined, "a@x.com", "A@x.com", "b@x.com"];
    const rows: (ImportContact | null)[] = [];
    for (let i = 0; i < 600; i++) {
      if (i % 37 === 36) rows.push(null);
      else rows.push({ name: names[(i * 7) % 5], org: orgs[(i * 3) % 4], email: emails[(i * 5 + (i >> 3)) % 4] });
    }
    rows.push({ name: "Far Apart", org: "Solo" });
    for (let i = 0; i < 450; i++) rows.push({ name: `Filler ${i}` });
    rows.push({ name: "far apart", org: "SOLO" });
    const got = fileRepeats(rows);
    expect(got).toEqual(byTheServerRule(rows));
    expect(got[got.length - 1]).toBe(true);
    expect(got.filter(Boolean).length).toBeGreaterThan(100);
  });
});
