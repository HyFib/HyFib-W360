#!/usr/bin/env python3
"""Builds docs/FEATURE-MATRIX.md from docs/research/wati-benchmark.md plus our mapping below.

Run from the repository root:  python3 scripts/feature-matrix/build.py
Statuses (never inflate them): planned | implemented | locally verified | sandbox verified |
production verified | externally blocked | unsupported.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / 'docs/research/wati-benchmark.md'
OUT = ROOT / 'docs/FEATURE-MATRIX.md'
MATRIX_DATE = '2026-09-26'

AREA = {
    'Plans & billing': ('5', 'Platform-admin configurable plans, trials, seats, quotas and add-ons; INR prepaid service-credit wallet on an immutable balanced ledger; hosted card top-ups; opt-in auto-recharge on a card mandate.',
                        'Razorpay merchant activation; tax/legal review of wallet terms.',
                        'Financial concurrency and reconciliation suite passes; live test-mode checkout verified.'),
    'Onboarding & numbers': ('2', 'Embedded Signup (Tech Provider) with server-side code exchange, asset ownership checks, number registration and webhook subscription; many WABAs/numbers per company with unique bindings.',
                             'Meta business verification; Tech Provider app review and advanced access; app in live mode.',
                             'An approved test business onboards, registers a number, sends and receives; reconnect/disconnect work.'),
    'Team inbox': ('2–3', 'Shared inbox with assignment, teams, notes, tags, saved replies, SLA timers, collision protection and SSE live updates with replay.',
                   'Connected WhatsApp number.',
                   'Concurrent agents cannot double-assign or double-send; missed events replay after reconnect.'),
    'Contacts & segmentation': ('3', 'Contacts with channel identities (BSUID first, phone optional), custom fields, tags, consent provenance, suppression, import preview and dedupe, dynamic segments.',
                                'Phase 2 messaging identities.',
                                'Import row errors reported; merges are reversible-safe; opt-outs suppress immediately.'),
    'Campaigns': ('3', 'Campaigns with audience snapshots, live consent/suppression re-checks at send time, timezone scheduling, pacing, frequency caps, budget guardrails and per-recipient outcomes.',
                  'Approved templates; connected number; wallet only where HyFib services are billable.',
                  'Opt-outs stop queued sends; cancellation is idempotent; denominators and attribution windows documented.'),
    'Templates': ('3', 'Template drafts with variable/sample validation, submission to Meta, approval/rejection sync by webhook, version history and archive; drafts are never shown as approved.',
                  'Connected WABA with template permissions.',
                  'Status webhooks update templates; campaigns block unapproved templates.'),
    'Ads': ('6', 'Capability-gated advertising integrations; Click-to-WhatsApp referral attribution is captured from inbound webhooks in phase 4.',
            'Meta Marketing API / Conversions API access where used.',
            'Referral data stored per conversation; attribution windows labelled.'),
    'Automation & chatbots': ('4', 'Visual flow editor with typed nodes, immutable published versions, execution logs, replay-safe retries, budgets, test mode and bot/human handoff.',
                              'Phase 2 messaging pipeline.',
                              'Published flows survive restart; handoff prevents competing responses.'),
    'AI': ('6', 'Opt-in AI copilot (drafts, summaries, translation, tagging) with per-company budgets, tenant-scoped retrieval, redacted telemetry and human escalation.',
           'AI provider contract and data-processing review.',
           'Prompt-injection and cross-tenant retrieval tests pass; budgets enforced.'),
    'Channels': ('6', 'Capability-based channel adapter; each channel keeps its own policies and message types.',
                 'Official access for each channel.',
                 'Real integration test per channel.'),
    'Calling': ('6', 'Calling support only after eligibility and permission checks; provider signalling; consent-aware recording if enabled.',
                'Meta Calling API eligibility for the business and number.',
                'Real call placed and received in an approved account.'),
    'Commerce & payments': ('4', 'Catalog connection, product messages, order capture, payment links with verified status; in-chat payments capability-gated; no raw card data stored.',
                            'Commerce Manager catalog; store connector credentials.',
                            'Webhook verification, deduplication and uninstall tested per connector.'),
    'Integrations': ('4–6', 'Connector framework (authenticated setup, verified webhooks, dedupe, sync recovery, mapping, uninstall), then prioritised connectors.',
                     'Partner app registration with each vendor.',
                     'Working connector verified against the vendor sandbox.'),
    'Developer platform': ('5', 'Versioned REST API with scoped hashed keys, quotas, idempotency, pagination, OpenAPI; signed outgoing webhooks with replay and SSRF protection.',
                           '—',
                           'Contract tests; SSRF suite (private ranges, DNS rebinding, redirects, metadata IPs).'),
    'Security & admin': ('1', 'See row detail.', '—', 'See row detail.'),
    'Analytics': ('3', 'Reports with persisted metric definitions, timezone rules, freshness and missing-data semantics; scoped export.',
                  'Phase 2–3 data.',
                  'Metric definitions documented; exports scoped and formula-safe.'),
    'Growth tools': ('4', 'Click-to-chat links, QR codes and a consent-aware website widget.',
                     'Connected number.',
                     'Links and widget open the correct number; consent captured.'),
    'Partners & services': ('6', 'Agency/partner functionality evaluated after core release.', '—', '—'),
}

# Per-capability overrides: (phase, implementation, prerequisite, acceptance, status)
O = {
    'W-010': ('5', 'Prepaid INR service-credit wallet on an append-only double-entry ledger; manual card top-ups through Razorpay Orders + Standard Checkout; credit only from a captured payment fetched from Razorpay (webhook or checkout confirmation), exactly once; refunds and lost disputes recorded from webhooks; holds for billable HyFib services. In the default direct-Meta-billing mode Meta charges the customer directly and the wallet never funds Meta messaging.',
              'Razorpay merchant activation; test-mode keys to verify in the Razorpay sandbox; wallet terms and GST treatment reviewed.', '29 financial integration tests (exactly-once credit under concurrent and reordered webhooks, no credit from authorisation or redirects, late capture, reconciliation, refunds, chargebacks, holds, isolation) and an e2e top-up; Razorpay traffic simulated by a test-only stand-in.', 'implemented'),
    'W-011': ('5', 'Opt-in auto-recharge (disabled by default) on a Razorpay card mandate with threshold, amount, daily/monthly caps counting pending charges; one active attempt per wallet; write-ahead unknown states reconciled by receipt or order payments before any retry; cooldown and suspension after repeated failures; owners notified. Built and tested against a test-only stand-in.',
              'Razorpay Recurring Payments (card mandates) enabled for the merchant; mandate ≤ ₹15,000 to avoid per-debit authentication; bank pre-debit notice delays (≈36–72 h) planned into thresholds.',
              'Concurrent low-balance triggers produce one charge; lost responses reconciled before retry (integration tests with a stand-in).', 'externally blocked'),
    'W-012': ('5', 'Not offered: as a Meta Tech Provider HyFib has no credit line; customers pay Meta directly. HyFib shows cost estimates only. Partner-billed mode stays blocked until a verified partner agreement exists.',
              'Solution Partner status and credit-line agreement with Meta (commercial decision).', 'No Meta charge can reach the wallet in direct mode.', 'externally blocked'),
    'W-013': ('3', 'Versioned rate tables by effective date, region, category and currency; estimates labelled as estimates.',
              'Verify the 2026-10-01 Meta pricing change from Meta’s own rate card.', 'Estimates switch at the effective date; no double charging.', 'planned'),
    'W-016': ('7', 'Custom domains are not in the initial release.', '—', '—', 'planned'),
    'W-017': ('—', 'Dedicated hosting is a commercial arrangement, not a product feature; the deployment docs support single-tenant installs.', '—', '—', 'unsupported'),
    'W-018': ('—', 'Onboarding services are a business offering, not software.', '—', '—', 'unsupported'),
    'W-019': ('—', 'Legacy benchmark add-ons are not replicated.', '—', '—', 'unsupported'),
    'W-020': ('5', 'INR first (India merchant set-up); other currencies later per supported processor.', 'Processor support per currency.', 'Money handled in minor units; no FX.', 'planned'),
    'W-022': ('6', 'Marketing Messages API onboarding only where Meta grants eligibility.', 'Meta eligibility for the business.', 'Eligibility check shown before enablement.', 'externally blocked'),
    'W-023': ('6', 'Coexistence only after explicit eligibility checks; no promise of complete history import.', 'Meta coexistence eligibility (country, number).', 'Eligibility errors surfaced; partial history clearly labelled.', 'externally blocked'),
    'W-024': ('6', 'Number migration flow from another provider following Meta’s documented steps.', 'Meta migration process access.', 'Migrated number keeps templates where Meta allows.', 'planned'),
    'W-026': ('2', 'Guidance in docs/META-SETUP.md and in-app checklist; verification itself happens in Meta Business Manager.', '—', 'Checklist links to Meta.', 'planned'),
    'W-027': ('—', 'Official Business Account status is granted by Meta; we link to guidance only.', 'Meta decision.', '—', 'unsupported'),
    'W-031': ('2', 'Channel identities keep the business-scoped user id (BSUID, contacts[].user_id / parent_user_id) as the primary key per WABA and the phone number (wa_id) as optional data; user-id change system messages update the identity. Sending to contacts known only by BSUID is refused as unsupported until Meta’s request format is verified.',
              'Real Meta webhooks carrying user_id fields.', 'Integration tests: BSUID-only inbound threads correctly; replies to BSUID-only contacts are refused. Fixtures follow docs/research/meta-whatsapp.md, not live traffic.', 'implemented'),
    'W-021': ('2', 'Embedded Signup (v4 JS SDK, config id, code response). Server-side: single-use state bound to member, auth session and company; code exchanged within its 30 s lifetime; debug_token must show our app id, validity and both WhatsApp permissions (and the WABA among target ids when returned); the new token must list the WABA’s numbers including the chosen one; token stored AES-256-GCM encrypted; WABA and number bound through definer functions that refuse assets owned by another company; then subscribe app, register number with a generated PIN, health check.',
              'Meta business verification, Tech Provider app review (whatsapp_business_management, whatsapp_business_messaging), Embedded Signup configuration id.',
              'Integration tests against a local Graph stand-in: success, token for another app, unshared WABA, foreign number, asset owned elsewhere, different browser session, registration blocked (133016). A real sandbox signup has not been performed.', 'implemented'),
    'W-028': ('2', 'Any number of WABAs and numbers per company; each number bound to exactly one company.', 'Meta app review.', 'Schema, bindings and onboarding support several numbers; not exercised against real accounts.', 'implemented'),
    'W-032': ('2–3', 'Shared WhatsApp inbox: Mine / Unassigned / All views, open and resolved lists, thread view, replies inside the 24-hour window, live updates over SSE with durable cursors and polling fallback, per-member-and-company drafts. Other channels arrive in phase 6.',
              '—', 'e2e (desktop and mobile viewports): signed inbound webhook appears live, reply is sent, delivery receipt updates live. Provider traffic simulated by a test-only stand-in.', 'locally verified'),
    'W-034': ('2–3', 'Internal notes per conversation, visible to the team only.', '—', 'Integration test: notes stored and shown; members who cannot see the thread cannot add notes.', 'locally verified'),
    'W-036': ('2–3', 'Open / resolved with optimistic concurrency; a new customer message reopens a resolved conversation. Custom statuses later.', '—', 'Integration tests: stale versions refused; inbound message reopens.', 'locally verified'),
    'W-037': ('2–3', 'Assign to members with optimistic concurrency (agents claim or release; supervisors assign anyone); audited. Team assignment arrives with teams in phase 3.', '—', 'Integration test: two agents claiming at once, exactly one wins; the other loses visibility.', 'locally verified'),
    'W-043': ('6', 'Voice-note transcription as an opt-in AI feature.', 'AI provider review.', 'Transcripts labelled as machine-generated.', 'planned'),
    'W-044': ('3', 'Role-based masking of phone numbers in the inbox and exports.', '—', 'Masked roles never receive full numbers in API responses.', 'planned'),
    'W-045': ('—', 'Native mobile apps are not planned for this release; the web app is responsive and tested on mobile viewports.', '—', 'Mobile viewport e2e passes.', 'unsupported'),
    'W-047': ('6', 'AI-derived satisfaction signals, clearly labelled as estimates; explicit CSAT surveys in phase 3.', 'AI provider review.', '—', 'planned'),
    'W-051': ('6', 'Commerce customer data (orders, spend) as segment filters via store connectors.', 'Store connector.', '—', 'planned'),
    'W-068': ('6', 'AI-assisted template review hints (advisory only).', 'AI provider review.', '—', 'planned'),
    'W-069': ('6', 'AI template drafting with human approval before submission.', 'AI provider review.', '—', 'planned'),
    'W-070': ('3', 'Original starter template library (our own copy).', '—', 'Templates pass Meta validation rules locally.', 'planned'),
    'W-071': ('4', 'Referral (Click-to-WhatsApp) data captured from inbound webhooks and attached to conversations.', 'Meta webhook referral object.', 'Referral stored and reportable.', 'planned'),
    'W-072': ('6', 'Conversion events sent to Meta only with explicit configuration and consent.', 'Meta Conversions API access.', '—', 'planned'),
    'W-074': ('6', 'TikTok messaging ads only with official TikTok access.', 'TikTok partner access.', '—', 'externally blocked'),
    'W-075': ('6', 'Google click-to-message ads only with official access.', 'Google Business Messages successor access (verify availability).', '—', 'externally blocked'),
    'W-082': ('6', 'Instagram automation through the official Instagram messaging API.', 'Meta app permissions for Instagram messaging.', 'Real account test.', 'planned'),
    'W-083': ('6', 'Messenger automation through the official Messenger Platform.', 'Meta app permissions for Messenger.', 'Real Page test.', 'planned'),
    'W-085': ('4', 'WhatsApp Flows lifecycle (draft, publish, deprecate), Flow JSON validation, encrypted data endpoint and response handling — separate from the internal chatbot builder.', 'Flows permission; business encryption key upload.', 'Health check passes; responses mapped to contact fields.', 'planned'),
    'W-092': ('6', 'Tenant-configurable AI agents and bring-your-own-agent endpoints with tool allowlists and approvals; not a separate product.', 'AI provider review.', 'High-impact tool calls require approval.', 'planned'),
    'W-093': ('—', 'Prompt-to-agent builder of a separate benchmark product is not replicated.', '—', '—', 'unsupported'),
    'W-094': ('6', 'Voice agents depend on calling eligibility.', 'Calling API eligibility.', '—', 'externally blocked'),
    'W-095': ('—', 'Benchmark sister-product pricing is not applicable.', '—', '—', 'unsupported'),
    'W-096': ('6', 'One AI provider initially with configurable supported models.', 'Provider contract.', 'Model ids configured, never hard-coded.', 'planned'),
    'W-097': ('2', 'Official WhatsApp Cloud API only: signed webhooks stored durably before acknowledging, attribution through verified asset bindings, idempotent ingestion, monotonic delivery states, durable send intents with retries, rate limits and explicit unknown-outcome handling (never an automatic resend).',
              'Meta app review and business verification; approved test number.', 'Integration and e2e tests against a local Graph stand-in (success, rate limit, permanent error, revoked token, dropped connection, timeout). No message has been exchanged with the real Cloud API yet.', 'implemented'),
    'W-100': ('6', 'TikTok direct messages only with official access.', 'TikTok messaging API access.', '—', 'externally blocked'),
    'W-101': ('6', 'SMS through one provider adapter (fallback and campaigns) where consent allows.', 'SMS provider account and sender registration (e.g. DLT in India).', 'Real SMS delivered in test.', 'planned'),
    'W-102': ('6', 'RCS only with official provider access.', 'RCS provider/agent approval.', '—', 'externally blocked'),
    'W-103': ('4', 'Website widget, links and QR codes (see Growth tools).', 'Connected number.', '—', 'planned'),
    'W-104': ('6', 'Groups only after eligibility checks.', 'Meta Groups API eligibility.', '—', 'externally blocked'),
    'W-114': ('6', 'In-chat payments stay capability-gated; payment links with verified status in phase 4.', 'WhatsApp payments eligibility (India) and payment-gateway set-up.', '—', 'externally blocked'),
    'W-115': ('6', 'Depends on in-chat payments eligibility.', 'As above.', '—', 'externally blocked'),
    'W-119': ('—', 'Benchmark API-quota accounting detail; our API quotas are defined in phase 5.', '—', '—', 'unsupported'),
    'W-123': ('6', 'Backlog connector after prioritised connectors.', 'Vendor partner access.', '—', 'planned'),
    'W-124': ('6', 'Backlog connector after prioritised connectors.', 'Vendor partner access.', '—', 'planned'),
    'W-130': ('6', 'Backlog connector.', 'Vendor partner access.', '—', 'planned'),
    'W-131': ('6', 'Reachable through outgoing webhooks and automation platforms until native connectors are prioritised.', '—', '—', 'planned'),
    'W-133': ('7', 'Partner marketplace after the connector framework matures.', '—', '—', 'planned'),
    'W-141': ('6', 'MCP server exposing scoped, audited tools over the public API.', 'Public API (phase 5).', 'Tool calls respect API-key scopes.', 'planned'),
    'W-142': ('6', 'Self-hostable MCP client configuration for our API.', 'Public API (phase 5).', '—', 'planned'),
    'W-143': ('6', 'Groups API only after eligibility.', 'Meta Groups API eligibility.', '—', 'externally blocked'),
    'W-146': ('1', 'Seven tenant roles (owner, administrator, supervisor, agent, marketer, analyst, billing) with a documented permission matrix enforced in server policy, workers and PostgreSQL RLS.', '—',
              'Permission matrix unit tests; 40 isolation tests; role-limited UI in e2e.', 'locally verified'),
    'W-147': ('1', 'Invitations with 7-day expiry, single use, bound to the invited verified email; resend rotates the token; revoke; suspend/restore/remove members; last-owner protection under concurrency.', '—',
              'Integration tests (acceptance rules, concurrent demotion) and e2e invite/accept flow pass.', 'locally verified'),
    'W-148': ('1', 'TOTP two-factor with backup codes; required for owner, administrator and billing roles after a grace period; company-wide MFA policy.', '—',
              'Grace/blocking logic implemented; enrolment e2e test added.', 'locally verified'),
    'W-149': ('1', 'Append-only company audit log of sensitive actions (members, invitations, settings, platform actions); security events for sign-in anomalies. A per-user login history view is planned.', '—',
              'Audit rows cannot be updated or deleted by runtime roles (tested).', 'implemented'),
    'W-150': ('1/7', 'Per-company isolation via RLS (FORCE), transaction-local context, separate DB roles; backups via managed PostgreSQL PITR with a documented restore drill.', 'Managed PostgreSQL with PITR; restore drill.',
              'Isolation suite passes; restore drill evidence recorded.', 'locally verified'),
    'W-151': ('7', 'Data export/deletion and DPA templates planned; no compliance claim until legal review.', 'Legal review per launch market.', '—', 'planned'),
    'W-152': ('—', 'Certifications are organisational; not claimed by this codebase.', 'Independent audit.', '—', 'unsupported'),
    'W-153': ('—', 'Certifications are organisational; not claimed by this codebase.', 'Independent audit.', '—', 'unsupported'),
    'W-154': ('7', 'Company data_region recorded; region-specific deployments documented. India region first.', 'Hosting in the target region.', '—', 'planned'),
    'W-155': ('7', 'Public security/subprocessor documentation.', 'Legal review.', '—', 'planned'),
    'W-156': ('1', 'TLS in deployment; AES-256-GCM application-level encryption with key ids and rotation for secrets at rest: queued email payloads, WhatsApp business tokens, registration PINs and raw webhook bodies (each bound to its row by AAD).', 'Secret manager for keys.',
              'Crypto unit tests (AAD binding, tamper, rotation).', 'locally verified'),
    'W-159': ('6', 'AI insights labelled as estimates.', 'AI provider review.', '—', 'planned'),
    'W-162': ('6', 'Partner/agency functionality after the core release.', 'Commercial model decision.', '—', 'planned'),
    'W-163': ('—', 'Support channels are a business process.', '—', '—', 'unsupported'),
    'W-164': ('—', 'Professional services are not software.', '—', '—', 'unsupported'),
    'W-048': ('3', 'Company-defined contact fields (text, number, date, yes/no) validated by type; values on the contact, editable in the UI, importable and exportable (the field key is the CSV column). Deleting a field removes its values. One contact per phone number per company.',
              '—', 'Integration tests: typed validation, value removal on field deletion, one contact per number across manual entry, import and concurrent inbound messages; e2e contact creation.', 'locally verified'),
    'W-049': ('3', 'CSV import (≤ 5,000 rows, just under 1 MB, comma/semicolon/tab) with preview, explicit column mapping, international or national number reading (never guessed), optional update of existing contacts (empty cells never erase), tags, row errors reported by row number without row contents, one transaction per import; formula-safe streaming CSV export.',
              '—', 'Integration tests (row errors, duplicates, updates, consent rules, formula neutralisation, round trip) and e2e import + export.', 'locally verified'),
    'W-050': ('3', 'Consent per purpose (marketing; utility) as append-only events with provenance (keyword message, member note, import attestation, Meta error 131050, erasure); current state kept by a database trigger (later event wins, opt-out wins ties and the one-second uncertainty of Meta timestamps). Marketing templates need a recorded opt-in by default; every template send re-checks consent and the suppression list right before dispatch.',
              'Review of Meta’s opt-in guidance (M-131 content not retrieved) and local marketing-consent law per launch market.', 'Integration tests: keyword opt-out/in ordering and replays, ties, append-only history, an opt-out or suppression recorded after queueing stops the send, 131050 recorded; e2e consent recording.', 'locally verified'),
    'W-059': ('3', 'Template drafts (text header, positional variables with examples, footer, quick-reply / website / call buttons) validated locally, submitted write-ahead through the Graph API; a lost create response is adopted by name at the next sync and a submission Meta never received fails after 10 minutes; the paged Graph listing is the source of truth (template webhooks only request a sync); deletion through the Graph API; status history. Media headers, variable URLs and named variables are not supported yet.',
              'Connected WABA with whatsapp_business_management; Meta app review; a real template submitted and approved in a sandbox.', 'Integration tests and an e2e flow against a test-only Graph stand-in (submit, approve, sync, send); not yet exercised against Meta.', 'implemented'),
    'W-061': ('3', 'Marketing and utility categories; Meta’s category from the listing wins (recategorisation is synced). Authentication templates are not supported yet.',
              'Meta app review.', 'Sync updates the category; marketing sends need campaign permission and opt-in.', 'implemented'),
}
CALLING_BLOCKED = {'W-105', 'W-106', 'W-107', 'W-108', 'W-109', 'W-110'}

# HyFib capabilities required by the product specification that the benchmark rows do not cover.
HYFIB = [
    ('H-001', 'Tenancy', 'Multi-company membership with explicit switching', 'URL-scoped company context re-verified per request; full page load on switch; same 404 for non-members and missing companies.', '—', '1', 'e2e cross-company 404; isolation suite.', 'locally verified'),
    ('H-002', 'Tenancy', 'Database-enforced tenant isolation', 'FORCE RLS on every tenant table, transaction-local context that fails closed, column-level grants, SECURITY DEFINER entry points with pinned search_path and explicit per-role EXECUTE grants (none to PUBLIC), runtime-role self-check.', '—', '1', '60 integration tests on PostgreSQL 18 incl. pool reuse, jobs, function privileges and concurrency (CI: PostgreSQL 17 and 18).', 'locally verified'),
    ('H-003', 'Platform', 'Platform administration area', 'Separately authorised (platform staff + MFA); company search; suspend/reactivate with reason recorded in both platform and company audit logs.', '—', '1', 'Integration tests for role limits; UI built.', 'implemented'),
    ('H-004', 'Platform', 'Reasoned, scoped, time-boxed support access', 'Support grants ≤ 8h with reason and scopes; customer data readable only with an active matching grant; visible to the company.', '—', '1', 'Integration tests (scope, expiry, revocation, cross-company).', 'locally verified'),
    ('H-005', 'Platform', 'Account recovery (second-factor reset)', 'Platform operator resets MFA with mandatory reason; signs out all sessions; audited.', 'Out-of-band identity verification procedure.', '1', 'Integration test.', 'locally verified'),
    ('H-006', 'Security', 'Sessions: list, revoke, revoke on password reset', 'Database sessions without cookie cache so revocation is immediate.', '—', '1', 'Manual check; e2e pending.', 'implemented'),
    ('H-007', 'Platform', 'Durable jobs with signed envelopes', 'pg-boss queues declared at deploy; exclusive policies collapse duplicate signals; workers verify signature, company status and actor membership before acting.', '—', '1', 'Integration tests (forgery, substitution, suspension, revocation, transactional enqueue).', 'locally verified'),
    ('H-008', 'Platform', 'Transactional email outbox', 'Encrypted payloads bound to row id, lease-based claiming, sweeper recovery, one SMTP provider adapter.', 'Production SMTP provider account.', '1', 'Integration tests + e2e via Mailpit.', 'locally verified'),
    ('H-009', 'Security', 'CSP nonces and security headers', 'Per-request nonce CSP, HSTS, frame denial, no-store caching for app pages.', '—', '1', 'e2e header assertions.', 'locally verified'),
    ('H-010', 'Billing', 'Per-company billing mode', 'tenants.billing_mode defaults to direct_meta; partner_billed cannot be set by tenant code (column grants).', 'Partner agreement for partner_billed.', '1/5', 'Isolation test: tenant cannot change billing mode.', 'locally verified'),
    ('H-011', 'Inbox', 'SLA timers, business hours, CSAT, collision warnings', 'Per-team SLA targets with business-hour calendars, CSAT surveys after resolution, presence-based collision warnings.', 'Connected number.', '3', 'Timers pause outside business hours; CSAT stored per conversation.', 'planned'),
    ('H-012', 'CRM', 'Deals, pipelines, tasks, reminders, activity history', 'Tenant-owned CRM objects with composite keys and activity timeline.', '—', '4', 'Pipelines per company; reminders via durable jobs.', 'planned'),
    ('H-013', 'Contacts', 'Consent provenance, suppression list, formula-safe export', 'Append-only consent events with source, actor and evidence; company suppression list (adding needs contacts.write, removing needs settings permission); CSV export neutralises formula triggers (=, +, -, @, tab, CR) except validated E.164 numbers.', '—', '3', 'Opt-out and suppression recorded after queueing stop the send (integration); export test with =HYPERLINK payloads (integration and e2e).', 'locally verified'),
    ('H-019', 'Contacts', 'Safe contact merge', 'Merging two contacts keeps identities, conversations and consent history.', '—', '3', 'Merge keeps every identity and the stricter consent.', 'planned'),
    ('H-020', 'Contacts', 'Contact erasure (right to erasure)', 'SECURITY DEFINER app.erase_contact: deletes name, number, email, tags, custom values, identities, notes and media records; redacts message contents and previews; clears recipient ids in status history (a guard trigger allows only that change, only inside the function); cancels queued sends; keeps consent history ending in opt-outs; optionally keeps the number suppressed. Audited; needs contacts.delete.', 'Legal review of retention of consent evidence per market.', '3', 'Integration test covers every table above plus cross-company refusal.', 'locally verified'),
    ('H-014', 'Developer', 'Outgoing tenant webhooks with SSRF protection', 'Signed deliveries, secret rotation, bounded retry, replay; egress guard blocks private/metadata ranges, DNS rebinding and redirects.', '—', '5', 'SSRF suite passes.', 'planned'),
    ('H-015', 'Data', 'Account export and deletion; retention controls', 'Company export, deletion workflow distinguishing app deletion, provider deletion, backup expiry and retained billing records.', 'Legal review.', '5/7', 'Deletion job verified on staging.', 'planned'),
    ('H-016', 'Messaging', 'Reliable webhook ingestion and outbound pipeline', 'Raw-body signature verification (current + previous secret), durable encrypted receipt before 200, asset-mapped tenant resolution, quarantine of unknown or mismatched assets, idempotent consumers, monotonic statuses with immutable history, send intents with lease recovery and unknown-outcome handling, per-number token bucket and fairness groups, retention of raw bodies (7 days) and live events (7 days).', 'Meta app secret and webhook subscription on the production app.', '2', '21 messaging integration tests (duplicates, re-serialised replays, out-of-order and conflicting statuses, orphan statuses, quarantine, cross-company binding, worker loss, retention) and e2e;  provider traffic simulated.', 'implemented'),
    ('H-017', 'Billing', 'Double-entry service-credit ledger', 'Append-only ledger transactions and entries; balances maintained by trigger; a deferred constraint rejects unbalanced postings at commit; runtime roles cannot write ledger rows or balances; every posting goes through a SECURITY DEFINER function keyed by an idempotency key.', '—', '5', 'Integration tests: forged writes refused, unbalanced posting rejected at commit, append-only, trial balance zero after every scenario, concurrent spends never overdraw.', 'locally verified'),
    ('H-018', 'Billing', 'Payment webhook ingestion and reconciliation (Razorpay)', 'X-Razorpay-Signature over the raw body (current + previous secret), durable encrypted receipt before 200, dedupe by event id and body hash, company resolved from our own order/token records, authoritative fetch before any effect, quarantine of unknown orders, reconciliation sweeps for missed webhooks.', 'Razorpay webhook configured on the live and test dashboards.', '5', 'Integration and e2e tests against a test-only stand-in; not yet verified against the Razorpay sandbox.', 'implemented'),
]


def parse_rows(text: str):
    rows = []
    for line in text.splitlines():
        if not line.startswith('| W-'):
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 8:
            continue
        rid, area, cap, desc, tier, sources, evidence, confidence = cells[:8]
        rows.append(dict(id=rid, area=area, cap=cap, desc=desc, sources=sources, evidence=evidence, confidence=confidence))
    return rows


def esc(value: str) -> str:
    return value.replace('|', '\\|').replace('\n', ' ')


def main() -> None:
    rows = parse_rows(RESEARCH.read_text())
    counts: dict[str, int] = {}
    lines = []
    for r in rows:
        phase, impl, prereq, accept = AREA[r['area']]
        status = 'planned'
        if r['id'] in O:
            phase, impl, prereq, accept, status = O[r['id']]
        elif r['id'] in CALLING_BLOCKED:
            status = 'externally blocked'
        counts[status] = counts.get(status, 0) + 1
        sources = ' '.join(f'<{u.strip()}>' for u in r['sources'].split(';') if u.strip().startswith('http'))[:600]
        lines.append(
            f"| {r['id']} | {esc(r['area'])} | {esc(r['cap'])} | {sources or '—'} | {esc(r['evidence'])}; {esc(r['confidence'])} | {esc(impl)} | {esc(prereq)} | {phase} | {esc(accept)} | **{status}** |"
        )
    hy_lines = []
    for hid, area, cap, impl, prereq, phase, accept, status in HYFIB:
        counts[status] = counts.get(status, 0) + 1
        hy_lines.append(f"| {hid} | {area} | {esc(cap)} | Product specification | — | {esc(impl)} | {esc(prereq)} | {phase} | {esc(accept)} | **{status}** |")

    summary = ', '.join(f'{k}: {v}' for k, v in sorted(counts.items()))
    header = f"""# Feature matrix

**Date:** {MATRIX_DATE} · **Benchmark:** WATI public documentation (functional benchmark only; no copied text or assets) · **Generated by** `scripts/feature-matrix/build.py` from `docs/research/wati-benchmark.md`.

> **Evidence caveat.** Direct access to wati.io, developers.facebook.com and razorpay.com was blocked by this build environment's network policy. Benchmark rows come from search-index summaries of official pages (see the research files for method and confidence). Every row must be re-verified against the live source before any external claim. This matrix does **not** claim WATI parity; it records what exists, what is planned, and what is blocked.

## Status legend

| Status | Meaning |
|---|---|
| planned | Designed/backlogged; no working code yet. A UI placeholder never counts as implemented. |
| implemented | Working code with tests where applicable, but not yet independently verified end to end. |
| locally verified | Automated tests pass locally against real PostgreSQL / real browsers (not yet in CI history or a deployed environment). |
| sandbox verified | Verified against a real provider sandbox or approved test account. |
| production verified | Verified in production with real credentials. |
| externally blocked | Requires provider approval, eligibility or commercial access we do not have. |
| unsupported | Deliberately out of scope (reason given). |

**Totals:** {summary}.

## HyFib platform capabilities (from the product specification)

| ID | Area | Capability | Source | Evidence | Our implementation | Prerequisites | Phase | Acceptance criteria | Status |
|---|---|---|---|---|---|---|---|---|---|
"""
    bench = """
## Benchmark capabilities

| ID | Area | Capability (benchmark, paraphrased) | Source URL(s) | Evidence; confidence | Our implementation | Prerequisites | Phase | Acceptance criteria | Status |
|---|---|---|---|---|---|---|---|---|---|
"""
    OUT.write_text(header + '\n'.join(hy_lines) + '\n' + bench + '\n'.join(lines) + '\n')
    print(f'wrote {OUT} ({len(rows)} benchmark rows, {len(HYFIB)} platform rows); {summary}')


if __name__ == '__main__':
    main()
