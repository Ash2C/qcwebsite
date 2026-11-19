import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { makeTestDb } from "./testing/db";
import { ensureOwner } from "./owners";

const db = makeTestDb("owners");

describe.skipIf(!db.available)("ensureOwner", () => {
  let client: Client;
  beforeAll(async () => {
    await db.reset();
    client = await db.connect();
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    await client.query("DELETE FROM owners WHERE key <> 'VF'");
  });

  it("inserts once when called twice", async () => {
    await ensureOwner(client, "AN", "Ann");
    await ensureOwner(client, "AN", "Ann");
    const r = await client.query("SELECT key, display_name FROM owners WHERE key = 'AN'");
    expect(r.rows).toEqual([{ key: "AN", display_name: "Ann" }]);
  });

  it("leaves an existing display name unchanged", async () => {
    await ensureOwner(client, "VF", "Someone Else");
    const r = await client.query("SELECT display_name FROM owners WHERE key = 'VF'");
    expect(r.rows).toEqual([{ display_name: "Vincent" }]);
  });
});
