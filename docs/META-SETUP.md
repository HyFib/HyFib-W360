# Meta (WhatsApp Business Platform) setup

Last updated 2026-09-26. Sources: `docs/research/meta-whatsapp.md` (claims M-001…M-148 with URLs,
evidence type and confidence). **Direct access to developers.facebook.com was blocked while this was
written; every step must be re-checked against Meta's live documentation before use.** Approvals
cannot be produced by code: business verification, app review and access levels are Meta decisions.

## 1. Model

HyFib W360 onboards customer businesses as a **Meta Tech Provider** using **Embedded Signup**. Each
customer owns its WhatsApp Business Account (WABA) and phone numbers, adds its **own payment method**
and is billed by Meta directly. Tech Providers use business integration system-user (BISU) tokens
obtained per customer from the Embedded Signup code exchange (M-016, M-142). Becoming a Solution
Partner (credit lines, billing Meta charges) is a separate commercial programme (ADR-011).

## 2. One-time platform prerequisites (HyFib)

| Step | What                                                                                                                                                                                                                                                                                          | Evidence                                                               | Status                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------- |
| 1    | Meta Business portfolio for HyFib with **business verification** (legal name, address, phone, email, website; documents may be requested).                                                                                                                                                    | M-021                                                                  | External — not started      |
| 2    | Meta app (type Business) with the WhatsApp product, legal URLs: privacy policy, terms of service, data deletion instructions/URL, support contact.                                                                                                                                            | M-021, M-133 (deletion callback requirements for WhatsApp unconfirmed) | External                    |
| 3    | **App Review** for advanced access to `whatsapp_business_messaging` (send on behalf of customers) and `whatsapp_business_management` (manage WABAs, numbers, templates). Whether `business_management` is needed for our flow is unconfirmed (only needed for credit-line sharing per M-147). | M-021, M-147                                                           | External                    |
| 4    | **Facebook Login for Business configuration** (produces the `config_id` used by Embedded Signup; replaces `scope`).                                                                                                                                                                           | M-013                                                                  | External                    |
| 5    | App in **live mode**, webhook callback URL `https://<host>/api/webhooks/meta` with verify token, subscribed fields at least `messages`, `message_template_status_update`, `account_update`, `phone_number_quality_update` (verify the current field list).                                    | M-018, M-030s                                                          | Endpoint designed (phase 2) |
| 6    | Onboarding capacity: default cap of **10 new customers per rolling 7 days**; raising it (reported as 200) is tied to verification/app review; whether "access verification" is still required conflicts across sources.                                                                       | M-022, M-023                                                           | Unconfirmed                 |

## 3. Customer onboarding flow (to implement in phase 2)

1. An owner/administrator with `channels.manage` clicks **Connect WhatsApp** inside their company.
   The server creates an onboarding session bound to (user, session, company) with a random `state`.
2. The browser runs Embedded Signup **v4** (`FB.login` with `config_id`, `response_type: 'code'`,
   `override_default_response_type: true`, `extras` per current docs). v2 is deprecated on
   **2026-10-15** (M-010, M-011, M-013).
3. The session-info message event provides `waba_id`, `phone_number_id` and `business_id`; FINISH
   and closing on the final screen are both treated as completion; cancellations are recorded.
4. The browser posts the authorization **code** and `state` to our server, which exchanges the code
   **server-side within 30 seconds** (M-143) for a BISU token. The token is encrypted with the
   keyring (AAD = company + credential id) and never sent to the browser.
5. Ownership check: before binding, the server confirms (with the new token) that the WABA and phone
   number are accessible to it; the (provider, external id) binding is globally unique, so an asset
   already bound to another company is refused (confused-deputy protection).
6. A resumable, idempotent onboarding job then: subscribes our app to the WABA
   (`POST /{WABA_ID}/subscribed_apps`), registers the number (`POST /{PHONE_NUMBER_ID}/register`
   with a PIN we generate and store encrypted; within **14 days** of signup; limited attempts),
   checks number health and the customer's payment method, and marks the channel live (M-017).
7. Every step is audited; failures are visible in the company's channel settings and in the
   platform onboarding-failures screen with retry.

## 4. Runtime obligations

- **Graph API version:** pin `META_GRAPH_API_VERSION` (current **v26.0**, M-001–M-008); upgrade yearly.
- **Webhooks:** verify `X-Hub-Signature-256` on the raw body; respond 200 only after durable storage;
  Meta retries for up to 7 days; duplicates, reordering and contradictory statuses occur; payloads
  can reach ~3 MB; `played` status exists for voice messages (M-030 family).
- **Identity:** contacts may arrive with a business-scoped user id (`user_id`/BSUID) and no phone
  number; store `parent_user_id`; handle user id/number change system messages (M-110 family).
- **Sending:** no documented idempotency key on `/messages` → outbox with our own ids and
  unknown-outcome handling; default throughput 80 msg/s per number; ~1 message per 6 s per recipient
  (pair rate limit); messaging limits are per **business portfolio** since 2025-10-07
  (`whatsapp_business_manager_messaging_limit`).
- **Pricing (effective 2026-10-01, verify):** per-message pricing by category and market; service
  messages beyond 1,000 per number per month and utility templates inside the customer service window
  become billable; businesses without a payment method stop receiving delivery of service messages.
  Record the `pricing` object from status webhooks; reconcile with pricing analytics.
- **Media:** webhook media ids downloadable for 7 days; download URLs valid ~5 minutes; copy media
  to our private storage under our retention policy.
- **Tokens:** check with `debug_token` periodically; treat error 190 or a lost WABA subscription as
  possible deauthorization (explicit deauthorization signals are unconfirmed, M-146).
- **Restricted capabilities** (coexistence with the WhatsApp Business App, history sync, groups,
  calling, payments, Marketing Messages API) require explicit eligibility checks; never promise
  complete chat history import.

## 5. Open questions to resolve with Meta before launch

1. Current requirements for raising the onboarding cap (access verification vs business verification).
2. Exact data-deletion and deauthorization callback requirements for WhatsApp Business apps.
3. Whether Tech Providers may re-bill or mark up Meta charges (we assume **not**).
4. `biz_opaque_callback_data` (or equivalent) support per message type for correlating sends.
5. BSUID send semantics (`recipient` vs `to`) and go-live dates per message type.
