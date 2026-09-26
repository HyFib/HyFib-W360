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

| Step | What                                                                                                                                                                                                                                                                                          | Evidence                                                               | Status                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| 1    | Meta Business portfolio for HyFib with **business verification** (legal name, address, phone, email, website; documents may be requested).                                                                                                                                                    | M-021                                                                  | External — not started   |
| 2    | Meta app (type Business) with the WhatsApp product, legal URLs: privacy policy, terms of service, data deletion instructions/URL, support contact.                                                                                                                                            | M-021, M-133 (deletion callback requirements for WhatsApp unconfirmed) | External                 |
| 3    | **App Review** for advanced access to `whatsapp_business_messaging` (send on behalf of customers) and `whatsapp_business_management` (manage WABAs, numbers, templates). Whether `business_management` is needed for our flow is unconfirmed (only needed for credit-line sharing per M-147). | M-021, M-147                                                           | External                 |
| 4    | **Facebook Login for Business configuration** (produces the `config_id` used by Embedded Signup; replaces `scope`).                                                                                                                                                                           | M-013                                                                  | External                 |
| 5    | App in **live mode**, webhook callback URL `https://<host>/api/webhooks/meta` with verify token, subscribed fields at least `messages`, `message_template_status_update`, `account_update`, `phone_number_quality_update` (verify the current field list).                                    | M-018, M-030s                                                          | Endpoint built (phase 2) |
| 6    | Onboarding capacity: default cap of **10 new customers per rolling 7 days**; raising it (reported as 200) is tied to verification/app review; whether "access verification" is still required conflicts across sources.                                                                       | M-022, M-023                                                           | Unconfirmed              |

## 3. Customer onboarding flow (built in phase 2; sandbox verification pending)

1. An owner/administrator with `channels.manage` opens **Settings → Channels** and clicks **Connect
   WhatsApp number**. The server creates an onboarding session bound to (member, auth session,
   company) with a random 32-byte `state` (stored as a SHA-256 hash, 15-minute expiry, single use).
2. The browser loads Facebook's SDK (allowed by CSP on that page only; COOP there is
   `same-origin-allow-popups` so the popup can message the page) and runs Embedded Signup
   (`FB.login` with `config_id`, `response_type: 'code'`, `override_default_response_type: true`,
   `extras.sessionInfoVersion: '3'`). v2 is deprecated on **2026-10-15** (M-010, M-011, M-013).
3. The `WA_EMBEDDED_SIGNUP` `FINISH` message (accepted only from `facebook.com` origins) provides
   `waba_id`, `phone_number_id` and `business_id`; cancellations are shown to the member.
4. The browser posts `state`, the authorization **code** and the ids to a server action. The server
   claims the session atomically, exchanges the code **server-side within 30 seconds** (M-015) and
   calls `debug_token`: the token must belong to our app id, be valid, include
   `whatsapp_business_management` and `whatsapp_business_messaging`, and, when Meta returns target
   ids for the management permission, include the WABA.
5. Ownership check: the new token must be able to list the WABA's phone numbers and the chosen number
   must be among them. Only then are the WABA and number bound (globally unique active binding; an
   asset bound to another company is refused) and the token stored encrypted (AAD = company +
   WhatsApp account id). The token never reaches the browser or logs.
6. A resumable `channel.onboard` job subscribes our app to the WABA
   (`POST /{WABA_ID}/subscribed_apps`), registers the number (`POST /{PHONE_NUMBER_ID}/register` with a
   six-digit PIN we generate and store encrypted; within **14 days** of signup; error `133016` means
   Meta blocked registration for 72 hours) and reads number health, then marks the number active.
   Completed steps are persisted, so retries resume where they stopped. Not yet built: the payment
   method check and the platform onboarding-failures screen.
7. Every step is audited; failures and the current step are visible in Settings → Channels with
   **Retry setup**. **Disconnect** releases the bindings immediately (routing stops) and erases the
   token when no number of that WABA remains; the number stays registered with Meta.

### Platform configuration checklist

| Variable                         | Where it comes from                                                           |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `META_APP_ID`                    | Meta app dashboard (numeric).                                                 |
| `META_APP_SECRET`                | Meta app dashboard → App settings. Secret manager only.                       |
| `META_APP_SECRET_PREVIOUS`       | Set only during a secret rotation (webhooks signed with either are accepted). |
| `META_GRAPH_API_VERSION`         | `v26.0` today (M-001).                                                        |
| `META_WEBHOOK_VERIFY_TOKEN`      | Random string entered in the app's webhook settings with the callback URL.    |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | Facebook Login for Business configuration id (step 4 of §2).                  |
| `META_SEND_RATE_PER_SECOND`      | Worker only; per-number send rate (default 20, below Meta's default 80).      |
| `META_GRAPH_BASE_URL`            | Never set in staging/production (only a test stand-in may use it).            |

App-secret rotation: set the new secret as `META_APP_SECRET` and the old one as
`META_APP_SECRET_PREVIOUS`, deploy, rotate in Meta, then remove the previous value.

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
