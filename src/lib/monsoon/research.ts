import Anthropic from "@anthropic-ai/sdk";
import type { ResearchField, ResearchFinding } from "./ask/proposal";

export type ResearchSubject = {
  name: string;
  company: string | null;
  companyWebsite: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  country: string | null;
};

export const BLOCKED_DOMAINS: readonly string[] = Object.freeze([
  "zoominfo.com", "rocketreach.co", "apollo.io", "lusha.com", "signalhire.com", "contactout.com",
  "datanyze.com", "spokeo.com", "whitepages.com", "beenverified.com", "truepeoplesearch.com",
  "fastpeoplesearch.com", "peoplefinders.com", "intelius.com", "radaris.com", "mylife.com", "pipl.com",
  "peekyou.com", "thatsthem.com", "clustrmaps.com", "nuwber.com", "usphonebook.com", "idcrawl.com",
  "instantcheckmate.com", "truthfinder.com", "checkpeople.com", "leadiq.com", "seamless.ai", "hunter.io",
  "snov.io", "facebook.com", "instagram.com", "tiktok.com",
]);

export const FREE_MAIL: readonly string[] = Object.freeze([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com",
  "me.com", "aol.com", "proton.me", "protonmail.com", "qq.com", "163.com",
]);

/** Publishing, social and reference sites: never a company's own website. */
export const NOT_COMPANY_SITES: readonly string[] = Object.freeze([
  "medium.com", "substack.com", "wordpress.com", "blogspot.com", "wixsite.com", "github.io", "notion.site",
  "x.com", "twitter.com", "youtube.com", "crunchbase.com", "bloomberg.com", "wikipedia.org", "linktr.ee", "about.me",
]);

const MAX_VALUE = 300;
const MAX_SUMMARY = 2000;
const MAX_IDENTITY = 400;
const MAX_SUMMARY_SOURCES = 6;
const MAX_SOURCE = 500;
const LINKEDIN_IN = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+\/?$/i;

function cleanHost(h: string): string {
  return h.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
}

function hostOf(url: string): string | null {
  try {
    return cleanHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

function isBlockedHost(host: string): boolean {
  return BLOCKED_DOMAINS.some((d) => hostMatches(host, d));
}

/** Lower-case host without www, path without trailing slash, no query, no fragment. */
function normUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return cleanHost(u.hostname) + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Tolerant parse of a website on file, which may lack a scheme. */
function siteHost(site: string | null): string | null {
  if (!site || !site.trim()) return null;
  const s = site.trim();
  return hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s);
}

/** A scheme-less or http:// on-file URL, made https for comparison. */
function withHttps(v: string): string {
  const t = v.trim();
  if (/^https:\/\//i.test(t)) return t;
  if (/^http:\/\//i.test(t)) return "https://" + t.slice(7);
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : "https://" + t;
}

/** Comparable form of a LinkedIn URL: case-insensitive, no locale subdomain, no trailing slash. */
function linkNorm(v: string): string | null {
  const n = normUrl(withHttps(v));
  return n === null ? null : n.toLowerCase().replace(/^[a-z]{2,3}\.linkedin\.com/, "linkedin.com");
}

export function anchorsOf(s: ResearchSubject): { company: string | null; emailDomain: string | null; linkedin: string | null } {
  const company = s.company && s.company.trim() ? s.company.trim() : null;
  let emailDomain: string | null = null;
  const e = s.email?.trim().toLowerCase();
  if (e && e.includes("@")) {
    const d = e.slice(e.lastIndexOf("@") + 1).replace(/\.+$/, "");
    if (d && !FREE_MAIL.includes(d)) emailDomain = d;
  }
  const li = s.linkedin?.trim() ?? null;
  const linkedin = li && LINKEDIN_IN.test(withHttps(li).split(/[?#]/)[0]) ? li : null;
  return { company, emailDomain, linkedin };
}

export function hasAnchor(s: ResearchSubject): boolean {
  const a = anchorsOf(s);
  return !!(a.company || a.emailDomain || a.linkedin);
}

export type RawResearch = {
  identity: "established" | "not_established";
  identity_reason: string;
  findings: { field: string; value: string; source_url: string }[];
  summary: string;
  summary_sources: string[];
};

export type Vetted =
  | { outcome: "findings"; identity: string; findings: Omit<ResearchFinding, "id">[]; summary: string; summarySources: string[] }
  | { outcome: "not_identified" }
  | { outcome: "nothing" };

const FIELD_MAP: Record<string, ResearchField> = {
  title: "title",
  linkedin_url: "linkedin",
  country: "country",
  company_website: "website",
  work_email: "email",
  work_phone: "phone",
};

// C0 and C1 control characters, plus the Unicode line and paragraph separators.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function cleanValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (CONTROL.test(t) || t.includes(LS) || t.includes(PS)) return null;
  const c = t.replace(/\s+/g, " ");
  if (!c || c.length > MAX_VALUE) return null;
  return c;
}

function cutSummary(s: string): string {
  if (s.length <= MAX_SUMMARY) return s;
  const head = s.slice(0, MAX_SUMMARY);
  let end = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (/[.!?]/.test(head[i]) && (i === head.length - 1 || /\s/.test(head[i + 1]))) {
      end = i;
      break;
    }
  }
  return (end > 0 ? head.slice(0, end + 1) : head).trim();
}

const same = (a: string | null | undefined, b: string): boolean =>
  !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

const SECOND_LEVEL = ["co", "com", "org", "net", "gov", "edu", "ac"];

/** Last two labels, or the last three when the second-to-last is a common second-level label. */
function registrable(host: string): string[] {
  const labels = cleanHost(host).split(".");
  const n = labels.length >= 3 && SECOND_LEVEL.includes(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-n);
}

/** Same registrable domain, and the domain has at least as many labels as it (a bare suffix never matches). */
function sameRegistrable(domain: string, host: string): boolean {
  const a = registrable(domain);
  const b = registrable(host);
  return cleanHost(domain).split(".").length >= a.length && a.length === b.length && a.join(".") === b.join(".");
}

/** "Analyst at Acme Ltd" for a contact at Acme: the part before " at ", else the title unchanged. */
function stripAtCompany(title: string, company: string | null): string {
  const name = company?.trim().toLowerCase();
  if (!name) return title;
  const core = name.replace(/(,\s*|\s+)(llc|ltd|inc|limited|corp|plc)\.?$/i, "").trim();
  const m = /^(.*?)(?:^|\s)at\s+(.+)$/i.exec(title);
  if (!m) return title;
  const tail = m[2].toLowerCase();
  if (!tail.includes(name) && !(core && tail.includes(core))) return title;
  return m[1].trim();
}

/** Pure. `returned` is every URL the search tool returned in this run. */
export function vet(raw: RawResearch, returned: string[], subject: ResearchSubject): Vetted {
  if (raw.identity !== "established") return { outcome: "not_identified" };

  // Usable returned URLs by normalised form; the tool's own string is what gets stored.
  const returnedByNorm = new Map<string, string>();
  for (const r of returned) {
    if (typeof r !== "string") continue;
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      continue;
    }
    if (!r.startsWith("https://") || r.length > MAX_SOURCE) continue;
    if (u.protocol !== "https:" || u.username || u.password || u.port) continue;
    const n = normUrl(r);
    if (n !== null && !returnedByNorm.has(n)) returnedByNorm.set(n, r);
  }
  /** The tool's own URL string for a model-cited source, or null when it does not qualify. */
  const resolveSource = (url: unknown): string | null => {
    if (typeof url !== "string") return null;
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      return null;
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    if (isBlockedHost(cleanHost(u.hostname))) return null;
    const n = normUrl(url.trim());
    return n === null ? null : returnedByNorm.get(n) ?? null;
  };

  const onFile = (field: ResearchField): string | null => {
    switch (field) {
      case "title": return subject.title;
      case "linkedin": return subject.linkedin;
      case "country": return subject.country;
      case "website": return subject.companyWebsite;
      case "email": return subject.email;
      case "phone": return subject.phone;
    }
  };
  const equalsOnFile = (field: ResearchField, to: string): boolean => {
    const cur = onFile(field);
    if (!cur || !cur.trim()) return false;
    if (field === "linkedin") {
      const a = linkNorm(cur);
      return a !== null && a === linkNorm(to);
    }
    if (field === "website") {
      const ha = siteHost(cur);
      return ha !== null && ha === hostOf(to);
    }
    return same(cur, to);
  };

  type Item = { idx: number; field: ResearchField; value: string; source: string };
  const seen = new Set<ResearchField>();
  const items: Item[] = [];
  (Array.isArray(raw.findings) ? raw.findings : []).forEach((rf, idx) => {
    if (!rf || typeof rf !== "object" || typeof rf.field !== "string") return;
    if (!Object.hasOwn(FIELD_MAP, rf.field)) return;
    const field = FIELD_MAP[rf.field];
    if (seen.has(field)) return;
    seen.add(field);
    const source = resolveSource(rf.source_url);
    if (source === null) return;
    const value = cleanValue(rf.value);
    if (value === null) return;
    items.push({ idx, field, value, source });
  });

  const kept: (Item & { target: "person" | "company" })[] = [];
  const finish = (it: Item, to: string, target: "person" | "company"): boolean => {
    if (equalsOnFile(it.field, to)) return false;
    kept.push({ ...it, value: to, target });
    return true;
  };

  const emailPhone: Item[] = [];
  let websiteHost: string | null = null;
  for (const it of items) {
    if (it.field === "email" || it.field === "phone") {
      emailPhone.push(it);
    } else if (it.field === "title") {
      const title = stripAtCompany(it.value, subject.company);
      if (!title || title.length > 120 || /[(\uFF08]/.test(title)) continue;
      finish(it, title, "person");
    } else if (it.field === "linkedin") {
      const base = it.value.split(/[?#]/)[0];
      if (!LINKEDIN_IN.test(base)) continue;
      // The profile itself must be a page the search returned.
      const n = normUrl(base);
      if (n === null || !returnedByNorm.has(n)) continue;
      finish(it, base.replace(/\/+$/, ""), "person");
    } else if (it.field === "website") {
      if (!subject.company || !subject.company.trim()) continue;
      let u: URL;
      try {
        u = new URL(it.value);
      } catch {
        continue;
      }
      if (u.protocol !== "https:" || u.username || u.password || u.port) continue;
      const host = cleanHost(u.hostname);
      if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost")) continue;
      if (/^[\d.]+$/.test(host) || host.includes(":") || u.hostname.startsWith("[")) continue;
      if (NOT_COMPANY_SITES.some((d) => hostMatches(host, d))) continue;
      if (isBlockedHost(host) || hostMatches(host, "linkedin.com") || FREE_MAIL.some((d) => hostMatches(host, d))) continue;
      // The site must vouch for itself: the cited page is on the website's own host.
      if (hostOf(it.source) !== host) continue;
      // Research fills an empty website; it does not replace the one on file with a page's claim.
      const onFileSite = siteHost(subject.companyWebsite);
      if (onFileSite !== null && onFileSite !== host) continue;
      if (finish(it, `https://${u.hostname.toLowerCase().replace(/\.+$/, "")}`, "company")) websiteHost = host;
    } else if (it.field === "country") {
      if (it.value.length > 60 || !/^[\p{L}\p{M} .'-]+$/u.test(it.value)) continue;
      finish(it, it.value, "person");
    }
  }

  // Work email and phone, only from the employer's own site.
  // A website on file is the only voucher; a found website counts only when none is on file.
  const onFileHost = siteHost(subject.companyWebsite);
  const employerHosts = onFileHost ? [onFileHost] : websiteHost ? [websiteHost] : [];
  for (const it of emailPhone) {
    const sh = hostOf(it.source);
    if (!sh || !employerHosts.some((h) => hostMatches(sh, h))) continue;
    if (it.field === "email") {
      if (it.value.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(it.value) || it.value.includes("..")) continue;
      const domain = cleanHost(it.value.slice(it.value.lastIndexOf("@") + 1));
      if (FREE_MAIL.some((d) => hostMatches(domain, d))) continue;
      // The address must belong to the vouching site: same domain, a subdomain or a parent of it.
      if (NOT_COMPANY_SITES.includes(domain)) continue;
      if (!employerHosts.some((h) => sameRegistrable(domain, h))) continue;
    } else if (!/^\+?[0-9 ().-]{7,25}$/.test(it.value)) {
      continue;
    }
    finish(it, it.value, "person");
  }

  kept.sort((a, b) => a.idx - b.idx);
  const findings: Omit<ResearchFinding, "id">[] = kept.map((k) => ({
    target: k.target,
    field: k.field,
    from: onFile(k.field)?.trim() || null,
    to: k.value,
    source: k.source,
  }));

  let summary = typeof raw.summary === "string" ? raw.summary.replace(/\s+/g, " ").trim() : "";
  // The summary is free text: contact details and links do not belong in it.
  if (/[^\s@]+@[^\s@]+/.test(summary) || /https?:\/\/|www\./i.test(summary) || /\+?\d(?:[\s.\-()]*\d){8,}/.test(summary.replace(/\b(?:19|20)\d\d[-/\s](?:19|20)\d\d\b/g, ""))) {
    summary = "";
  }
  const summarySources: string[] = [];
  if (Array.isArray(raw.summary_sources)) {
    for (const src of raw.summary_sources) {
      if (summarySources.length >= MAX_SUMMARY_SOURCES) break;
      const r = resolveSource(src);
      if (r !== null && !summarySources.includes(r)) summarySources.push(r);
    }
  }
  if (summary) summary = cutSummary(summary);
  if (!summary || summarySources.length === 0) {
    summary = "";
    summarySources.length = 0;
  }

  if (findings.length === 0 && !summary) return { outcome: "nothing" };
  const identity = (typeof raw.identity_reason === "string" ? raw.identity_reason : "").trim().slice(0, MAX_IDENTITY);
  return { outcome: "findings", identity, findings, summary, summarySources };
}

const SYSTEM_PROMPT =
  "You research one business contact for a CRM. First establish identity: treat a page as about this person only if it matches the name and at least one given anchor (company, email domain, LinkedIn URL). If identity is not established, return identity \"not_established\", no findings, and say why in identity_reason. Report only what a page returned by search states: no inference, no \"likely\". Professional information only: the current job title (the title alone, no sentence), the LinkedIn profile URL (a linkedin.com/in/ page), the work country, the company website, and a two-to-four sentence professional summary (role, focus, career; a city may be mentioned there). Report a work email or work phone only when it is published for this person on the employer's own website. Never report a home address, personal phone or email, age, family, health, politics, religion, photos, or anything taken from people-search or data-broker sites. Every finding names the URL of the page that states it, and every summary source is a page the search returned. If sources conflict, leave the finding out. The user message gives the name, company, company website, email domain, LinkedIn URL and current title when on file.";

const SCHEMA = {
  type: "object",
  properties: {
    identity: { type: "string", enum: ["established", "not_established"] },
    identity_reason: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["title", "linkedin_url", "country", "company_website", "work_email", "work_phone"] },
          value: { type: "string" },
          source_url: { type: "string" },
        },
        required: ["field", "value", "source_url"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
    summary_sources: { type: "array", items: { type: "string" } },
  },
  required: ["identity", "identity_reason", "findings", "summary", "summary_sources"],
  additionalProperties: false,
};

export function resolveResearchModel(): string {
  const model = process.env.MONSOON_RESEARCH_MODEL || "claude-haiku-5-5";
  if (/opus|fable/i.test(model)) {
    throw new Error("MONSOON_RESEARCH_MODEL must not be an Opus or Fable model");
  }
  return model;
}

export type ResearchRun = { vetted: Vetted } | { failed: "timeout" | "refused" | "malformed" };

function userMessage(s: ResearchSubject): string {
  const a = anchorsOf(s);
  const lines = [`Name: ${s.name}`];
  if (a.company) lines.push(`Company: ${a.company}`);
  if (s.companyWebsite?.trim()) lines.push(`Company website: ${s.companyWebsite.trim()}`);
  if (a.emailDomain) lines.push(`Email domain: ${a.emailDomain}`);
  if (a.linkedin) lines.push(`LinkedIn URL: ${a.linkedin}`);
  if (s.title?.trim()) lines.push(`Current title: ${s.title.trim()}`);
  return lines.join("\n");
}

function parseRaw(text: string): RawResearch | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.identity !== "established" && r.identity !== "not_established") return null;
  if (typeof r.identity_reason !== "string" || typeof r.summary !== "string") return null;
  if (!Array.isArray(r.findings) || !Array.isArray(r.summary_sources)) return null;
  const findings = r.findings.filter(
    (x): x is { field: string; value: string; source_url: string } =>
      typeof x === "object" && x !== null &&
      typeof (x as Record<string, unknown>).field === "string" &&
      typeof (x as Record<string, unknown>).value === "string" &&
      typeof (x as Record<string, unknown>).source_url === "string"
  );
  return {
    identity: r.identity,
    identity_reason: r.identity_reason,
    findings,
    summary: r.summary,
    summary_sources: r.summary_sources.filter((x): x is string => typeof x === "string"),
  };
}

type Block = { type: string; text?: string; content?: unknown };

export async function runResearch(
  client: Anthropic,
  subject: ResearchSubject,
  opts?: { timeoutMs?: number }
): Promise<ResearchRun> {
  // Resolved per call so a bad MONSOON_RESEARCH_MODEL fails the run, not the build.
  const model = resolveResearchModel();

  // The installed SDK types may not know output_config or blocked_domains; cast narrowly.
  const params = {
    model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6, blocked_domains: BLOCKED_DOMAINS }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: userMessage(subject) }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;

  let response: { stop_reason: string | null; content: Block[] };
  try {
    response = (await client.messages.create(params, {
      timeout: opts?.timeoutMs ?? 45_000,
      maxRetries: 0,
    })) as unknown as typeof response;
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionError) return { failed: "timeout" };
    throw err;
  }

  if (response.stop_reason === "refusal") return { failed: "refused" };
  if (response.stop_reason === "pause_turn" || response.stop_reason === "max_tokens") return { failed: "timeout" };

  const returned: string[] = [];
  let text: string | null = null;
  for (const b of response.content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content as { type?: string; url?: unknown }[]) {
        if (r && r.type === "web_search_result" && typeof r.url === "string") returned.push(r.url);
      }
    } else if (b.type === "text" && typeof b.text === "string") {
      text = b.text;
    }
  }
  if (text === null) return { failed: "malformed" };
  const raw = parseRaw(text);
  if (!raw) return { failed: "malformed" };
  return { vetted: vet(raw, returned, subject) };
}
