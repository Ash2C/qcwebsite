import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchContacts = vi.fn();
const recentContacts = vi.fn();
vi.mock("@/lib/monsoon/contacts", () => ({
  searchContacts: (...a: unknown[]) => searchContacts(...a),
  recentContacts: (...a: unknown[]) => recentContacts(...a),
}));

const listMembers = vi.fn();
vi.mock("@/lib/monsoon/sift", async (original) => ({
  ...(await original<typeof import("@/lib/monsoon/sift")>()),
  listMembers: (...a: unknown[]) => listMembers(...a),
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
// What the route answers for HITS: none of them is on the pipeline, so each row's work is blank.
const SENT = { contacts: [{ kind: "person", name: "Mia Chen", work: null }], total: 1 };

function get(query: string): Request {
  return new Request(`http://localhost/api/monsoon/contacts${query}`);
}

beforeEach(() => {
  account = fakeAccount({ pipelines: PIPELINES, db: fakeDb });
  withDb = vi.spyOn(account, "withDb");
  signInAs(account);
  searchContacts.mockReset().mockResolvedValue(HITS);
  recentContacts.mockReset().mockResolvedValue(HITS);
  listMembers.mockReset();
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
    expect(await res.json()).toEqual(SENT);
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
      expect(await res.json()).toEqual(SENT);
    }
    expect(recentContacts).toHaveBeenCalledTimes(3);
    expect(searchContacts).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("lists the pipeline filtered and sorted when high or a sort is asked, with the phone's date", async () => {
    const LIST = { contacts: [{ kind: "company", name: "Raffles", work: { priority: "high" } }], total: 7 };
    listMembers.mockResolvedValue(LIST);
    const today = new Date().toISOString().slice(0, 10);
    const res = await GET(get(`?estate=traxo&high=1&sort=next&today=${today}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIST);
    expect(listMembers).toHaveBeenCalledWith(fakeDb, { high: true, sort: "next", today });
    expect(recentContacts).not.toHaveBeenCalled();

    await GET(get("?estate=traxo&sort=stage"));
    expect(listMembers).toHaveBeenLastCalledWith(fakeDb, { high: false, sort: "stage", today });
    // An unknown sort is the default one.
    await GET(get("?estate=traxo&sort=drop%20table"));
    expect(recentContacts).toHaveBeenCalledTimes(1);
  });

  it("a search keeps only high-priority hits when asked, and sorts them when a sort is given", async () => {
    const hit = (name: string, priority: string | null, lastAt: string | null) => ({ kind: "person", name, personId: name, orgId: null, member: null, work: { priority, lastAt } });
    const sift = await import("@/lib/monsoon/sift");
    const spy = vi.spyOn(sift, "withWork");
    spy.mockResolvedValue([hit("Ann", "high", "2026-01-01"), hit("Bob", null, "2026-03-01"), hit("Cy", "high", "2026-02-01")] as never);
    const high = await (await GET(get("?estate=traxo&q=mia&high=1"))).json();
    expect(high.contacts.map((c: { name: string }) => c.name)).toEqual(["Ann", "Cy"]);
    expect(high.total).toBe(2);
    const sorted = await (await GET(get("?estate=traxo&q=mia&sort=last"))).json();
    expect(sorted.contacts.map((c: { name: string }) => c.name)).toEqual(["Bob", "Cy", "Ann"]);
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
