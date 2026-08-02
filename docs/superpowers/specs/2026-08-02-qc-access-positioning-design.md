# QuantCloud Access Positioning Design

## Objective

Present QuantCloud as an operating AI-research service that accepts access requests for configured analyst engagements. Remove all public language suggesting a founding cohort, beta, test users, free first cohort, or a product still seeking initial validation.

## Positioning

QuantCloud builds AI analysts around an organization's research universe, methods, sources, controls, and output format. The commercial posture is consultative and implementation-led: a prospect requests access, describes a real research mandate, and the QuantCloud team follows up about fit and implementation. Public copy does not mention pricing, free access, testing, or cohort availability.

## Customer Journey

1. The primary CTA is `Request access`.
2. The hero access card invites the visitor to configure an analyst for their organization.
3. The visitor submits a work email and may add research requirements.
4. Confirmation says the request will be reviewed and the QuantCloud team will follow up.
5. The shared backend, database, and Mailchimp acquisition tagging remain unchanged; internal waitlist names are implementation details and never appear to QC visitors.

## Copy Contract

Customer-facing pages and form states must not contain `early access`, `founding cohort`, `first cohort`, `beta`, `pilot`, or `test users`. The page must consistently use `Request access` and describe a real implementation rather than a trial. QuantCloud remains independent in all visitor-facing language, with no Zero One references.

## Footer

The footer retains the telephone number, `Clearsight Systems Pte. Ltd.`, and the fixed 2026 copyright. It does not state that QuantCloud is based in Boston and does not publish the State Street address.

## Verification

Component tests will cover the access-request CTA and confirmation flow, prohibit cohort/test-stage language, preserve the QC-only brand boundary, and prohibit Massachusetts location claims. The relevant test suite and a clean production build must pass before deployment.
