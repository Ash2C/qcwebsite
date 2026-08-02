# Quant Cloud AI Analysts Onboarding Design

## Goal

Reposition quantcloud.com around Quant Cloud's configurable AI analysts and capture early-access registrations in the same onboarding system used by 01.co/analysts. A visitor who arrives through Quant Cloud must experience Quant Cloud branding exclusively, while the shared Mailchimp audience records the original acquisition brand.

## Audience and positioning

Quant Cloud serves research-intensive organizations, including investment firms, advisory teams, research publishers, corporates, industry specialists, and other teams that need rigorous research produced repeatedly.

The product is not limited to US-listed stock coverage. An analyst may cover public companies, private companies, industries, themes, technologies, or a defined research universe. Outputs may support internal decisions or be prepared for public distribution. The site must not frame public research as "marketing content" or promise investment advice.

The homepage thesis is: Quant Cloud builds AI analysts around the research universe, methods, data, workflow, and output format of each client. The primary action is "Request early access."

## Chosen architecture

Quant Cloud owns the public form, copy, visual treatment, interaction states, and confirmation language. Its server-side `/api/analysts-waitlist` route validates and normalizes the request, fixes the acquisition source to Quant Cloud, and forwards the payload to the existing Zero One analyst-waitlist API. The browser never redirects to or embeds a Zero One page.

The existing shared onboarding endpoint remains the source of truth for the waitlist database, Mailchimp audience, and optional qualification data. It maps trusted source families to one of two stable Mailchimp acquisition tags:

- `Acquisition: Zero One`
- `Acquisition: QC Website`

Every member also receives the shared `Analysts Waitlist` tag. Free-form source detail remains in the waitlist record for campaign attribution, but only the two controlled acquisition tags reach Mailchimp.

This server-to-server bridge is preferred over duplicating Mailchimp credentials and database logic in the QC app. It is also preferred over embedding the existing form, which would leak Zero One branding and couple the QC experience to another site's presentation.

## User experience

The first viewport presents the broader AI-analyst proposition and contains step one of the signup:

1. The visitor enters a work email and chooses "Request early access."
2. A successful first step immediately confirms that the visitor is on the Quant Cloud early-access list.
3. The same area then offers optional qualification fields: organization type, research-universe size, preferred delivery channel, and a free-text description of the research they need produced.
4. The visitor may send those details or skip them. Either path ends with a QC-branded confirmation.

No QC text mentions Zero One, The Blade, or a Zero One representative. The QC form will not expose the optional Zero One newsletter opt-in.

The rest of the page explains:

- what an AI analyst can cover and produce;
- how it adapts to a firm's sources, methods, review standards, and house format;
- use across internal research and publication-ready output;
- secure delivery and deployment options;
- the limited, hands-on early-access model;
- broader buyer categories without narrowing the product to fund managers.

The current consulting capabilities and contact path remain available lower on the page, but the early-access CTA becomes primary in the navigation, hero, and final section.

## Brand and visual direction

Retain the existing Quant Cloud dark ink, cyan signal color, grid texture, Inter body type, and JetBrains Mono utility labels. The signature element is a restrained "coverage field" in the hero: a compact visual showing different research objects flowing into one analyst output system. It communicates breadth without generic AI imagery.

Motion remains limited to the existing entrance and viewport transitions, with reduced-motion behavior respected. Forms use visible labels or accessible names, clear focus states, mobile-first stacking, and concise error text.

## Data and privacy behavior

- Email is required, trimmed, lowercased, and validated on both QC and the shared service.
- A honeypot silently accepts bot submissions without storing them.
- The QC proxy never accepts a client-selected acquisition brand; it always forwards `qc-website`.
- Qualification fields are optional and length-limited by the shared API.
- Duplicate emails are idempotent.
- The waitlist database write is authoritative. Mailchimp tagging and notifications stay best-effort so a vendor outage does not lose a lead.
- Step-two failure does not undo a successful email registration, but the QC UI tells the user when optional details could not be saved and lets them retry or finish.

## Testing and release

Automated tests will cover QC request validation, fixed-source forwarding, upstream failure handling, and the shared endpoint's acquisition-tag mapping. Existing Zero One waitlist tests must remain green. Both production builds must pass.

After deployment, production verification will confirm:

- quantcloud.com serves the new messaging and hero form;
- QC-visible pages and form states contain no Zero One wording;
- invalid email is rejected;
- a controlled production signup reaches the shared endpoint with the QC acquisition tag (without creating a disposable live subscriber unless a safe test address is already configured);
- 01.co/analysts remains operational and its signups map to the Zero One acquisition tag.

## Out of scope

- Separate QC and Zero One audiences
- A customer login or analyst application
- Pricing and paid checkout
- A new CRM or database
- A claim that AI output is investment advice
- A full redesign of unrelated Zero One pages
