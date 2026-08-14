# QC Agentic Research Brain Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reposition the existing Quant Cloud homepage around “your agentic research brain” while presenting finance, universities, and broader professional research as equal applications.

**Architecture:** Keep the current single-page Next.js composition and request-access API unchanged. Update the content-bearing React components and metadata in place, add university/general research language to the visible form options, and update the existing content tests to assert the new category boundary.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, Framer Motion, Lucide React, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-14-qc-agentic-research-brain-design.md`

## Global Constraints

- The homepage must make `your agentic research brain` the dominant promise.
- Finance is one application, not the homepage category or default audience.
- Finance, universities, and broader professional research teams must all be represented.
- Do not change waitlist submission behavior or the backend API contract.
- Preserve mobile responsiveness, visible focus states, and reduced-motion behavior.
- The app must pass the existing test suite and production build.

---

### Task 1: Replace positioning assertions with research-first acceptance tests

**Files:**
- Modify: `src/components/Content.test.tsx`

**Interfaces:**
- Consumes: Existing rendered homepage components and current Testing Library setup.
- Produces: Regression coverage for the new public positioning without coupling tests to implementation details.

- [ ] **Step 1: Replace the finance-shaped content test**

Update the existing `QC AI analyst positioning` suite so the primary content test renders `Hero`, `Capabilities`, `Audience`, `Contact`, and `Footer`, then asserts the page contains the following user-facing concepts:

```ts
expect(copy).toMatch(/your agentic research brain/i);
expect(copy).toMatch(/finance|investment research/i);
expect(copy).toMatch(/universities|students/i);
expect(copy).toMatch(/professional research teams/i);
expect(copy).toMatch(/investigates|remembers|reasons|produces/i);
expect(copy).toMatch(/questions.*sources.*reasoning.*work/i);
```

Remove assertions that require the old coverage-pill list (`public companies`, `private companies`, `industries`, `themes`) or the phrase `publication-ready`.

- [ ] **Step 2: Add the finance-not-category guard**

In the customer-facing copy test, retain the existing forbidden-brand and no-beta assertions and add a guard that prevents the old finance-first framing:

```ts
expect(copy).not.toMatch(/AI analysts built around your research universe/i);
expect(copy).not.toMatch(/only|exclusively.*finance|finance.*only/i);
```

- [ ] **Step 3: Run the focused content test and confirm it fails before implementation**

Run: `npm test -- --run src/components/Content.test.tsx`

Expected: FAIL because the current copy does not contain the new positioning and audience language.

- [ ] **Step 4: Commit the test-first change**

```bash
git add src/components/Content.test.tsx
git commit -m "test: define research brain homepage positioning"
```

### Task 2: Update homepage copy and metadata around the research brain category

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/components/Nav.tsx`
- Modify: `src/components/Hero.tsx`
- Modify: `src/components/Capabilities.tsx`
- Modify: `src/components/Audience.tsx`
- Modify: `src/components/Contact.tsx`
- Modify: `src/components/Footer.tsx`
- Modify: `src/components/WaitlistForm.tsx`

**Interfaces:**
- Consumes: Existing `siteConfig`, section anchors, `WaitlistForm`, and request-access API payload names.
- Produces: A research-first homepage with equal visibility for finance, universities, and professional research teams while preserving all existing links, form phases, and payload fields.

- [ ] **Step 1: Update the shared site positioning and metadata**

Set `siteConfig.tagline` to `Your agentic research brain.` and replace the description with copy that names persistent research systems for professionals, teams, and institutions. Update `src/app/layout.tsx` title, description, Open Graph, and Twitter metadata to use the same phrase and avoid finance-first wording.

- [ ] **Step 2: Update navigation and hero framing**

In `Nav.tsx`, rename the first two links to `How it works` and `Who it is for`, keeping the existing `#capabilities`, `#who-we-serve`, and `#contact` anchors. In `Hero.tsx`:

- Set the eyebrow to `Agentic research systems / Built around how you think`.
- Use `Your agentic research brain.` as the headline.
- Explain that the system learns the visitor's questions, sources, methods, and standards, then turns fragmented information into insight, briefs, and original work.
- Replace the old finance-shaped pills with `Investigate`, `Remember`, `Reason`, and `Produce`.
- Change the access card heading and helper copy to invite a research workflow or institution to equip rather than an AI analyst to configure.
- Keep the existing `#request-access` anchor and `WaitlistForm` integration.

- [ ] **Step 3: Recast capabilities as the research loop**

In `Capabilities.tsx`, replace the three analyst cards with four research-brain capabilities using the existing motion-card pattern and Lucide icons. Use `Radar`, `BrainCircuit`, `SlidersHorizontal`, and `FileOutput` respectively, with this content:

```ts
const capabilities = [
  {
    icon: Radar,
    title: "Investigates the questions that matter",
    body: "Give it a standing question and the relevant source universe. It gathers, monitors, and surfaces the evidence that deserves attention.",
  },
  {
    icon: BrainCircuit,
    title: "Remembers the context",
    body: "It maintains durable project knowledge, evidence, and prior work so every new investigation starts with the context you have already built.",
  },
  {
    icon: SlidersHorizontal,
    title: "Reasons in your method",
    body: "Configure the frameworks, standards, source hierarchy, and review gates that make the work rigorous and recognizably yours.",
  },
  {
    icon: FileOutput,
    title: "Produces work you can stand behind",
    body: "Turn the research into briefs, reports, recurring series, teaching materials, or original work ready for human review.",
  },
];
```

Update the section heading to describe research capacity that compounds over time. Change the flow strip to the exact conceptual sequence `Questions`, `Sources`, `Reasoning`, `Work`, retaining the accessible/visible relationship between inputs, the research brain, and outputs.

- [ ] **Step 4: Rebuild the audience lanes**

In `Audience.tsx`, replace the current four finance-adjacent team cards with three equal cards:

- `Finance & investment research` — fund managers, finance firms, family offices, and diligence teams.
- `Universities & students` — institution-wide or cohort-based research support that strengthens investigation, source evaluation, and independent reasoning.
- `Professional research teams` — strategy, competitive intelligence, technical, market, policy, and other research-intensive functions.

Keep the section anchor `#who-we-serve` and avoid ordering, styling, or copy that makes finance look like the default.

- [ ] **Step 5: Update CTA, footer, and form language**

In `Contact.tsx`, describe bringing one research process worth multiplying and use `Build your research brain` for the primary CTA where it does not conflict with the existing request-access action. In `Footer.tsx`, replace the tagline with `Agentic research systems for serious work`.

In `WaitlistForm.tsx`, keep the request payload keys and API route unchanged, but make the visible language research-brain oriented: add `University or student program` and `Professional research team` to the organization choices, replace analyst-specific placeholder language with research-system language, and keep the existing success/error copy behavior.

- [ ] **Step 6: Run the focused tests and confirm the new copy passes**

Run: `npm test -- --run src/components/Content.test.tsx src/components/WaitlistForm.test.tsx`

Expected: PASS, with all existing request-access behavior tests still green.

- [ ] **Step 7: Commit the homepage implementation**

```bash
git add src/lib/config.ts src/app/layout.tsx src/components/Nav.tsx src/components/Hero.tsx src/components/Capabilities.tsx src/components/Audience.tsx src/components/Contact.tsx src/components/Footer.tsx src/components/WaitlistForm.tsx
git commit -m "feat: reposition homepage around agentic research brains"
```

### Task 3: Run the full verification loop

**Files:**
- Modify: `src/components/Content.test.tsx` only if a test assertion needs to reflect the final visible copy.

**Interfaces:**
- Consumes: Completed homepage copy changes and existing test/build configuration.
- Produces: Verified homepage implementation with no regression to layout or request-access behavior.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: PASS for homepage, content, waitlist form, and API tests.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: PASS with no TypeScript, ESLint, or Next.js build errors.

- [ ] **Step 3: Check the final diff for scope and copy drift**

Run: `git diff HEAD~1 --check` and `git status --short`.

Confirm that only the approved homepage/spec-plan files changed and that no visible copy frames QC as finance-only.

- [ ] **Step 4: Commit any verification-only test adjustment**

If Task 3 required a test-only correction, commit it with:

```bash
git add src/components/Content.test.tsx
git commit -m "test: align homepage assertions with final copy"
```
