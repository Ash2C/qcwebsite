// Pins the script existing customers were given (schema public, login monsoon_app): the SHA-256 of
// each output was taken before the schema parameter was added and must never change.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSetupScript, loginAndPoliciesScript, setupStatements } from "./setup-script";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const vocabulary = {
  stages: [
    { key: "uncontacted", ord: 0, label: "Uncontacted", terminal: false },
    { key: "contacted", ord: 1, label: "Contacted", terminal: false },
    { key: "client", ord: 2, label: "Client", terminal: true },
  ],
  roles: [
    { key: "investor", label: "Investor" },
    { key: "desk", label: "O'Brien Desk" },
  ],
  owners: [{ key: "VF", name: "Pat O'Brien" }],
};
const PASSWORD = "fixed-test-password-0123456789";

describe("the setup script for existing callers does not change by a byte", () => {
  it("generateSetupScript with the default login", () => {
    expect(sha(generateSetupScript(vocabulary))).toMatchInlineSnapshot(`"0a95d4b088383ab8b9ce35e128f1f890a44d113b9505927c5734621b62b207f0"`);
  });

  it("generateSetupScript with a named login and a password (the host command)", () => {
    expect(sha(generateSetupScript({ ...vocabulary, roleName: "monsoon_app", password: PASSWORD }))).toMatchInlineSnapshot(`"e2f9f726e41f3a3261c44f4c822b0b45834ef607cf5f885c7312ddf2364507a8"`);
    expect(sha(generateSetupScript({ ...vocabulary, roleName: "monsoon_app_w3", password: PASSWORD }))).toMatchInlineSnapshot(`"589f617e20f448ffd34e14b818ba747424ec7ae166c4c3f05c1adf4ab2600f17"`);
  });

  it("generateSetupScript with an empty vocabulary", () => {
    expect(sha(generateSetupScript({ stages: [], roles: [], owners: [] }))).toMatchInlineSnapshot(`"1bfc0dd779cae28647f85148433e9724f28ede09e20483d77487c5fa95dac5ad"`);
  });

  it("naming the schema public is the same as not naming one", () => {
    expect(generateSetupScript({ ...vocabulary, schema: "public" })).toBe(generateSetupScript(vocabulary));
    expect(loginAndPoliciesScript("monsoon_app", "public")).toBe(loginAndPoliciesScript());
  });

  it("loginAndPoliciesScript", () => {
    expect(sha(loginAndPoliciesScript())).toMatchInlineSnapshot(`"40cf293ee23e2474ded85c36c916acef552ed227dabc04853ea647c01b7e2d22"`);
    expect(sha(loginAndPoliciesScript("monsoon_app_w3"))).toMatchInlineSnapshot(`"b0a147edd1dbe46d73de50b4f7eba2ca9ae2853bbd4e0e8999f1818551666562"`);
  });
});

describe("the setup script for a named schema (the shared database)", () => {
  const SCHEMA = "c_0b9d2a476a3e4c1f9d552f7a3c1e8b10";
  const ROLE = "monsoon_c_0b9d2a476a3e4c1f9d552f7a3c1e8b10";

  it("grants the login USAGE on its own schema and never on public", () => {
    const script = generateSetupScript({ ...vocabulary, roleName: ROLE, password: PASSWORD, schema: SCHEMA });
    expect(script).toContain(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${ROLE};`);
    expect(script).not.toMatch(/SCHEMA public/i);
    expect(script).not.toContain("monsoon_app");
  });

  it("setupStatements is the script without its BEGIN and COMMIT", () => {
    const v = { ...vocabulary, roleName: ROLE, password: PASSWORD, schema: SCHEMA };
    expect(`BEGIN;\n\n${setupStatements(v)}\n\nCOMMIT;\n`).toBe(generateSetupScript(v));
    expect(setupStatements(v)).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
  });

  it("refuses a schema name that is not a plain lower-case identifier", () => {
    for (const schema of ["", "Public", "c-1", "c_1; DROP SCHEMA public", 'c"x', "c x", "1c", "a".repeat(64), "pg_catalog", "information_schema"]) {
      expect(() => generateSetupScript({ ...vocabulary, schema }), schema).toThrow("invalid schema name");
      expect(() => loginAndPoliciesScript("monsoon_app", schema), schema).toThrow("invalid schema name");
    }
  });
});
