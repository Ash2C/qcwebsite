# QuantCloud Access Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present QuantCloud as an operating, implementation-led AI-research service whose prospects request access rather than join a founding cohort.

**Architecture:** Keep the existing QC page, multi-step form, QC proxy route, shared database, and Mailchimp tagging unchanged. Update only customer-facing component copy and anchors, with component tests enforcing the commercial posture and the absence of cohort/test-stage language.

**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest, Testing Library, Vercel

## Global Constraints

- The public CTA is `Request access`.
- Public copy must not contain `early access`, `founding cohort`, `first cohort`, `beta`, `pilot`, or `test users`.
- Do not mention pricing, free access, Zero One, or The Blade.
- Keep the unified backend and Mailchimp acquisition tagging unchanged.
- Keep the phone, Singapore legal entity, and 2026 copyright; omit Boston and State Street.

---

### Task 1: Reposition the QC access journey

**Files:**
- Modify: `src/components/Content.test.tsx`
- Modify: `src/components/WaitlistForm.test.tsx`
- Modify: `src/components/Hero.tsx`
- Modify: `src/components/Nav.tsx`
- Modify: `src/components/Contact.tsx`
- Modify: `src/components/WaitlistForm.tsx`
- Modify: `src/components/Footer.tsx`

**Interfaces:**
- Consumes: the existing `WaitlistForm` POST contract and `#request-access` page anchor.
- Produces: the same form payloads and phases, with operating-service copy and `Request access` CTAs.

- [ ] **Step 1: Write the failing positioning tests**

Add assertions that the rendered page and all form phases contain `Request access` and do not contain cohort/test-stage language:

```tsx
expect(copy).toMatch(/request access/i);
expect(copy).not.toMatch(/early access|founding cohort|first cohort|beta|pilot|test users/i);
```

Update the interaction helper to click `Request access` and wait for `Your access request is received.`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm.cmd test -- src/components/Content.test.tsx src/components/WaitlistForm.test.tsx`

Expected: FAIL because the current page says `Early access`, `Founding cohort`, and `No cost for the first cohort`.

- [ ] **Step 3: Implement the operating-service copy**

Use these contracts:

```text
Hero badge: AI analysts · Configured for your work
Card label: / Request access
Card heading: Configure an AI analyst for your organization.
Nav/button CTA: Request access
Form acknowledgement: Your access request is received.
Completion: The Quant Cloud team will review your requirements and be in touch to discuss fit and implementation.
```

Change the anchor from `early-access` to `request-access`. Describe engagements as hands-on configured implementations, without public pricing or trial claims. Retain all payload field names and API behavior.

- [ ] **Step 4: Run component tests**

Run: `npm.cmd test -- src`

Expected: 14 tests pass with zero failures.

- [ ] **Step 5: Verify a clean production build**

Build from a clean QC-only copy outside the project root so unrelated untracked projects are not scanned.

Run: `npm.cmd run build`

Expected: Next.js production build exits 0.

- [ ] **Step 6: Commit and deploy**

```powershell
git add -- src/components/Content.test.tsx src/components/WaitlistForm.test.tsx src/components/Hero.tsx src/components/Nav.tsx src/components/Contact.tsx src/components/WaitlistForm.tsx src/components/Footer.tsx docs/superpowers/plans/2026-08-02-qc-access-positioning.md
git commit -m "feat: position QC for access requests"
git push origin main
npx.cmd vercel --prod --yes
```

Verify `https://quantcloud.com/` contains `Request access` and none of the prohibited phrases or Boston address text.
