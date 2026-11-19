import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchContacts = vi.fn();
const recentContacts = vi.fn();
vi.mock("@/lib/monsoon/contacts", () => ({
  searchContacts: (...a: unknown[]) => searchContacts(...a),
  recentContacts: (...a: unknown[]) => recentContacts(...a),
}));

vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import type { Account } from "@/lib/monsoon/accounts/account";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { GET } from "./route";

const fakeDb = { fake: true };
const PIPELINES = [
  { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", connected: true },
  { key: "zeroone", label: "Zero One", defaultRole: "investor", connected: true },
];
let account: ReturnType<typeof fakeAccount>;
let withDb: MockInstance<Account["withDb"]>;
const HITS = [{ kind: "person", name: "Mia Chen" }];

function get(query: string): Request {
  return new Request(`http://localhost/api/monsoon/contacts${query}`);
}

beforeEach(() => {
  account = fakeAccount({ pipelines: PIPELINES, db: fakeDb });
  withDb = vi.spyOn(account, "withDb");
  signInAs(account);
  searchContacts.mockReset().mockResolvedValue(HITS);
  recentContacts.mockReset().mockResolvedValue(HITS);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/monsoon/contacts", () => {
  it("answers 401 when requireAccount refuses and calls nothing", async () => {
    signOut();
    const res = await GET(get("?estate=traxo&q=mia"));
    expect(res.status).toBe(401);
    expect(withDb).not.toHaveBeenCalled();
    expect(searchContacts).not.toHaveBeenCalled();
    expect(recentContacts).not.toHaveBeenCalled();
  });

  it("answers 400 for an estate that is not one of the account's pipelines", async () => {
    signInAs(fakeAccount({ pipelines: [PIPELINES[0]], db: fakeDb }));
    const res = await GET(get("?estate=zeroone&q=mia"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown estate" });
  });

  it("answers 400 for an unknown or missing estate", async () => {
    for (const q of ["?estate=qforce&q=mia", "?q=mia"]) {
      const res = await GET(get(q));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unknown estate" });
    }
    expect(withDb).not.toHaveBeenCalled();
  });

  it("cuts a q longer than 100 characters to 100", async () => {
    const res = await GET(get(`?estate=traxo&q=${"a".repeat(150)}`));
    expect(res.status).toBe(200);
    expect(searchContacts.mock.calls[0][1]).toBe("a".repeat(100));
  });

  it("searches when q has two or more characters after trimming", async () => {
    const res = await GET(get("?estate=traxo&q=%20%20mia%20"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts: HITS });
    expect(searchContacts).toHaveBeenCalledTimes(1);
    expect(searchContacts.mock.calls[0][0]).toBe(fakeDb);
    expect(searchContacts.mock.calls[0][1]).toBe("mia");
    expect(recentContacts).not.toHaveBeenCalled();
    expect(withDb.mock.calls[0][0]).toBe("traxo");
  });

  it("lists recent contacts when q is absent, empty or a single character", async () => {
    for (const q of ["?estate=zeroone", "?estate=zeroone&q=", "?estate=zeroone&q=%20m%20"]) {
      const res = await GET(get(q));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ contacts: HITS });
    }
    expect(recentContacts).toHaveBeenCalledTimes(3);
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it("answers 502 without leaking details when the lookup throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    searchContacts.mockRejectedValue(
      Object.assign(new Error("boom postgresql://user:hunter2@db.internal.example/x Mia Chen"), { code: "57014" }),
    );
    const res = await GET(get("?estate=traxo&q=mia"));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not reach the Traxo CRM" });
    expect(text).not.toContain("hunter2");
    expect(log).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.mock.calls);
    for (const leak of ["hunter2", "boom", "Mia Chen", "mia"]) expect(logged).not.toContain(leak);
    expect(logged).toContain("57014");
  });

  it("answers 502 with the label when the pipeline is not connected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signInAs(fakeAccount({ pipelines: [{ ...PIPELINES[0], connected: false }], db: fakeDb }));
    const res = await GET(get("?estate=traxo&q=mia"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not reach the Traxo CRM" });
  });
});
