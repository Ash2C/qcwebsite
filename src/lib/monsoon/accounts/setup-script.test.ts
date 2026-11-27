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
    expect(sha(generateSetupScript(vocabulary))).toMatchInlineSnapshot(`"489bcda929217822f8c76d75b781a02b8cb8eaed7a9537eaa6cc1924b4ea4d5e"`);
  });

  it("generateSetupScript with a named login and a password (the host command)", () => {
    expect(sha(generateSetupScript({ ...vocabulary, roleName: "monsoon_app", password: PASSWORD }))).toMatchInlineSnapshot(`"bc481b7ac753a517513c369ca9aaba8042d579716f2d653822176a1f16fdf57b"`);
    expect(sha(generateSetupScript({ ...vocabulary, roleName: "monsoon_app_w3", password: PASSWORD }))).toMatchInlineSnapshot(`"3bb522705e9c0a261c5ff66eba05d2b1c0f75a5762a653ae18e18b6f8f32b65d"`);
  });

  it("generateSetupScript with an empty vocabulary", () => {
    expect(sha(generateSetupScript({ stages: [], roles: [], owners: [] }))).toMatchInlineSnapshot(`"f26c7fda1c71968fa9c219bdff20ec421d33f38fb6ad4d686e0de60e8275f284"`);
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
