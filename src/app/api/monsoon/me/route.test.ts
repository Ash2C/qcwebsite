import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = { loadUserPage: vi.fn(), saveUserPage: vi.fn(), addUserNote: vi.fn() };
// The parsers are the real ones: the route must pass their messages through untouched.
vi.mock("@/lib/monsoon/accounts/profile", async (original) => ({
  ...(await original<typeof import("@/lib/monsoon/accounts/profile")>()),
  loadUserPage: (...a: unknown[]) => lib.loadUserPage(...a),
  saveUserPage: (...a: unknown[]) => lib.saveUserPage(...a),
  addUserNote: (...a: unknown[]) => lib.addUserNote(...a),
}));
const google = { googleConfigured: vi.fn(), googleLinked: vi.fn() };
vi.mock("@/lib/monsoon/google", () => ({ googleConfigured: () => google.googleConfigured() }));
vi.mock("@/lib/monsoon/accounts/signups", () => ({ googleLinked: (...a: unknown[]) => google.googleLinked(...a) }));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { GET, PUT } from "./route";

const CUSTOMER = "00000000-0000-4000-8000-000000000001";
const PERSON = "00000000-0000-4000-8000-000000000002";
const WHO = { customerId: CUSTOMER, personId: PERSON };
const OTHER = "99999999-9999-4999-8999-999999999999";
const PAGE = {
  person: { name: "Vincent", phone: null, email: null },
  work: { company: "Acme", website: null, roleObjectives: null },
  notes: [{ id: "n1", body: "A note", at: "2026-11-23T10:00:00.000Z" }],
  notesTotal: 1,
};
const INPUT = {
  name: "Vincent",
  phone: null,
  email: "v@example.com",
  company: "Acme",
  website: "https://acme.example",
  roleObjectives: "Raise the fund",
};

const get = (query = "?estate=main") => new Request(`http://localhost/api/monsoon/me${query}`);
const put = (body: unknown) =>
  new Request("http://localhost/api/monsoon/me", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of Object.values(lib)) f.mockReset();
  for (const f of Object.values(google)) f.mockReset();
  google.googleConfigured.mockReturnValue(false);
  google.googleLinked.mockResolvedValue(false);
  lib.loadUserPage.mockResolvedValue(PAGE);
  lib.saveUserPage.mockResolvedValue(PAGE);
  signInAs(fakeAccount());
});

describe("GET /api/monsoon/me", () => {
  it("answers 401 when signed out, and reads nothing", async () => {
    signOut();
    expect((await GET(get())).status).toBe(401);
    expect(lib.loadUserPage).not.toHaveBeenCalled();
  });

  it("returns the signed-in person's page for the estate, uncached", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ page: PAGE, googleConfigured: false, googleLinked: false, canApprove: false });
    expect(lib.loadUserPage).toHaveBeenCalledTimes(1);
    expect(lib.loadUserPage).toHaveBeenCalledWith(WHO, "main");
  });

  it("takes the person and customer from the session, whatever the query says", async () => {
    await GET(get(`?estate=main&personId=${OTHER}&customerId=${OTHER}&person=${OTHER}`));
    expect(lib.loadUserPage).toHaveBeenCalledWith(WHO, "main");
    expect(JSON.stringify(lib.loadUserPage.mock.calls)).not.toContain(OTHER);
  });

  it("answers 400 for an estate that is not this customer's", async () => {
    lib.loadUserPage.mockResolvedValue(null);
    const res = await GET(get("?estate=someone-elses"));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Unknown estate" });
  });

  it("answers 400 without reading when no estate is named", async () => {
    for (const query of ["", "?estate=", `?estate=${"k".repeat(201)}`]) {
      const res = await GET(get(query));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unknown estate" });
    }
    expect(lib.loadUserPage).not.toHaveBeenCalled();
  });

  it("answers 502 and logs no message text when the lookup fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    lib.loadUserPage.mockRejectedValue(Object.assign(new Error("postgres://u:pw@h jo@example.com"), { code: "57014" }));
    const res = await GET(get());
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Could not reach the accounts database" });
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("pw@h");
    expect(logged).not.toContain("jo@example.com");
    expect(logged).toContain("57014");
  });

  describe("Google and the Requests screen", () => {
    it("with Sign in with Google off, says so and never looks the link up", async () => {
      const body = await (await GET(get())).json();
      expect(body).toMatchObject({ googleConfigured: false, googleLinked: false });
      expect(google.googleLinked).not.toHaveBeenCalled();
    });

    it("says whether the signed-in person has linked Google, and never the Google id", async () => {
      google.googleConfigured.mockReturnValue(true);
      const first = await (await GET(get())).json();
      expect(first).toMatchObject({ googleConfigured: true, googleLinked: false });
      expect(google.googleLinked).toHaveBeenCalledWith(WHO);
      google.googleLinked.mockResolvedValue(true);
      const res = await GET(get(`?estate=main&personId=${OTHER}`));
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ googleConfigured: true, googleLinked: true });
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(["canApprove", "googleConfigured", "googleLinked", "page"]);
      expect(JSON.stringify(google.googleLinked.mock.calls)).not.toContain(OTHER);
    });

    it("a link lookup that fails leaves the page readable and says not linked", async () => {
      google.googleConfigured.mockReturnValue(true);
      google.googleLinked.mockRejectedValue(new Error("postgres://u:pw@h"));
      const res = await GET(get());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ page: PAGE, googleConfigured: true, googleLinked: false, canApprove: false });
    });

    it("canApprove is true only for the key person of quantcloud", async () => {
      const ask = async (account: ReturnType<typeof fakeAccount>) => {
        signInAs(account);
        return (await (await GET(get())).json()).canApprove;
      };
      expect(await ask(fakeAccount({ customer: { code: "quantcloud" }, canChangeKey: true }))).toBe(true);
      expect(await ask(fakeAccount({ customer: { code: "quantcloud" }, canChangeKey: false }))).toBe(false);
      expect(await ask(fakeAccount({ customer: { code: "acme-co" }, canChangeKey: true }))).toBe(false);
    });

    it("an estate that is not this customer's is still a 400, with nothing about Google", async () => {
      google.googleConfigured.mockReturnValue(true);
      lib.loadUserPage.mockResolvedValue(null);
      const res = await GET(get("?estate=someone-elses"));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unknown estate" });
    });
  });
});

describe("PUT /api/monsoon/me", () => {
  it("answers 401 when signed out, and saves nothing", async () => {
    signOut();
    expect((await PUT(put({ estate: "main", ...INPUT }))).status).toBe(401);
    expect(lib.saveUserPage).not.toHaveBeenCalled();
  });

  it("saves the tidied fields for the signed-in person and returns the page, uncached", async () => {
    const res = await PUT(put({ estate: "main", ...INPUT, name: "  Vincent  ", phone: "   " }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ page: PAGE });
    expect(lib.saveUserPage).toHaveBeenCalledTimes(1);
    expect(lib.saveUserPage).toHaveBeenCalledWith(WHO, "main", INPUT);
  });

  it("takes the person and customer from the session, whatever ids the body carries", async () => {
    await PUT(put({ estate: "main", ...INPUT, personId: OTHER, customerId: OTHER, id: OTHER, person: { id: OTHER } }));
    expect(lib.saveUserPage).toHaveBeenCalledWith(WHO, "main", INPUT);
    expect(JSON.stringify(lib.saveUserPage.mock.calls)).not.toContain(OTHER);
  });

  it("answers 400 for an estate that is not this customer's", async () => {
    lib.saveUserPage.mockResolvedValue(null);
    const res = await PUT(put({ estate: "someone-elses", ...INPUT }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown estate" });
  });

  it("answers 400 without saving when the estate is missing or not text", async () => {
    for (const estate of [undefined, "", 7, null, ["main"], "k".repeat(201)]) {
      const res = await PUT(put({ ...INPUT, estate }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unknown estate" });
    }
    expect(lib.saveUserPage).not.toHaveBeenCalled();
  });

  it("answers 400 with the parser's own message for each invalid field, and saves nothing", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "   " }, "Enter your name"],
      [{ name: "n".repeat(81) }, "Name is too long (80 characters at most)"],
      [{ phone: "1".repeat(41) }, "Phone is too long (40 characters at most)"],
      [{ email: "not-an-address" }, "Enter a valid email address"],
      [{ company: "c".repeat(201) }, "Company is too long (200 characters at most)"],
      [{ website: "javascript:alert(1)" }, "The website must start with http:// or https://"],
      [{ roleObjectives: "r".repeat(4001) }, "Role and objectives is too long (4,000 characters at most)"],
      [{ phone: 12345 }, "Phone must be text"],
    ];
    for (const [over, error] of cases) {
      const res = await PUT(put({ estate: "main", ...INPUT, ...over }));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error });
    }
    expect(lib.saveUserPage).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not a JSON object", async () => {
    for (const body of ["{not json", "[]", '"text"', "null"]) {
      const res = await PUT(put(body));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(lib.saveUserPage).not.toHaveBeenCalled();
  });

  it("refuses a body over 16,000 bytes without saving", async () => {
    const res = await PUT(put({ estate: "main", ...INPUT, roleObjectives: "r".repeat(16_001) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
    expect(lib.saveUserPage).not.toHaveBeenCalled();
  });

  it("answers 502 and logs no message text when the save fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    lib.saveUserPage.mockRejectedValue(new Error("duplicate key: Vincent v@example.com"));
    const res = await PUT(put({ estate: "main", ...INPUT }));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Could not reach the accounts database" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("v@example.com");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("duplicate");
  });
});

describe("route config", () => {
  it("runs on node, uncached, capped at 30 seconds", async () => {
    const mod = await import("./route");
    expect(mod.runtime).toBe("nodejs");
    expect(mod.dynamic).toBe("force-dynamic");
    expect(mod.maxDuration).toBe(30);
  });
});
