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
    expect(sha(generateSetupScript(vocabulary))).toMatchInlineSnapshot(`"99f5cacebf679fbdc480d4e23901f0b963c81a8a8c95e918b665c3dec454039c"`);
  });

  it("generateSetupScript with a named login and a password (the host command)", () => {
    expect(sha(generateSetupScript({ ...vocabulary, roleName: "monsoon_app", password: PASSWORD }))).toMatchInlineSnapshot(`"68c0615b284bb794b59d933fda5f8e6dbe35ce86011620814fa7387d2b8064ad"`);
    expect(sha(generateSetupScript({ ...vocabulary, roleName: "monsoon_app_w3", password: PASSWORD }))).toMatchInlineSnapshot(`"a8bd1a1ab27ff344107423e864c475bcba8f8c294ad6ea80cdc79774944dec5d"`);
  });

  it("generateSetupScript with an empty vocabulary", () => {
    expect(sha(generateSetupScript({ stages: [], roles: [], owners: [] }))).toMatchInlineSnapshot(`"a770c7937ed81f4a40da1f80b73b4b2f7cf2c2b97aa46420a68792621a448d90"`);
  });

  it("naming the schema public is the same as not naming one", () => {
    expect(generateSetupScript({ ...vocabulary, schema: "public" })).toBe(generateSetupScript(vocabulary));
    expect(loginAndPoliciesScript("monsoon_app", "public")).toBe(loginAndPoliciesScript());
  });

  it("loginAndPoliciesScript", () => {
    expect(sha(loginAndPoliciesScript())).toMatchInlineSnapshot(`"5e9b627108e141524f9b95c715344627ffdbf619bf6632e6354bb0a15e4c91a8"`);
    expect(sha(loginAndPoliciesScript("monsoon_app_w3"))).toMatchInlineSnapshot(`"2da055b5f245661c1dec66c76a966cdb9af5e50fcf0dc96947a29ec98aab0ffd"`);
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
