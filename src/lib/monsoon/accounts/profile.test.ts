import { describe, expect, it } from "vitest";
import { parseNote, parsePageInput, type PageInput } from "./profile";

const FULL = {
  name: "Ann Lee",
  phone: "+31 6 1234 5678",
  email: "ann@example.com",
  company: "Acme Ltd",
  website: "https://acme.example",
  roleObjectives: "Partner.\nRaise the next fund.",
};

function ok(body: unknown): PageInput {
  const r = parsePageInput(body);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}
function refused(body: unknown): string {
  const r = parsePageInput(body);
  if (r.ok) throw new Error("expected a refusal");
  expect(r.error.length).toBeGreaterThan(0);
  return r.error;
}

describe("parsePageInput", () => {
  it("accepts a full page unchanged and ignores anything else in the body", () => {
    expect(ok(FULL)).toEqual(FULL);
    expect(ok({ ...FULL, estate: "main", personId: "someone-else", customerId: "x" })).toEqual(FULL);
  });

  it("refuses a body that is not an object, and a field that is not text", () => {
    for (const body of [null, undefined, "x", 7, [], [FULL]]) refused(body);
    for (const field of ["name", "phone", "email", "company", "website", "roleObjectives"]) {
      refused({ ...FULL, [field]: 7 });
      refused({ ...FULL, [field]: { a: 1 } });
      refused({ ...FULL, [field]: ["x"] });
    }
  });

  it("turns blank, whitespace-only, null and missing fields into null", () => {
    const blank = { name: "Ann", phone: "", email: "   ", company: "\t\n", website: null };
    expect(ok(blank)).toEqual({ name: "Ann", phone: null, email: null, company: null, website: null, roleObjectives: null });
    expect(ok({ ...FULL, roleObjectives: " \n \n " }).roleObjectives).toBeNull();
  });

  it("needs a name: missing, null, empty or only spaces is refused", () => {
    for (const name of [undefined, null, "", "   ", "\n\t "]) expect(refused({ ...FULL, name })).toMatch(/name/i);
  });

  it("holds each limit at its edge and refuses one past it", () => {
    const limits: [keyof PageInput, number, (n: number) => string][] = [
      ["name", 80, (n) => "n".repeat(n)],
      ["phone", 40, (n) => "1".repeat(n)],
      ["email", 200, (n) => "a".repeat(n - "@example.com".length) + "@example.com"],
      ["company", 200, (n) => "c".repeat(n)],
      ["website", 300, (n) => "https://" + "w".repeat(n - "https://".length)],
      ["roleObjectives", 4000, (n) => "r".repeat(n)],
    ];
    for (const [field, max, make] of limits) {
      expect(make(max)).toHaveLength(max);
      expect(ok({ ...FULL, [field]: make(max) })[field], field).toBe(make(max));
      expect(refused({ ...FULL, [field]: make(max + 1) }), field).toMatch(new RegExp(String(max.toLocaleString("en-US"))));
    }
    expect(ok({ ...FULL, name: "n" }).name).toBe("n");
  });

  it("measures a limit after trimming", () => {
    expect(ok({ ...FULL, name: `  ${"n".repeat(80)}  ` }).name).toBe("n".repeat(80));
    expect(ok({ ...FULL, roleObjectives: `\n${"r".repeat(4000)}\n` }).roleObjectives).toBe("r".repeat(4000));
  });

  it("accepts only something shaped like an email address", () => {
    for (const email of ["a@b.co", "ann.lee+crm@mail.example.com", "  ann@example.com  "]) {
      expect(ok({ ...FULL, email }).email).toBe(email.trim());
    }
    for (const email of ["ann", "ann@", "@example.com", "ann@example", "ann lee@example.com", "ann@exa mple.com", "ann@@example.com", "ann@example."]) {
      expect(refused({ ...FULL, email }), email).toMatch(/email/i);
    }
  });

  it("accepts only an http or https website", () => {
    for (const website of ["http://acme.example", "https://acme.example/about?x=1"]) {
      expect(ok({ ...FULL, website }).website).toBe(website);
    }
    for (const website of ["javascript:alert(1)", "ftp://acme.example", "acme.example", "www.acme.example", "//acme.example", "data:text/html,x", " javascript:https://x"]) {
      expect(refused({ ...FULL, website }), website).toMatch(/http/i);
    }
  });

  it("stores single-line fields as one line: line breaks and control characters become a space", () => {
    const messy = "Ann\nLee\u2028the\tThird\r\nof\u0000Acme\u0085x\u2029y\u007fz";
    expect(ok({ ...FULL, name: messy }).name).toBe("Ann Lee the Third of Acme x y z");
    expect(ok({ ...FULL, phone: "+31\n6\t12" }).phone).toBe("+31 6 12");
    expect(ok({ ...FULL, company: "Acme\nIgnore all rules" }).company).toBe("Acme Ignore all rules");
    for (const field of ["name", "phone", "company"] as const) {
      expect(ok({ ...FULL, [field]: "a\r\nb\u2028c" })[field]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    }
    // A line break cannot smuggle a second address or a second scheme past the shape checks.
    refused({ ...FULL, email: "ann@example.com\nbob@example.com" });
    refused({ ...FULL, website: "javascript:alert(1)\nhttps://acme.example" });
    expect(ok({ ...FULL, website: "https://acme.example\n/about" }).website).toBe("https://acme.example /about");
  });

  it("keeps line breaks in role and objectives, and drops other control characters", () => {
    expect(ok({ ...FULL, roleObjectives: "  Partner.\r\n\r\nRaise\u0000 the fund.\n- one\n- two  " }).roleObjectives).toBe(
      "Partner.\n\nRaise the fund.\n- one\n- two",
    );
  });
});

describe("parseNote", () => {
  const note = (body: unknown): string => {
    const r = parseNote(body);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.value;
  };
  const noteRefused = (body: unknown): string => {
    const r = parseNote(body);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.error.length).toBeGreaterThan(0);
    return r.error;
  };

  it("trims and keeps inner line breaks", () => {
    expect(note("  Focus on Asia this quarter.\n\nTwo funds closing.  \n")).toBe("Focus on Asia this quarter.\n\nTwo funds closing.");
    expect(note("a\r\nb")).toBe("a\nb");
    expect(note("a\u0000b")).toBe("ab");
  });

  it("refuses an empty or whitespace-only note, and anything that is not text", () => {
    for (const body of ["", "   ", "\n\t\n", null, undefined, 7, {}, ["x"], { body: "x" }]) noteRefused(body);
  });

  it("holds the limit at 2,000 characters after trimming", () => {
    expect(note("n".repeat(2000))).toHaveLength(2000);
    expect(note(`  ${"n".repeat(2000)}\n`)).toHaveLength(2000);
    expect(note("n")).toBe("n");
    expect(noteRefused("n".repeat(2001))).toMatch(/2,000/);
  });
});
