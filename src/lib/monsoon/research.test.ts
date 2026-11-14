import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLOCKED_DOMAINS,
  NOT_COMPANY_SITES,
  FREE_MAIL,
  anchorsOf,
  hasAnchor,
  runResearch,
  vet,
  type RawResearch,
  type ResearchSubject,
} from "./research";

const SUBJECT: ResearchSubject = {
  name: "Ada Testperson",
  company: "Examplecorp",
  companyWebsite: "https://www.examplecorp.test",
  title: "Analyst",
  email: "ada@examplecorp.test",
  phone: null,
  linkedin: null,
  country: "Taiwan",
};

const RETURNED = [
  "https://www.examplecorp.test/team/ada",
  "https://linkedin.com/in/ada-testperson",
  "https://news.example.test/ada",
  "https://www.zoominfo.com/p/ada",
  "https://sub.zoominfo.com/p/ada",
];

function raw(over: Partial<RawResearch> = {}): RawResearch {
  return {
    identity: "established",
    identity_reason: "  Matches name and company.  ",
    findings: [],
    summary: "",
    summary_sources: [],
    ...over,
  };
}
const f = (field: string, value: string, source_url: string) => ({ field, value, source_url });

describe("vet", () => {
  it("returns sourced findings with from values", () => {
    const r = vet(
      raw({
        findings: [
          f("title", "Senior Analyst", "https://examplecorp.test/team/ada"),
          f("linkedin_url", "https://www.linkedin.com/in/ada-testperson/?x=1#y", "https://linkedin.com/in/ada-testperson"),
          f("company_website", "https://www.examplecorp.test/about", "https://examplecorp.test/team/ada/"),
        ],
        summary: "Ada is an analyst.",
        summary_sources: ["https://news.example.test/ada"],
      }),
      RETURNED,
      { ...SUBJECT, companyWebsite: null }
    );
    expect(r).toEqual({
      outcome: "findings",
      identity: "Matches name and company.",
      findings: [
        { target: "person", field: "title", from: "Analyst", to: "Senior Analyst", source: "https://www.examplecorp.test/team/ada" },
        { target: "person", field: "linkedin", from: null, to: "https://www.linkedin.com/in/ada-testperson", source: "https://linkedin.com/in/ada-testperson" },
        { target: "company", field: "website", from: null, to: "https://www.examplecorp.test", source: "https://www.examplecorp.test/team/ada" },
      ],
      summary: "Ada is an analyst.",
      summarySources: ["https://news.example.test/ada"],
    });
  });

  it("drops a source not returned by search", () => {
    expect(vet(raw({ findings: [f("title", "CEO", "https://invented.test/x")] }), RETURNED, SUBJECT)).toEqual({ outcome: "nothing" });
  });

  it("matches www, trailing slash and fragment differences", () => {
    const r = vet(raw({ findings: [f("title", "Director", "https://EXAMPLECORP.test/team/ada/#bio")] }), RETURNED, SUBJECT);
    expect(r.outcome).toBe("findings");
  });

  it("drops non-https sources", () => {
    expect(vet(raw({ findings: [f("title", "Director", "http://www.examplecorp.test/team/ada")] }), RETURNED, SUBJECT)).toEqual({ outcome: "nothing" });
  });

  it("drops blocked and blocked-subdomain sources even when returned", () => {
    for (const u of ["https://www.zoominfo.com/p/ada", "https://sub.zoominfo.com/p/ada"]) {
      expect(vet(raw({ findings: [f("title", "Director", u)] }), RETURNED, SUBJECT)).toEqual({ outcome: "nothing" });
    }
  });

  it("not_established yields not_identified even with findings", () => {
    const r = vet(raw({ identity: "not_established", findings: [f("title", "Director", "https://news.example.test/ada")] }), RETURNED, SUBJECT);
    expect(r).toEqual({ outcome: "not_identified" });
  });

  it("drops company-page and pub LinkedIn URLs", () => {
    for (const v of ["https://www.linkedin.com/company/examplecorp", "https://www.linkedin.com/pub/ada/1/2/3"]) {
      expect(vet(raw({ findings: [f("linkedin_url", v, "https://news.example.test/ada")] }), RETURNED, SUBJECT)).toEqual({ outcome: "nothing" });
    }
  });

  it("drops a title sentence with parentheses", () => {
    expect(vet(raw({ findings: [f("title", "Analyst (formerly at Other)", "https://news.example.test/ada")] }), RETURNED, SUBJECT)).toEqual({ outcome: "nothing" });
  });

  it("keeps an email from the employer site and drops one from elsewhere", () => {
    const ok = vet(raw({ findings: [f("work_email", "ada.t@examplecorp.test", "https://www.examplecorp.test/team/ada")] }), RETURNED, SUBJECT);
    expect(ok.outcome).toBe("findings");
    const bad = vet(raw({ findings: [f("work_email", "ada.t@examplecorp.test", "https://news.example.test/ada")] }), RETURNED, SUBJECT);
    expect(bad).toEqual({ outcome: "nothing" });
  });

  it("accepts phone from the host of a surviving website finding", () => {
    const r = vet(
      raw({
        findings: [
          f("work_phone", "+886 2 0000 0000", "https://news.example.test/ada"),
          f("company_website", "https://news.example.test", "https://news.example.test/ada"),
        ],
      }),
      RETURNED,
      { ...SUBJECT, companyWebsite: null }
    );
    expect(r.outcome === "findings" && r.findings.map((x) => x.field).sort()).toEqual(["phone", "website"]);
  });

  it("drops unknown fields", () => {
    const r = vet(raw({ findings: [f("home_address", "1 Road", "https://news.example.test/ada"), f("age", "40", "https://news.example.test/ada")] }), RETURNED, SUBJECT);
    expect(r).toEqual({ outcome: "nothing" });
  });

  it("drops a finding equal to the value on file", () => {
    expect(vet(raw({ findings: [f("title", " analyst ", "https://news.example.test/ada")] }), RETURNED, SUBJECT)).toEqual({ outcome: "nothing" });
  });

  it("drops a website that is free mail or when subject has no company", () => {
    expect(vet(raw({ findings: [f("company_website", "https://gmail.com", "https://news.example.test/ada")] }), RETURNED, SUBJECT)).toEqual({ outcome: "nothing" });
    expect(vet(raw({ findings: [f("company_website", "https://other.test", "https://news.example.test/ada")] }), RETURNED, { ...SUBJECT, company: null })).toEqual({ outcome: "nothing" });
  });

  it("drops multi-line and overlong values", () => {
    const r = vet(raw({ findings: [f("country", "Tai\nwan", "https://news.example.test/ada"), f("title", "x".repeat(301), "https://news.example.test/ada")] }), RETURNED, SUBJECT);
    expect(r).toEqual({ outcome: "nothing" });
  });

  it("drops a summary whose only source is blocked", () => {
    expect(vet(raw({ summary: "Text.", summary_sources: ["https://www.zoominfo.com/p/ada"] }), RETURNED, SUBJECT)).toEqual({ outcome: "nothing" });
  });

  it("cuts a long summary at a sentence end and caps sources at 6", () => {
    const sentence = "A".repeat(98) + ". ";
    const r = vet(raw({ summary: sentence.repeat(30), summary_sources: ["https://news.example.test/ada"] }), RETURNED, SUBJECT);
    expect(r.outcome === "findings" && r.summary.length <= 2000 && r.summary.endsWith(".")).toBe(true);
    const many = Array.from({ length: 8 }, (_, i) => `https://s${i}.test/p`);
    const r2 = vet(raw({ summary: "Ok.", summary_sources: many }), many, SUBJECT);
    expect(r2.outcome === "findings" && r2.summarySources.length).toBe(6);
  });

  it("carries the full blocked list", () => {
    expect(BLOCKED_DOMAINS).toContain("hunter.io");
    expect(BLOCKED_DOMAINS).toHaveLength(33);
  });
});

const NEWS = "https://news.example.test/ada";
const NO_SITE = { ...SUBJECT, companyWebsite: null };
const nothing = { outcome: "nothing" };

describe("vet hardening", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])("drops prototype-key field %s", (field) => {
    expect(vet(raw({ findings: [f(field, "x", NEWS)] }), RETURNED, SUBJECT)).toEqual(nothing);
  });

  it("first occurrence of a field wins", () => {
    const r = vet(raw({ findings: [f("title", "First", NEWS), f("title", "Second", NEWS)] }), RETURNED, SUBJECT);
    expect(r.outcome === "findings" && r.findings.map((x) => x.to)).toEqual(["First"]);
  });

  it("keeps a LinkedIn value only when search returned that profile", () => {
    const bad = vet(raw({ findings: [f("linkedin_url", "https://www.linkedin.com/in/invented-slug", NEWS)] }), RETURNED, SUBJECT);
    expect(bad).toEqual(nothing);
    const ok = vet(raw({ findings: [f("linkedin_url", "https://www.linkedin.com/in/ada-testperson/", NEWS)] }), RETURNED, SUBJECT);
    expect(ok.outcome === "findings" && ok.findings[0].to).toBe("https://www.linkedin.com/in/ada-testperson");
  });

  it("compares LinkedIn with the on-file value case-insensitively and scheme-less", () => {
    for (const on of ["linkedin.com/in/Ada-TestPerson", "http://www.linkedin.com/in/ada-testperson/"]) {
      const r = vet(raw({ findings: [f("linkedin_url", "https://www.linkedin.com/in/ada-testperson", NEWS)] }), RETURNED, { ...SUBJECT, linkedin: on });
      expect(r).toEqual(nothing);
    }
  });

  it("counts a scheme-less or http on-file LinkedIn as an anchor", () => {
    const base = { ...SUBJECT, company: null, email: null };
    expect(hasAnchor({ ...base, linkedin: "linkedin.com/in/ada" })).toBe(true);
    expect(hasAnchor({ ...base, linkedin: "http://www.linkedin.com/in/ada" })).toBe(true);
  });

  it("keeps a website only when its source is on the website's own host", () => {
    expect(vet(raw({ findings: [f("company_website", "https://medium.example.test", NEWS)] }), RETURNED, SUBJECT)).toEqual(nothing);
    const ok = vet(raw({ findings: [f("company_website", "https://www.examplecorp.test/x", "https://examplecorp.test/team/ada")] }), RETURNED, NO_SITE);
    expect(ok.outcome).toBe("findings");
  });

  it.each(["https://10.0.0.1", "https://localhost", "https://intranet", "https://examplecorp.test:8443", "https://u:p@examplecorp.test"])(
    "drops non-public or odd website %s",
    (v) => {
      const returned = [...RETURNED, v + "/a"];
      expect(vet(raw({ findings: [f("company_website", v, v + "/a")] }), returned, NO_SITE)).toEqual(nothing);
    }
  );

  it("does not let a spoofed host vouch for email", () => {
    const e = f("work_email", "ada@examplecorp.test", "https://examplecorp.test.evil.example/ada");
    const e2 = f("work_email", "ada@examplecorp.test", "https://notexamplecorp.test/ada");
    const returned = [...RETURNED, "https://examplecorp.test.evil.example/ada", "https://notexamplecorp.test/ada"];
    expect(vet(raw({ findings: [e] }), returned, SUBJECT)).toEqual(nothing);
    expect(vet(raw({ findings: [e2] }), returned, SUBJECT)).toEqual(nothing);
  });

  const SITE = "https://www.examplecorp.test/team/ada";
  it.each([
    ["work_email", "ada@gmail.com"],
    ["work_email", "a@b@examplecorp.test"],
    ["work_email", "ada @examplecorp.test"],
    ["work_email", "ada@localhost"],
    ["work_email", "a".repeat(120) + "@examplecorp.test"],
    ["work_phone", "home: 555 1234567"],
    ["work_phone", "123"],
    ["country", "Taiwan, home of many things 12345"],
    ["country", "x".repeat(61)],
  ])("drops bad %s value %s", (field, value) => {
    expect(vet(raw({ findings: [f(field, value, SITE)] }), RETURNED, SUBJECT)).toEqual(nothing);
  });

  it("keeps a clean phone and country", () => {
    const r = vet(raw({ findings: [f("work_phone", "+886 (2) 1234-5678", SITE), f("country", "Cote d'Ivoire", SITE)] }), RETURNED, SUBJECT);
    expect(r.outcome === "findings" && r.findings.map((x) => x.field)).toEqual(["phone", "country"]);
  });

  it("stores the tool's own URL string, not the model's", () => {
    const r = vet(raw({ findings: [f("title", "Director", "https://NEWS.example.test/ada/?utm=1#frag")] }), RETURNED, SUBJECT);
    expect(r.outcome === "findings" && r.findings[0].source).toBe(NEWS);
    const s = vet(raw({ summary: "Ok.", summary_sources: ["https://news.example.test/ada/"] }), RETURNED, SUBJECT);
    expect(s.outcome === "findings" && s.summarySources).toEqual([NEWS]);
  });

  it.each([
    "https://evil.example@news.example.test/ada",
    "https://news.example.test:8443/ada",
    "https://news.example.test.:8443/ada",
    "http://news.example.test/ada",
  ])("drops source %s", (src) => {
    const returned = [...RETURNED, "https://evil.example@news.example.test/ada", "https://news.example.test:8443/ada"];
    expect(vet(raw({ findings: [f("title", "Director", src)] }), returned, SUBJECT)).toEqual(nothing);
  });

  it("does not store a returned URL over 500 chars", () => {
    const long = "https://news.example.test/" + "a".repeat(500);
    expect(vet(raw({ findings: [f("title", "Director", long)] }), [long], SUBJECT)).toEqual(nothing);
  });

  it("treats a trailing-dot blocked host as blocked", () => {
    const u = "https://zoominfo.com./p/ada";
    expect(vet(raw({ findings: [f("title", "Director", u)] }), [u], SUBJECT)).toEqual(nothing);
  });

  it("spoof hosts are not blocked, real subdomains are", () => {
    const ok = ["https://notzoominfo.com/a", "https://zoominfo.com.evil.example/a"];
    for (const u of ok) expect(vet(raw({ findings: [f("title", "Director", u)] }), [u], SUBJECT).outcome).toBe("findings");
    expect(vet(raw({ findings: [f("title", "Director", "https://x.zoominfo.com/a")] }), ["https://x.zoominfo.com/a"], SUBJECT)).toEqual(nothing);
  });

  it("drops control characters, line separators and fullwidth parentheses", () => {
    for (const v of ["Dir ector", "Dir\u0085ector", "Dir\vector", "Dir\tector", "Director（x）"]) {
      expect(vet(raw({ findings: [f("title", v, NEWS)] }), RETURNED, SUBJECT)).toEqual(nothing);
    }
  });

  it("drops a 121-char title and a summary without sources", () => {
    expect(vet(raw({ findings: [f("title", "x".repeat(121), NEWS)] }), RETURNED, SUBJECT)).toEqual(nothing);
    expect(vet(raw({ summary: "Text.", summary_sources: [] }), RETURNED, SUBJECT)).toEqual(nothing);
  });

  it("cuts a summary with no sentence end at the limit", () => {
    const r = vet(raw({ summary: "a".repeat(2500), summary_sources: [NEWS] }), RETURNED, SUBJECT);
    expect(r.outcome === "findings" && r.summary.length).toBe(2000);
  });

  it("freezes the domain lists", () => {
    expect(Object.isFrozen(BLOCKED_DOMAINS)).toBe(true);
    expect(Object.isFrozen(FREE_MAIL)).toBe(true);
  });
});

describe("vet vouching and summary", () => {
  const nothing = { outcome: "nothing" };
  const NO_SITE = { ...SUBJECT, companyWebsite: null };
  const NEWS = "https://news.example.test/ada";
  const EVIL = "https://evil.example/about";
  const EMAIL_PAGE = "https://www.examplecorp.test/team/ada";
  const kept = (r: ReturnType<typeof vet>) => (r.outcome === "findings" ? r.findings.map((x) => x.field) : []);

  it("drops an injected page that claims to be the website and offers its own email while a site is on file", () => {
    const returned = [...RETURNED, EVIL];
    const r = vet(
      raw({
        findings: [f("company_website", "https://evil.example", EVIL), f("work_email", "mia@evil.example", EVIL)],
      }),
      returned,
      SUBJECT,
    );
    expect(r).toEqual(nothing);
  });

  it("with a website on file, a website finding does not add a vouching host", () => {
    const returned = [...RETURNED, EVIL];
    const r = vet(raw({ findings: [f("company_website", "https://evil.example", EVIL), f("work_phone", "+886 2 5555 0100", EVIL)] }), returned, SUBJECT);
    expect(kept(r)).not.toContain("phone");
  });

  it("with no website on file, a found website still vouches for an email on that domain", () => {
    const r = vet(
      raw({ findings: [f("company_website", "https://examplecorp.test", EMAIL_PAGE), f("work_email", "ada.t@examplecorp.test", EMAIL_PAGE)] }),
      RETURNED,
      NO_SITE,
    );
    expect(kept(r)).toEqual(["website", "email"]);
  });

  it.each([
    ["a different domain on the vouching page", "ada@other.example"],
    ["a lookalike domain", "ada@examplecorp.test.evil.example"],
    ["consecutive dots", "ada@examplecorp..test"],
    ["a dot-less local mismatch", "ada..t@examplecorp.test"],
  ])("drops an email with %s", (_n, email) => {
    expect(vet(raw({ findings: [f("work_email", email, EMAIL_PAGE)] }), RETURNED, SUBJECT)).toEqual(nothing);
  });

  it("accepts an email on a subdomain or a parent domain of the vouching host", () => {
    const sub = vet(raw({ findings: [f("work_email", "ada@mail.examplecorp.test", EMAIL_PAGE)] }), RETURNED, SUBJECT);
    expect(kept(sub)).toEqual(["email"]);
    const parentSite = { ...SUBJECT, companyWebsite: "https://www.team.examplecorp.test" };
    const returned = [...RETURNED, "https://team.examplecorp.test/ada"];
    const parent = vet(raw({ findings: [f("work_email", "ada.t@examplecorp.test", "https://team.examplecorp.test/ada")] }), returned, parentSite);
    expect(kept(parent)).toEqual(["email"]);
  });

  it("freezes and applies the not-a-company-site list, including subdomains", () => {
    expect(Object.isFrozen(NOT_COMPANY_SITES)).toBe(true);
    for (const h of NOT_COMPANY_SITES) {
      for (const host of [h, "acme." + h]) {
        const src = `https://${host}/p`;
        expect(vet(raw({ findings: [f("company_website", `https://${host}`, src)] }), [...RETURNED, src], NO_SITE)).toEqual(nothing);
      }
    }
  });

  it("strips a trailing dot from the email domain anchor", () => {
    const a = anchorsOf({ ...SUBJECT, company: null, email: "ada@gmail.com." });
    expect(a.emailDomain).toBeNull();
    expect(anchorsOf({ ...SUBJECT, email: "ada@work.test." }).emailDomain).toBe("work.test");
  });

  it("collapses whitespace and line breaks in the summary", () => {
    const r = vet(raw({ summary: "  Ada leads\n\n research.\t  She\r\nwrites.  ", summary_sources: [NEWS] }), RETURNED, SUBJECT);
    expect(r.outcome === "findings" && r.summary).toBe("Ada leads research. She writes.");
  });

  it.each([
    ["an email", "Reach her at ada@home.example for more."],
    ["an http URL", "See http://home.example/ada for more."],
    ["an https URL", "See https://home.example/ada for more."],
    ["a www address", "See www.home.example for more."],
    ["a plain phone", "Call +886 912 345 678 any time."],
    ["a dashed phone", "Call 555-0100-22 any time."],
    ["a bracketed phone", "Call (02) 5555 0100 any time."],
    ["a dotted phone", "Call 555.0100.22 any time."],
  ])("drops a summary containing %s", (_n, summary) => {
    expect(vet(raw({ summary, summary_sources: [NEWS] }), RETURNED, SUBJECT)).toEqual(nothing);
  });

  it("keeps a summary with a year and short numbers", () => {
    const r = vet(raw({ summary: "Ada joined in 2019 and manages 12 analysts across 3 teams.", summary_sources: [NEWS] }), RETURNED, SUBJECT);
    expect(r.outcome).toBe("findings");
  });
});

describe("anchors", () => {
  const base = { ...SUBJECT, company: null, email: null, companyWebsite: null };
  it("is false for name only and gmail only", () => {
    expect(hasAnchor(base)).toBe(false);
    expect(hasAnchor({ ...base, email: "a@gmail.com" })).toBe(false);
  });
  it("is true for company, work email, or LinkedIn /in/", () => {
    expect(hasAnchor({ ...base, company: "X" })).toBe(true);
    expect(hasAnchor({ ...base, email: "a@work.test" })).toBe(true);
    expect(hasAnchor({ ...base, linkedin: "https://www.linkedin.com/in/ada" })).toBe(true);
    expect(hasAnchor({ ...base, linkedin: "https://www.linkedin.com/company/ada" })).toBe(false);
    expect(anchorsOf({ ...base, email: "a@work.test" }).emailDomain).toBe("work.test");
  });
});

const create = vi.fn();
const client = { messages: { create: (...a: unknown[]) => create(...a) } } as unknown as Anthropic;

function reply(doc: unknown, extra: unknown[] = [], stop_reason = "end_turn") {
  return {
    stop_reason,
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      ...extra,
      { type: "text", text: typeof doc === "string" ? doc : JSON.stringify(doc) },
    ],
  };
}
const results = (...urls: string[]) => ({
  type: "web_search_tool_result",
  tool_use_id: "s1",
  content: urls.map((url) => ({ type: "web_search_result", url, title: "t" })),
});

beforeEach(() => {
  create.mockReset();
  vi.stubEnv("MONSOON_RESEARCH_MODEL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("runResearch", () => {
  it("runs a clean research and sends the exact tool", async () => {
    create.mockResolvedValue(
      reply(raw({ findings: [f("title", "Director", "https://news.example.test/ada")] }), [results("https://news.example.test/ada")])
    );
    const run = await runResearch(client, SUBJECT);
    expect(run).toMatchObject({ vetted: { outcome: "findings" } });
    const [params, opts] = create.mock.calls[0];
    expect(params.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 6, blocked_domains: BLOCKED_DOMAINS }]);
    expect(params.tool_choice).toBeUndefined();
    expect(params.max_tokens).toBe(4000);
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.output_config.format.schema.additionalProperties).toBe(false);
    expect(params.output_config.format.schema.properties.findings.items.properties.field.enum).toEqual([
      "title", "linkedin_url", "country", "company_website", "work_email", "work_phone",
    ]);
    expect(opts).toEqual({ timeout: 45_000, maxRetries: 0 });
    expect(JSON.stringify(params.messages)).toContain("Ada Testperson");
  });

  it("a search error block contributes no URLs", async () => {
    create.mockResolvedValue(
      reply(raw({ findings: [f("title", "Director", "https://news.example.test/ada")] }), [
        { type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
      ])
    );
    expect(await runResearch(client, SUBJECT)).toEqual({ vetted: { outcome: "nothing" } });
  });

  it("maps refusal, pause_turn, max_tokens, timeouts and malformed JSON", async () => {
    create.mockResolvedValueOnce(reply(raw(), [], "refusal"));
    expect(await runResearch(client, SUBJECT)).toEqual({ failed: "refused" });
    create.mockResolvedValueOnce(reply(raw(), [], "pause_turn"));
    expect(await runResearch(client, SUBJECT)).toEqual({ failed: "timeout" });
    create.mockResolvedValueOnce(reply(raw(), [], "max_tokens"));
    expect(await runResearch(client, SUBJECT)).toEqual({ failed: "timeout" });
    create.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError());
    expect(await runResearch(client, SUBJECT, { timeoutMs: 1000 })).toEqual({ failed: "timeout" });
    create.mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: "x" }));
    expect(await runResearch(client, SUBJECT)).toEqual({ failed: "timeout" });
    create.mockResolvedValueOnce(reply("not json"));
    expect(await runResearch(client, SUBJECT)).toEqual({ failed: "malformed" });
    create.mockResolvedValueOnce(reply({ identity: "established" }));
    expect(await runResearch(client, SUBJECT)).toEqual({ failed: "malformed" });
  });

  it("refuses an Opus model id", async () => {
    vi.stubEnv("MONSOON_RESEARCH_MODEL", "claude-opus-5-5");
    await expect(runResearch(client, SUBJECT)).rejects.toThrow("MONSOON_RESEARCH_MODEL must not be an Opus or Fable model");
    expect(create).not.toHaveBeenCalled();
  });
});
