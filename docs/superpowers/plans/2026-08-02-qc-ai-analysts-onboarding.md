# Quant Cloud AI Analysts Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reposition quantcloud.com around configurable AI analysts and route QC-branded early-access signups into the shared Zero One waitlist and Mailchimp audience with reliable acquisition tagging.

**Architecture:** Quant Cloud renders and owns a two-step onboarding experience. A QC server route fixes the source to `qc-website` and forwards requests, with a shared secret, to the existing 01.co waitlist endpoint; that endpoint remains the database and Mailchimp source of truth and maps trusted requests to controlled acquisition tags.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, Vitest, React Testing Library, Prisma/Postgres in the shared service, Mailchimp Marketing API, Vercel.

## Global Constraints

- QC visitors must see Quant Cloud branding only; QC pages and form states must not mention Zero One or The Blade.
- Position the product for research-intensive organizations covering public companies, private companies, industries, themes, technologies, or other defined universes.
- Explicitly support internal-decision research and publication-ready research without describing it as marketing content.
- Keep one shared waitlist database and one shared Mailchimp audience.
- Apply exactly one controlled acquisition tag: `Acquisition: Zero One` or `Acquisition: QC Website`.
- Keep the waitlist database write authoritative; Mailchimp and notification failures must not lose a lead.
- Preserve the existing QC visual system: dark ink, cyan signal color, grid texture, Inter, and JetBrains Mono.
- Use test-first red/green cycles for new behavior.

---

### Task 1: Trusted acquisition tagging in the shared onboarding service

**Files:**
- Modify: `C:/Dev/01website/zero-one-website/src/app/api/analysts-waitlist/route.ts`
- Modify: `C:/Dev/01website/zero-one-website/src/app/api/__tests__/analysts-waitlist-route.test.ts`

**Interfaces:**
- Consumes: `Request`, `process.env.ANALYSTS_INGEST_SECRET`, and the existing `upsertMember()` helper.
- Produces: `acquisitionTag(source: string | null, trustedQcRequest: boolean): "Acquisition: Zero One" | "Acquisition: QC Website"` and trusted QC classification through the `x-analysts-ingest-secret` header.

- [ ] **Step 1: Write failing tests for controlled source tags**

Add cases proving that normal analysts-page signups receive `['Analysts Waitlist', 'Acquisition: Zero One']`, a QC source with the configured secret receives `['Analysts Waitlist', 'Acquisition: QC Website']`, and a spoofed QC source without the secret still receives the Zero One tag.

- [ ] **Step 2: Run the focused route test and confirm RED**

Run: `npm test -- src/app/api/__tests__/analysts-waitlist-route.test.ts`

Expected: FAIL because the route currently supplies only `Analysts Waitlist`.

- [ ] **Step 3: Implement trusted tag classification**

Read the secret from the environment, compare it against the request header, classify only an authenticated `qc-website` source as QC, and pass the resulting controlled acquisition tag alongside `Analysts Waitlist`. Preserve free-form `source` in Prisma and existing best-effort behavior.

- [ ] **Step 4: Run the focused and full shared-service tests**

Run: `npm test -- src/app/api/__tests__/analysts-waitlist-route.test.ts`

Run: `npm test`

Expected: all tests pass with no test failures.

- [ ] **Step 5: Commit the shared-service change**

Commit only the route and its test with message `feat(analysts): tag waitlist acquisition brand`.

---

### Task 2: QC server bridge

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.ts`
- Create: `src/app/api/analysts-waitlist/route.ts`
- Create: `src/app/api/analysts-waitlist/route.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: JSON `{ step, email, website?, firmType?, universeSize?, channel?, currentProcess? }`, `ANALYSTS_WAITLIST_API_URL`, and `ANALYSTS_INGEST_SECRET`.
- Produces: `POST(request: Request): Promise<NextResponse>` forwarding a sanitized request with `source: "qc-website"` and the secret header.

- [ ] **Step 1: Add the QC test runner and write failing route tests**

Install Vitest as a development dependency, configure the `@` alias, and test malformed JSON, invalid steps, invalid email, honeypot short-circuiting, forced QC source, field forwarding, upstream error normalization, and missing configuration.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- src/app/api/analysts-waitlist/route.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the proxy route**

Validate JSON, step, and normalized email locally; silently accept honeypot submissions; construct a fixed allow-listed payload; attach `x-analysts-ingest-secret`; call the configured upstream URL with `cache: "no-store"`; pass through successful JSON; return a brand-neutral `502` error when the upstream is unavailable.

- [ ] **Step 4: Run the focused route tests**

Run: `npm test -- src/app/api/analysts-waitlist/route.test.ts`

Expected: all route tests pass.

- [ ] **Step 5: Commit the bridge**

Commit the route, tests, test configuration, lockfile, package manifest, and environment example with message `feat: bridge QC analyst waitlist to shared onboarding`.

---

### Task 3: QC-branded two-step onboarding form

**Files:**
- Create: `src/components/WaitlistForm.tsx`
- Create: `src/components/WaitlistForm.test.tsx`
- Modify: `src/components/Hero.tsx`
- Modify: `src/components/Nav.tsx`

**Interfaces:**
- Consumes: the QC-local `/api/analysts-waitlist` POST contract from Task 2.
- Produces: `WaitlistForm` with email, optional qualification, retry, skip, and completion phases; the hero and navigation anchor it at `#early-access`.

- [ ] **Step 1: Write failing form interaction tests**

Using React Testing Library, prove that the form posts step one without a client-controlled source, advances to optional questions, posts step two, allows skip, shows a retryable optional-details error, and contains no `Zero One` or `The Blade` text in every rendered phase.

- [ ] **Step 2: Run the form test and confirm RED**

Run: `npm test -- src/components/WaitlistForm.test.tsx`

Expected: FAIL because `WaitlistForm` does not exist.

- [ ] **Step 3: Implement the form and place it in the hero**

Build accessible QC-styled controls with organization types broad enough for funds, advisory/research firms, corporates, publishers, and other teams. Use QC-only success text. Update the hero CTA hierarchy so the form is primary and the secondary action scrolls to capabilities. Update the navigation CTA to `Request early access`.

- [ ] **Step 4: Run form and route tests**

Run: `npm test -- src/components/WaitlistForm.test.tsx src/app/api/analysts-waitlist/route.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit the onboarding UI**

Commit the form, tests, hero, and nav with message `feat: add QC-branded early access onboarding`.

---

### Task 4: Broaden the QC product story

**Files:**
- Modify: `src/components/Capabilities.tsx`
- Modify: `src/components/Audience.tsx`
- Modify: `src/components/Contact.tsx`
- Modify: `src/components/Footer.tsx`
- Modify: `src/app/layout.tsx`
- Modify: `src/lib/config.ts`
- Modify: `src/app/globals.css`
- Modify: `src/app/page.tsx` only if section order changes.

**Interfaces:**
- Consumes: the existing one-page section layout and Tailwind token system.
- Produces: a coherent QC-only narrative from broad research coverage through customization, internal/public output, early access, and institutional implementation.

- [ ] **Step 1: Add a failing brand/content regression test**

Extend the component test suite to render the home sections and assert presence of public companies, private companies, industries/themes, and publication-ready research language while asserting absence of the phrases `Sister company of Zero One`, `marketing content`, and US-only positioning.

- [ ] **Step 2: Run the content test and confirm RED**

Run: `npm test -- src/components/WaitlistForm.test.tsx`

Expected: FAIL because the current sections retain services-first copy and the footer names Zero One.

- [ ] **Step 3: Implement the broader content and restrained visual signature**

Rewrite capabilities and audiences around research universes, maintained analysis/models, internal/public outputs, customization, and secure workflows. Replace the Zero One footer reference with QC-only legal/brand text. Add the hero coverage-field motif using HTML/CSS rather than generated or inline SVG imagery. Update metadata and configuration copy.

- [ ] **Step 4: Verify tests, lint-equivalent checks, and production build**

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `npm run build`

Expected: all tests pass, TypeScript exits zero, and the Next.js production build exits zero.

- [ ] **Step 5: Commit the messaging update**

Commit the page components, metadata, config, and styles with message `feat: broaden QC AI analyst positioning`.

---

### Task 5: Configure, deploy, and verify production

**Files:**
- No source files unless verification finds a defect that receives its own red/green fix.

**Interfaces:**
- Consumes: `ANALYSTS_INGEST_SECRET` in both Vercel projects and `ANALYSTS_WAITLIST_API_URL=https://01.co/api/analysts-waitlist` in QC.
- Produces: live deployments at `https://01.co/analysts` and `https://quantcloud.com/` sharing one onboarding list with controlled acquisition tags.

- [ ] **Step 1: Inspect deployment configuration and production environment names**

Use the existing linked Vercel projects. Confirm no current secret values are printed. Generate one strong shared secret and set it for Production, Preview, and Development in both projects; set the upstream URL in QC.

- [ ] **Step 2: Deploy the shared service, then QC**

Run production deployments through the existing Vercel CLI linkage, first for `zero-one-website`, then for `qcwebsite`, and confirm both domains resolve to the new deployments.

- [ ] **Step 3: Verify public pages and safe request behavior**

Fetch both production pages and confirm expected headings/status. POST an invalid email to the QC endpoint and confirm `400` without creating a subscriber. Exercise honeypot success and confirm `200`. Inspect the rendered QC HTML and client-visible strings for forbidden Zero One/The Blade wording.

- [ ] **Step 4: Verify one real tagged signup only if a designated test address exists**

If the environment or existing tests provide an approved QA address, submit it through QC and verify the shared waitlist/Mailchimp tag through existing read-only tooling. Otherwise do not create a live subscriber; rely on the authenticated route tests and production invalid/honeypot checks and state that limitation precisely.

- [ ] **Step 5: Record final repository state**

Run `git status --short`, `git log -5 --oneline`, the full tests, and both production builds again after any deployment-driven edits. Report deployed URLs, commits, checks, and any deliberately skipped live-subscriber check.
