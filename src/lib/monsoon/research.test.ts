import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLOCKED_DOMAINS,
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
          f("company_website", "https://www.examplecorp.test/about", "https://news.example.test/ada"),
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
        { target: "person", field: "title", from: "Analyst", to: "Senior Analyst", source: "https://examplecorp.test/team/ada" },
        { target: "person", field: "linkedin", from: null, to: "https://www.linkedin.com/in/ada-testperson", source: "https://linkedin.com/in/ada-testperson" },
        { target: "company", field: "website", from: null, to: "https://www.examplecorp.test", source: "https://news.example.test/ada" },
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
