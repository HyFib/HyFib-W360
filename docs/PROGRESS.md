# Progress

## 2026-09-27 — Phase 4: CRM (P4-04)

Status: **CRM implemented and locally verified, production blocked on email delivery only.**
Pipelines, deals, tasks, notes, the timeline and the deal reports work on HyFib's own data and send
nothing to Meta. Task reminders are emailed through the outbox; locally they arrive in Mailpit, and
delivery through the production SMTP provider is a release item.

### Completed

- **Schema (migration 0013):** pipelines with one ISO 4217 currency each (no runtime UPDATE grant)
  and ordered stages, both archived instead of deleted; deals (a contact for life, optionally the
  conversation they came from, a value in the currency's minor unit, owner, open/won/lost with a
  lost reason, expected close date, version); tasks (assignee, optionally a contact or one of its
  deals, due and reminder times, reminder state with the reason when skipped); the append-only
  timeline (a trigger refuses edits and deletes except inside contact erasure). Composite foreign
  keys keep references in the company, a deal's stage in its pipeline and a task's or entry's deal
  on the same contact. `ops.crm_reminders_due` (definer, ids of active companies only);
  `app.erase_contact` replaced to delete the contact's timeline, notes and tasks and blank deal
  titles and lost reasons; four metric definitions (deal outcomes v2, win rate, time to win, open
  pipeline).
- **Service:** pipelines (`tenant.settings.manage`, audited, 20 in use at most; removed stages are
  archived only when empty), deals (from a contact or a conversation the member can see; edit,
  move, won/lost/reopen), the board with owner filters and per-stage totals, tasks (mine or
  everyone's, open or closed; done, cancel, reopen, edit), notes, contact and deal timelines, and
  the member's overdue and due-today counts. Every change locks the row, checks its version and
  appends its timeline entry in one transaction. Amounts are parsed exactly (no floats) with the
  currency's ISO decimals.
- **Reminders (queue `crm.reminder`):** a delayed job at the reminder time and the minute sweep for
  lost jobs; the email is queued in the transaction that marks the reminder sent, so it goes out
  once; skipped with a reason when the task closed, the assignee lost CRM access or it is more than
  a day late.
- **Web:** CRM in the navigation (board, won and lost lists, deal page, tasks page),
  Settings → Pipelines, a CRM card on the contact page and next to the conversation in the inbox
  (deals, open tasks, timeline; add a deal, task or note), a "Your tasks" card on the overview,
  and a Deals section with CSV export in Reports. Task times are wall-clock times in the company
  time zone.
- **Found while building:**
  - The money helpers caught and hid errors (falling back to two decimals or a plain string); they
    no longer catch anything, since currency codes are validated when a pipeline is created.
  - "End of today" for due-today counts drifted by up to an hour on daylight-saving days; it is now
    computed from the calendar (unit tests for 23- and 25-hour days).
  - The contact CRM view returned an empty result for another company's contact; it now answers
    "not found", like every other lookup.
  - The pipeline limit counts pipelines in use, not archived ones; the settings page said otherwise.
- **Review fixes (independent review of the slice):**
  - A note, task or deal written while the contact was being erased could survive the erasure (and
    a deal change during an erasure could deadlock with it, or leave a timeline entry). Every CRM
    write now takes a key-share lock on the contact before its deal or task, in erasure's order.
  - A deal created, moved or reopened while an administrator removed its stage (or archived the
    pipeline) could end up open in an archived stage, off the board. Deal writers now share the
    pipeline row, which settings changes lock before counting open deals; a first attempt that also
    locked the stage rows deadlocked with settings changes in the new test and was replaced.
  - A closed deal whose stage had been removed could never be reopened (stages cannot be restored);
    it now reopens in the pipeline's first stage.
  - The deal owner list hid an owner who had lost CRM access; "Deal saved.", "Task saved." and
    "Pipeline saved." vanished when the saved form reloaded; the won and lost lists stopped at 50
    with no way further and their cursor dropped microseconds (skipping deals changed in the same
    millisecond); an impossible date such as 31 February caused an internal error instead of a
    validation message.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test` (unit)                                                          | 124 passed. New: 7 CRM tests — ISO currencies and decimals, exact parsing and its refusals, round trips and formatting, day boundaries across daylight-saving changes and month and year ends                                                                                                                                                                                                                                                                                                                                     |
| `pnpm test:integration` (PostgreSQL 18.x)                                   | 219 passed, including CRM 14: pipelines (settings, audit, archive and restore, limit), deals (stage moves, won/lost/reopen, versions, timeline), conversation visibility, notes and tasks on the timeline, reminders emailed exactly once with a fixed clock and their skips, the sweep, erasure (also racing a note and a change, with locks held on a second connection), a stage removed while a deal is created, reopening into a removed stage, paging through deals changed at the same moment, the deals report, isolation |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 36 passed (18 tests × 2), including a pipeline created in settings, a deal added from a contact and from a conversation, a stage move, a task whose reminder email arrives in Mailpit, a note, a win, the board, the tasks page and the reports, with no horizontal overflow on the new pages                                                                                                                                                                                                                      |

Firefox and WebKit run in CI only (not available in this environment).

### Known gaps

- Not built: custom deal fields, products on deals, deal import and export, forecasting, moving a
  deal to another pipeline from the UI (the service supports it), automation steps that create
  deals or tasks, and CRM connectors.
- Reminder emails have been delivered only to Mailpit; a production SMTP delivery is a release item.

## 2026-09-27 — Phase 4: automation engine (P4-01)

Status: **automation engine implemented and locally verified, production blocked.** Runs, the
hand-off to people, restart recovery and reports work on HyFib's own data. Bot messages, including
reply buttons with a header and footer, are verified only against the test-only Graph stand-in,
which checks them against the limits in Meta's OpenAPI spec; a real sandbox run is a release item.
The Phase 4 gate is partly met: "published flow survives restart" and "handoff" are verified
locally; "integration idempotency" waits for the HTTP step (P4-02) and commerce (P4-06).

### Completed

- **Schema (migration 0011):** automations with an editable draft (trigger, steps, number);
  immutable versions (published, and test snapshots of the draft) with a definition hash; runs
  pinned to a version with a durable position (current step, visits, wait state, captured answers,
  budget counters, consecutive failures); an append-only step log; one active run per conversation
  (partial unique index). Reply turns gain a start reason (customer or hand-off) and an `automated`
  end, and the turn trigger skips conversations an automation is handling.
  `ops.conversations_to_route` skips them too; `ops.automation_runs_due` and
  `ops.apply_automation_retention` are new definer functions (ids only). Contact erasure clears
  captured answers and stops the contact's active runs. Twelve metric definition rows: new versions
  of the inbox and member figures that leave automated time out, plus automation runs and outcomes.
- **Model and interpreter (browser-safe):** eight step types (message, question with reply buttons,
  question with a typed answer and format check, condition, contact update, wait, hand-off, end);
  checks for missing and unreachable steps, unknown teams, fields and placeholders, WhatsApp's
  interactive limits and loops that never wait. A pure interpreter is shared by the worker and the
  simulator. Reply-button ids name the run, step and visit; a typed reply equal to a button title
  counts as that button.
- **Dispatch and runner:** ingestion hands a reply to a waiting run, or starts the best matching
  automation (exact keyword, contained keyword, new conversation, any message). A run starts only
  in an unassigned conversation of an active company, subject to business-hours filters, cooldowns
  and 10 runs per conversation per hour.
  - Each step is one transaction (conversation lock, then run lock).
  - Bot messages go through the normal send pipeline, with window, number and WhatsApp id checks.
  - Budgets of 200 steps, 20 visits per step, 50 messages and 7 days.
  - A step that keeps raising an error fails the run after five attempts.
  - The minute sweep re-signals overdue runs and applies retention.
  - Suspended companies defer runs; test runs stop when the tester leaves or loses permission.
- **Hand-off lock:** a member's reply or template send, an assignment, Take over or a resolve ends
  the run and cancels its unclaimed bot sends. Routing skips conversations an automation handles. A
  run that hands off routes the conversation (to a chosen team, or like a new conversation) and opens
  a hand-off turn.
- **Web:**
  - Automations list and editor: trigger, steps with per-step fields, live checks and a generated
    diagram.
  - An in-browser simulator.
  - Save, publish with a note, pause, turn on, archive, restore and delete draft.
  - Test runs on a real conversation, and versions.
  - Run list and run pages with step logs and captured answers (captured answers only for members
    who can see the conversation).
  - Inbox: an "Automation" badge, labelled bot messages and a banner with Take over.
  - Reports → Automations: outcomes, failures by reason, per automation and per day, and a CSV
    export.
- **Found while building:**
  - The definer role could not read columns used in erasure's `CASE` expressions, so erasure now
    updates runs in two statements.
  - Erasure now locks conversations before contacts (the order every writer uses), avoiding a
    deadlock with the runner.
  - `GROUPING()` rejects parameterised expressions, so report rows are told apart by their null
    columns.
  - Versions of a metric definition must stay adjacent in the registry.
  - Mobile layouts needed `minmax(0,1fr)` columns.
  - A step that kept raising an error would have held the conversation for up to seven days; it now
    fails after five attempts.
- **Review fixes (Codex on PR #5):**
  - A run moved on (or completed) as soon as its message was queued, even if Meta then rejected it.
    Runs now wait for Meta to accept each message (migration 0012 records the pending message; the
    send worker signals the run when the send is settled). A rejected, cancelled, unknown or late
    message, or a failure Meta reports later, fails the run with `send_failed` and hands the
    conversation to people.
  - A marketing opt-out keyword was taken as the answer to a waiting question; any opt-out now stops
    the run.
  - An answer used before the question that saves it (for example in the first message) passed the
    checks. Answers are now checked along the paths that reach each step: never saved there is an
    error, saved on only some paths a warning ("is set" rules excepted).
  - Each bot message now takes a send job and an automation signal, so the worker polls the
    webhook, send and automation queues every second instead of every two.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test` (unit)                                                          | 117 passed. New: 13 automation tests — graph checks (targets, reachability, answers saved on the way to each step, loops, teams and fields, WhatsApp limits), trigger ranking, and the interpreter (taps, typed titles, stale and forged ids, answers and formats, conditions, timers, budgets, placeholders)                                                                                                                                                                        |
| `pnpm test:integration` (PostgreSQL 18.x)                                   | 205 passed, including automations 15: versions and pinning, roles, a full flow with a team hand-off, no competing replies, hours, cooldown and hourly cap, concurrent arrivals, crash and lost-signal recovery with real pg-boss consumers, a step that keeps failing, Meta rejecting, later failing or not accepting a message, timers and budgets, opt-outs (all and marketing), erasure, test runs (and a tester losing permission), reports, suspension and retention, isolation |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 32 passed (16 tests × 2), including an automation built in the editor, tried in the simulator, published with a note, run by the worker from a signed webhook, a typed button title handing over to people, the run log, Take over, the automation report and pause, with no horizontal overflow on the new pages                                                                                                                                                     |

### Known gaps

- Not built: the HTTP step (P4-02), Flows and catalog steps, starting runs from the API or
  campaigns, template follow-ups outside the service window, fuzzy keywords, a drag-and-drop
  canvas, and usage billing for automations.
- No run on a real WhatsApp number yet (release checklist). Migration 0011 re-checks the reply-turn
  constraints under a table lock; rehearse it on production-sized data.

## 2026-09-26 — Phase 3: inbox teams, routing, business hours, CSAT (P3-06)

Status: **implementation complete for the advanced inbox, production blocked** (routing, timers,
saved replies and mentions work on HyFib's own data; CSAT surveys are WhatsApp interactive messages
verified only against the test-only Graph stand-in, which checks them against the limits in Meta's
OpenAPI spec; a real tap from a sandbox number is a release item).

### Completed

- **Schema (migrations 0009, 0010):** teams, team members and member availability;
  `conversations.team_id` and a number's default team (`channel_accounts.default_team_id`);
  business hours and closed days; `app.conversation_cases` (open → resolve, maintained by triggers,
  immutable once resolved); saved replies; note mentions (deleted with their note); CSAT surveys
  (sent or skipped with a reason, first answer only, guarded by a trigger); the reply-turn trigger
  ignores CSAT taps; `ops.conversations_to_route` (definer, ids only) for the routing sweep; eleven
  metric definition rows (four new versions whose text said business hours were not supported, and
  business-hours first response, overdue, resolution time, CSAT surveys, response rate, score and
  CSAT per member). The team index is built concurrently in its own migration.
- **Routing:** keyword teams (whole words, any script) before the number's team; round robin to
  the next available member below the team's limit; one advisory lock per company; a minute sweep;
  immediate routing when a member becomes available or a team is saved; release of a member's
  conversations when they are suspended, removed, leave or lose inbox access; routing decisions in
  the audit log. Teams never change visibility (ADR-029).
- **Business hours and timers:** weekly ranges and closed days in the company time zone
  (daylight-saving aware); reply-due timers in the inbox list and thread, paused outside business
  hours; a longest-waiting order; team, number and customer filters.
- **Reports:** first response in business hours, overdue now, answered within target counted in
  business hours when business hours are on, resolution times from cases, a CSAT section with
  delivered and answered denominators and skip reasons, CSAT per member, new CSV columns and a CSAT
  export.
- **Saved replies, mentions, collisions:** supervisors manage saved replies with `{{name}}`,
  `{{agent}}` and `{{company}}` placeholders filled for the conversation; notes mention members who
  can see the conversation (Inbox → Mentions with an unread count); a reply is refused once when
  another member replied after the sender's last seen message.
- **CSAT:** on resolve, one question with three reply buttons inside the service window for contacts
  who have not opted out, at most once a day per conversation, re-checked at send time; the first
  tap matching the survey's button id and message context is recorded; taps never reopen the
  conversation, start a reply turn or count as keywords or campaign replies. Research rows M-157
  and M-158 record the reply-button limits and webhook shape from Meta's OpenAPI spec, fetched
  directly from GitHub (developers.facebook.com is blocked here).
- **Web:** Settings → Inbox (target, business hours, closed days, CSAT), Settings → Teams (teams,
  routing, who is taking conversations), Settings → Saved replies; inbox availability switch, filters,
  mentions view, timers, team control, saved-reply picker, mention picker, CSAT status and messages;
  reports sections. The response target moved from Settings → Messaging to Settings → Inbox.
- **Found while testing:** paging through the longest-waiting order repeated the first row on the
  next page, because turn start times carry microseconds and cursors milliseconds; the order and
  cursor now use millisecond-truncated times. Drizzle writes `FOR UPDATE OF` with a schema-qualified
  table name, which PostgreSQL rejects; the CSAT answer lock uses a plain row lock instead.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                               |
| `pnpm test` (unit)                                           | 104 passed (adds business-time arithmetic across closing times, weekends, closed days and 23/25-hour days, open/closed status, paused timers, range parsing, keyword matching and rotation)                                                                                                                                                                                                  |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 190 passed: inbox advanced 14 (teams, number and keyword routing, rotation, limits with six simultaneous customers, the sweep, release on suspension, team moves, cases, list filters and timers, saved replies, mentions, collisions), CSAT 6, reports 16 (adds business-hours figures, resolution times and CSAT against hand-computed values with a fixed clock), plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 30 passed (15 tests × 2), including settings for business hours, closed days, CSAT, a round-robin team and a saved reply, routing to the available owner, the team filter, a saved reply sent, the CSAT question and a tap, the CSAT report, and no horizontal overflow on the new pages                                                                                                     |

### Known gaps (tracked in BACKLOG.md)

Per-team SLA targets and calendars, breach notifications, presence and typing indicators,
conversation tags, private team queues, mention emails, CSAT outside the service window, a CSAT run
with a real WABA.

## 2026-09-26 — Phase 3: reports (P3-05)

Status: **implementation complete for reports, production blocked** (every number is computed from
HyFib's own records, so reports are only as real as the messaging behind them: delivery statuses
and pricing come from Meta's webhooks, verified here only with the test-only Graph stand-in; cost
estimates need platform staff to publish Meta's current rate cards, none ship with HyFib).

### Completed

- **Schema (migrations 0007, 0008):** `ops.metric_definitions` (what each number counts,
  denominator, window, time-zone rule, missing-data semantics, freshness; immutable, versioned, and
  kept identical to the registry in `packages/domain/src/reports/definitions.ts` by a test);
  `app.conversation_turns` (reply turns: start at the first customer message without a member reply,
  end on a member reply or when the conversation is resolved) maintained by triggers on
  `app.messages` and `app.conversations`, so every write path is covered; the company's
  first-response target; `campaigns.estimate_currency`; a `(tenant_id, created_at)` index on
  messages built concurrently in its own migration.
- **Reports service:** one repeatable-read, read-only snapshot per report, periods of whole days in
  the company's time zone (daylight-saving days have their real length; a skipped midnight starts
  the day at its first real instant; at most 92 days):
  - messaging outcomes by day and sender with explicit denominators, and Meta's failure codes;
  - estimated Meta charges: delivered messages Meta marked billable, priced at the list price of the
    published rate card in force when each message was recorded, by the recipient's market and
    Meta's pricing category; free and not-yet-priced messages, and each reason a billable message
    could not be priced, are listed instead of guessed;
  - inbox queue now (open, unassigned, waiting, longest wait, reply windows closing, waiting past the
    target, by assignee) and reply turns of the period (median and 90th-percentile first response,
    share within the target, resolved without a reply, reply-time spread, per day);
  - member activity (replies and templates sent, turns answered first with their median, resolves
    from the audit log; members who can reply are listed even when quiet);
  - campaign funnels for campaigns started in the period;
  - automation outcomes, deal outcomes and retention cohorts reported as not available, with the
    reason.
- **Exports:** one CSV per section, formula-safe, `reports.export` only, audited before any data is
  returned (`report.exported` with the period).
- **Inbox:** resolving or reopening a conversation is audited (`conversation.status_changed`);
  Settings → Messaging → Inbox response target.
- **Web:** Reports page (period presets and custom dates, the sections above, definitions of every
  number) and export route; the Reports module is now available.
- **Found while building and testing:**
  - a campaign's estimates used the company's current billing currency on every tick, so changing
    the currency during a run would have mixed currencies; the currency is now fixed per campaign
    the first time it is known;
  - the inbox live stream started "now", so a message arriving between the page render and the
    browser connecting stayed hidden until the next event; pages now pass the event-log position
    read before loading their data and the stream replays from there;
  - several pages scrolled sideways on phones (grids let wide tables stretch the page, header
    buttons did not wrap); 17 company pages (lists, forms and settings) were measured at 412 px
    and now fit, and e2e tests assert no horizontal overflow on the reports and contacts pages
    (detail pages were not measured);
  - the integration fixture minted WhatsApp ids from a per-file counter, so two test files could
    collide (seen once on PostgreSQL 17 in CI); ids are now random.
- **Review findings on the campaigns slice (PR #4), fixed with regression tests:**
  - when the member whose authority a campaign used left, sends the worker rejected stayed
    "queued" with failed messages and the pause did not release the rest, so a resumed campaign
    never reached those recipients; rejected and unclaimed sends now return their recipients to
    pending (also after a company suspension) and the counters are recomputed;
  - opt-outs were credited to the last campaign message even when it had failed, and reply and
    opt-out rates could exceed their delivered denominator; only messages WhatsApp accepted are
    credited now, rates count delivered recipients only, and a 131050 failure is recorded before
    its opt-out so the failing message itself is never credited.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                     |
| `pnpm test` (unit)                                           | 96 passed (adds report periods: presets, company date, 23- and 25-hour days, skipped midnights, validation; exact export amounts)                                                                                                                                                                                                  |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 166 passed: reports 12 (definitions persisted = registry and immutable, turns through real ingest/reply/resolve paths and immutable, report numbers against hand-computed values, exports and permissions, isolation), campaigns 17 (adds the launcher-removed regression and failed-message attribution), plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 28 passed (14 tests × 2), including a response target set, two customers writing, one answered, the report's numbers, a CSV export and a rejected over-long period                                                                                                                                                                 |

### Known gaps (tracked in BACKLOG.md)

Business-hours calendars for response times; reconciling estimates with Meta's
`pricing_analytics` (research M-078, not verified); automation, deal and retention reports (their
modules are not built); scheduled report emails.

## 2026-09-26 — Phase 3: campaigns and saved segments (P3-04)

Status: **implementation complete for campaigns and segments, production blocked** (campaign
sends are verified only against the test-only Graph stand-in; a real Meta app, app review and a
sandbox WABA with test recipients are external prerequisites; cost estimates need platform staff to
copy Meta's current rate cards, none ship with HyFib; the 10,000-recipient run happened locally, not
in staging). Reports (P3-05) are not built yet.

### Completed

- **Schema (migration 0006):** segments; campaigns (template, number, variable mapping, audience,
  wall-clock schedule, window, pacing, caps, approval, lifecycle, counters); campaign recipients (ids
  and outcomes only) and campaign history (append-only); `messages.campaign_id`; company campaign
  settings (approval, marketing frequency cap, estimate currency); platform rate cards (immutable
  once published, guarded by triggers); `ops.campaigns_due` (definer, app role only). **Found by the
  10,000-recipient test:** with statistics stale after a bulk import, the planner used the
  `(tenant_id, purpose, status)` consent index and the `(tenant_id, whatsapp_account_id, wa_id)`
  identity index for per-contact lookups, making the snapshot quadratic (6.4 s and 1.7 M buffer hits
  for 10,000 contacts, a statement timeout in the test). The migration drops that consent index and
  adds a per-contact identity index; the same query now takes about 0.1 s.
- **Segments:** tags, consent, typed custom fields, creation date (company time zone), source, recent
  inbound messages, calling code and campaign responses (retargeting), all/any, parameterised SQL,
  preview, version-checked edits, archive.
- **Campaigns:** draft editor with a live preview and a review panel; submission freezes the
  audience; optional four-eyes approval; scheduling in IANA time zones (gaps move forward, repeated
  times use the first occurrence); sending window; deadline; pacing; marketing frequency cap; message
  and estimated spending caps; pause/resume (resumer takes over); idempotent cancel; test sends to
  existing contacts through the normal consent checks; per-recipient outcomes, last-touch reply and
  opt-out attribution within 72 hours, results with explicit denominators, failure codes explained,
  formula-safe audited CSV export.
- **Runner:** `campaign.run` ticks under the campaign's row lock and a per-company advisory lock,
  re-check each recipient with fresh data and queue ordinary messages through the Phase 2 pipeline
  (batch insert of messages, intents and jobs); the send worker refuses messages of paused or
  cancelled campaigns; the messaging sweep re-signals lost ticks. **Found by tests:** automatic pauses
  for a spending or message cap first released the sends queued in the same tick; only authority,
  template and number problems release queued sends now.
- **Platform:** rate-card console (CSV in Meta's layout, publish, withdraw with a reason; platform
  audit log).
- **Web:** Campaigns (list, new, draft/review, approval, controls, results, history, recipients,
  export), Contacts → Segments, Settings → Messaging → Campaigns, Platform → Meta rate cards. The
  Campaigns module is now available.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                     |
| `pnpm test` (unit)                                           | 90 passed (adds time zones and daylight saving, sending windows, variable mapping, cost arithmetic and prefixes, rate-card CSV)                                                                                                                                                                    |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 153 passed: campaigns 16 (segments, lifecycle and attribution, live re-checks, test sends, cancel races, approval, pause/resume, launcher losing permission, schedules and windows, frequency cap, spending and message caps, isolation, 10,000 recipients), isolation 45, plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 26 passed (13 tests × 2), including a campaign drafted, reviewed, started, queued by the worker, sent to the Graph stand-in, delivery counted, recipients and export                                                                                                                               |

10,000-recipient run (local, one machine, PostgreSQL 18 in Docker): snapshot 629 ms; 21 runner ticks
queued all 10,000 messages in 7.0 s. Real sending is paced by the per-number rate (default 20 per
second, about 8.5 minutes for 10,000) and by Meta's limits; that part was not measured.

### Known gaps (tracked in BACKLOG.md)

Reports (P3-05); the 10,000-recipient run in staging with real dispatch; per-recipient time zones;
A/B variants; reading the number's messaging tier from Meta; campaign sends through the public API;
media-header templates.

## 2026-09-26 — Phase 3: contacts, consent and templates

Status: **implementation complete for contacts, consent and templates, production blocked**
(template submission, sync and sends are verified only against the test-only Graph stand-in; a real
Meta app with `whatsapp_business_management`, app review and a sandbox WABA are external
prerequisites; Meta's opt-in guidance (M-131) and per-market consent law still need review).
Campaigns and reports (P3-04, P3-05) are not built.

### Completed

- **Schema (migration 0005):** contact email, typed custom values, source and erasure time; one
  contact per number (unique index); tags, custom field definitions, import runs; append-only
  consent events with trigger-maintained state (definer trigger); suppression list; company
  messaging settings; message templates with status history; template sync bookkeeping per WABA;
  `messages.template_id`; `app.erase_contact` and `ops.template_sync_due` (definer, app role only);
  a status-history guard that lets only the erasure function clear recipient ids. Found by the new
  tests: PostgreSQL regular expressions cap repetition counts at 255, so the template-name check is
  a character class plus a length check.
- **Contacts:** create, edit (numbers from WhatsApp are read-only), tags, typed custom fields,
  search and filters with keyset pages, CSV import (preview, explicit mapping, national or
  international numbers, never guessed; row errors by row number; consent only with an attestation
  and never over an opt-out), streaming formula-safe export, erasure. Inbound identities join the
  contact that already has the number, and the WhatsApp id Meta returns on a template send becomes
  an identity.
- **Consent:** keyword opt-outs/opt-ins from inbound text, quick-reply and interactive replies
  (company-configurable lists), member-recorded consent with a note, import consent, Meta 131050
  opt-outs, erasure opt-outs. Opt-outs win ties and the one-second uncertainty of Meta timestamps
  (found by a test in which a STOP sent in the same second as an agent's opt-in lost).
- **Templates:** editor with live preview and local validation; write-ahead submission; sync from
  the paged Graph listing (default-fields fallback), adoption of lost create responses and of
  templates made in WhatsApp Manager, failure of submissions Meta never received; deletion; template
  webhooks as sync signals through verified WABA bindings; per-minute sweep.
- **Template sends:** from a contact page (utility: inbox or campaign permission; marketing:
  campaign permission) and from the inbox when the 24-hour window has closed; consent, suppression
  and template approval re-checked right before dispatch; 132015/132016 mark the template paused or
  disabled; 131050 records an opt-out.
- **Web:** Contacts (list, add, detail, import, export), Templates (list per account with refresh,
  editor, detail with history), Settings → Messaging (keywords, marketing opt-in requirement,
  suppression list, custom fields); the inbox renders template messages and offers templates when
  the window is closed. Contacts and Templates modules are now available.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                               |
| `pnpm test` (unit)                                           | 72 passed (adds phone normalisation, CSV reader/writer, consent keywords and timing, template definitions)                                                   |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 136 passed: contacts/consent/erasure 13, templates 12, isolation 44 (new function-privilege assertions), messaging 21, billing 30, jobs/email 14, services 2 |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 24 passed (12 tests × 2), including contact creation, consent, CSV import/export and a template drafted, submitted, approved, synced and sent from the inbox |

Firefox and WebKit are not installed in this sandbox; they run in CI. Meta traffic in these tests
comes from the test-only Graph stand-in (`tests/support/graph-stand-in.ts`); no template has been
submitted to the real Graph API.

### Known gaps (tracked in BACKLOG.md)

Campaigns and saved segments (P3-04), reports (P3-05), safe contact merge (H-019), number masking
(W-044), media headers and other template types, URL buttons with variables (example format
unconfirmed, M-151), editing approved templates, sandbox verification of template submission, sync
fields (`rejected_reason`, `quality_score`) and template webhook payloads.

## 2026-09-26 — Phase 5 financial core (section 8A)

Status: **implementation complete for the wallet, top-up and auto-recharge slice, production
blocked** (Razorpay merchant activation, Recurring Payments for card mandates and a sandbox run are
external prerequisites; no request has reached the real Razorpay API; GST treatment of service
credit needs tax review; subscriptions are not built).

### Completed

- **Schema (migration 0004):** wallets, five ledger accounts per wallet, append-only ledger
  transactions and entries (balances by trigger, deferred balance check at commit), holds, Razorpay
  customers, card mandates (provider references and safe card metadata only), auto-recharge
  settings and attempts (one active attempt per wallet by partial unique index), top-ups. FORCE RLS
  everywhere, restrictive policies so runtime code can never mark a top-up paid or an attempt
  succeeded, support reads behind `billing.read` grants, and SECURITY DEFINER functions for every
  posting (credit, refund, dispute loss, hold/settle/release, auto-recharge decision) plus sweep
  and provider-id resolution functions.
- **Domain:** Razorpay client with classified results (retryable / permanent / auth / unknown) and
  constant-time signature checks; payment application from authoritative fetches only (payments,
  refunds, disputes, tokens); webhook receipt processing with quarantine; top-up reconciliation
  with backoff and expiry; the auto-recharge state machine with write-ahead unknown states and
  reconciliation by receipt / order payments; card mandate setup with the ₹1 authorisation refunded
  by idempotency key and abandoned tokens deleted; billing service for the web; owner/billing-role
  email notices; holds API for billable services.
- **Worker:** `billing.event-process`, `billing.auto-recharge` (check or advance), and a per-minute
  `ops.billing-sweep` (stale receipts, reconciliation, candidates, expired holds).
- **Web:** `/api/webhooks/razorpay`; Billing page (balance, add credit through Standard Checkout,
  card mandate, auto-recharge settings and attempts, payments, credit history) with the Razorpay
  CSP, COOP and Permissions-Policy scoped to that page. Found by the new e2e test: a CSP belongs to
  the loaded document, so provider pages (Billing, Channels) are now full page loads and reload
  once if reached by client-side navigation.
- **CI fix (0366b00):** WebKit e2e failed because input typed before hydration was reset by
  react-hook-form (and a pre-hydration click would have submitted the form natively). Client forms
  and click-handler buttons are disabled until hydration; regression test added. All 8 CI checks
  green on `0366b00`.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all 9 workspace packages pass                                           |
| `pnpm test` (unit)                                           | 49 passed (adds Razorpay signatures, client classification, Razorpay config)                               |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 111 passed: billing 30, isolation 44, messaging 21, jobs/email 14, services 2                              |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 20 passed (10 tests × 2), including a card top-up through the billing page and the signed Razorpay webhook |

Razorpay traffic in these tests comes from a test-only stand-in (`tests/support/razorpay-stand-in.ts`);
in the e2e run Playwright replaces `checkout.js` inside the test browser only. The configuration
refuses a non-official Razorpay origin outside `APP_ENV=local|test` and live keys outside
production.

### Known gaps (tracked in BACKLOG.md)

Plans and subscriptions (P5-01), statements, receipts and GST invoices, refunds initiated from the
platform console, step-up re-authentication for payment settings, Razorpay sandbox verification of
every flow and of the Checkout CSP, billable services that use holds (phase 6).

## 2026-09-26 — Phase 2 messaging slice

Status: **implementation complete for the phase 2 slice, production blocked** (Meta app, business
verification, app review and Embedded Signup configuration are external prerequisites; no message
has been exchanged with the real WhatsApp Cloud API).

### Completed

- **Schema (migration 0003):** WhatsApp accounts and numbers, onboarding sessions, contacts with
  per-WABA identities (BSUID first, phone optional), conversations (optimistic versions), notes,
  messages, immutable status history, send intents, media metadata, company event log (xid8
  cursors, NOTIFY hint), provider asset bindings, encrypted webhook receipts, quarantine, token
  buckets, retention functions. FORCE RLS and composite FKs on every tenant table; definer functions
  granted before ownership transfer.
- **Hardening (migration 0002, from review):** membership directories behind `members.read` support
  grants; platform seat counts and owner lookup through narrow definer functions; PUBLIC execute
  removed from every function (it had been granted by PostgreSQL's global default), with a
  structural test.
- **Domain:** webhook signature verification (current + previous secret), durable receipts,
  idempotent ingestion with quarantine and monotonic statuses, outbound send state machine
  (retries with jitter, per-number token bucket and fairness groups, unknown outcomes never resent
  automatically, manual resolution, cancellation on suspension or sender removal), Embedded Signup
  onboarding with server-side verification, resumable setup jobs, inbox service (visibility,
  assignment and status with row locks and versions, notes, read state), live-update event log with
  visibility filtering, retention.
- **Worker:** `webhook.process`, `message.send` (re-signals at `retryAt` in the number's group),
  `channel.onboard`, and a per-minute messaging sweep (lost signals, dead workers, retention).
- **Web:** `/api/webhooks/meta` (handshake, streaming 4 MB cap, signature, receipt before 200),
  `/api/c/{slug}/events` (SSE with replay, 30 s re-validation, polling mode), Inbox (views, thread,
  composer with per-member-and-company drafts and idempotency keys, window indicator, assignment,
  resolve/reopen, notes, unknown-outcome decisions, live updates), Settings → Channels (Embedded
  Signup, setup status, retry, disconnect) with Facebook CSP/COOP scoped to that page.
- **CI fixes:** WebKit dropped `Secure` cookies on loopback http (cookie security now follows the
  https origin; staging/production refuse non-https in any build mode); runtime images no longer
  ship npm/corepack/yarn (HIGH CVEs in npm's bundled dependencies); reviewed gitleaks false positive
  recorded. All 8 CI checks green on `e01bc26`.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                                 | Result                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check`                                       | 0 problems / all files formatted                                                                                     |
| `pnpm typecheck`                                                        | all 9 workspace packages pass                                                                                        |
| `pnpm test` (unit)                                                      | 39 passed (adds config safety, IP parsing)                                                                           |
| `pnpm test:integration` (PostgreSQL 18.x)                               | 81 passed: isolation 44, messaging 21, jobs/email 14 (+2 service tests)                                              |
| `pnpm test:e2e --project=chromium --project=mobile-chromium`            | 16 passed (8 tests × 2): live inbox (signed webhook → SSE → reply → delivery receipt), forms disabled until hydrated |
| Webhook smoke (`curl`)                                                  | handshake 200 with challenge; wrong verify token 403; unsigned 401; 5 MB body 413                                    |
| `docker build` web and worker; Trivy 0.74.0 (HIGH/CRITICAL, fixed only) | both images build; no findings                                                                                       |

Meta traffic in these tests comes from a test-only Graph API stand-in (`tests/support/`), which the
configuration refuses outside `APP_ENV=local|test`. Firefox and WebKit run in CI.

### Known gaps (tracked in BACKLOG.md)

Media download and storage, templates and template sends, message search, token health checks,
platform quarantine screen, messaging-limit display, collision warnings, Meta-side deregistration.

## 2026-09-26 — Phase 0 and Phase 1 vertical slice

### Completed

- **Phase 0:** repository assessment (empty repository: README + LICENSE only); toolchain research
  and pinning (ADR-002); research files for the WATI benchmark (164 capabilities), Meta WhatsApp
  platform (148 claims, Graph API v26.0) and Razorpay/RBI (105 claims) under
  `docs/research/`; dated feature matrix with truthful status (`docs/FEATURE-MATRIX.md`, generated);
  architecture, decisions, threat model, security, backlog, Meta setup, deployment, runbooks,
  retention, release checklist.
- **Phase 1:**
  - PostgreSQL roles (owner/app/auth/platform/definer), schemas `app`/`auth`/`ops`, FORCE RLS,
    column grants, SECURITY DEFINER entry points (create company, invitation preview/accept,
    last-owner guard, tenant status, account recovery), append-only audit tables.
  - Forward-only migration runner with checksums and pg-boss installation/queue declaration.
  - Better Auth identity (verified email required, TOTP 2FA, DB sessions, DB rate limits,
    enumeration protection).
  - Domain services: tenant context resolution, permission matrix, tenancy (companies, members,
    invitations, audit), platform administration, job signing/authorization, email outbox/delivery.
  - Web: sign-up/in, verification, reset, two-factor, onboarding, invitations, company overview,
    settings (general, members, security, audit log, modules), account (profile, 2FA, password,
    sessions), platform area (companies, suspension, support grants, MFA recovery); CSP nonces and
    security headers.
  - Worker: email delivery, outbox sweeper schedule, health probes, graceful shutdown.
  - Docker images (web, worker+migrate), compose dev stack, CI workflows (quality, integration on
    PG 17/18, build, e2e on Chromium/Firefox/WebKit/mobile, security, containers), Dependabot.

### Test commands and results (local, 2026-09-26)

| Command                                                                                                               | Result                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm lint`                                                                                                           | 0 errors, 0 warnings                                                            |
| `pnpm format:check`                                                                                                   | all files formatted                                                             |
| `pnpm typecheck`                                                                                                      | all 9 workspace packages pass                                                   |
| `pnpm test` (unit)                                                                                                    | 24 passed (crypto, money, ids, permission matrix, job envelope, AppError brand) |
| `pnpm test:integration` (PostgreSQL 18.x in Docker)                                                                   | 54 passed: tenant isolation 40, jobs/email 14                                   |
| `pnpm build`                                                                                                          | web (22 routes) and worker bundles built                                        |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` (local Chromium build 1194 via `PW_CHROMIUM_EXECUTABLE`) | 10 passed (5 tests × 2 projects)                                                |
| `pnpm audit --audit-level=high`                                                                                       | no known vulnerabilities                                                        |
| `docker build` web and worker images; run against local DB                                                            | both start; readiness OK; headers verified                                      |

Firefox and WebKit e2e runs happen in CI (browsers are not installed in this sandbox).

First CI run on PR #1 (commit `d9687b7`, 2026-09-26): lint/types/unit, integration on PostgreSQL 17
and 18, and the web/worker build passed; e2e passed on Chromium, Firefox and mobile but failed on
WebKit; both container scans and the secret scan failed. Root causes and fixes:

- WebKit drops `Secure` cookies on `http://localhost`, and the auth cookies were marked secure
  whenever `NODE_ENV=production` (CI runs `next start` over loopback http). Cookie security now
  follows the https origin, and staging/production refuse non-https origins in any build mode.
- Trivy flagged HIGH CVEs in the npm copy bundled with the Node base image (`brace-expansion`,
  `ip-address`, `tar`). The runtime images no longer ship npm, npx, corepack or yarn; local Trivy
  0.74.0 scans of both images report no HIGH/CRITICAL fixed vulnerabilities.
- gitleaks matched an empty `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=` in `.env.example` together with the
  next line (false positive; no value was committed). The fingerprint is recorded in
  `.gitleaksignore` and the variables are now separated by a comment.

Review round 1 (Codex on `d9687b7`), fixed in the following commit:

- Platform staff read company membership directories only through a `members.read` support grant;
  the console uses aggregate seat counts and an owners-only lookup (definer functions, platform
  administrators only). The company page loads by id instead of searching the newest 200.
- Support-access revocation is mirrored into the company audit log.
- Invitation issuance takes a per-company transaction lock, so the daily quota holds under
  concurrency (integration test: six concurrent requests at 99/100 yield exactly one invitation).
- Client IPs are resolved from `X-Forwarded-For` right-to-left past `TRUSTED_PROXIES` and validated
  with Node's IP parser; malformed values are dropped instead of failing the audited transaction.
- Found while testing: every `app`/`ops` function was executable by PUBLIC (a per-schema default
  cannot revoke the global default), and grants issued after transferring functions to
  `w360_definer` were no-ops. Migration `0002_platform_access_hardening` revokes PUBLIC, sets the
  global default for the migration role and re-grants as the owner; a structural test now fails if
  any function is executable by PUBLIC.

### Running end-to-end tests locally

```bash
bash scripts/local-db.sh up && docker compose -f infra/docker-compose.yml up -d mailpit
set -a; . ./.env; set +a; export APP_ENV=test
pnpm db:migrate && pnpm build
(cd apps/web && npx next start --port 3000 &) ; (cd apps/worker && NODE_ENV=production node dist/main.js &)
E2E_DATABASE_URL_AUTH=$DATABASE_URL_AUTH pnpm test:e2e --project=chromium
```

The inbox e2e test needs the test-only Meta settings in `.env` (web and worker):
`META_APP_ID`, `META_APP_SECRET` (any random value), `META_GRAPH_API_VERSION=v26.0`,
`META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_BASE_URL=http://127.0.0.1:4010` and `E2E_GRAPH_PORT=4010`;
Playwright's global setup starts the Graph stand-in on that port. Without them the test is skipped.
The billing e2e test similarly needs `RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET` and
`RAZORPAY_WEBHOOK_SECRET` (random values), `RAZORPAY_API_BASE_URL=http://127.0.0.1:4020` and
`E2E_RAZORPAY_PORT=4020`.

### Blockers (external)

- Network policy of this build environment blocked `wati.io`, `developers.facebook.com`,
  `business.whatsapp.com` and `razorpay.com`; research relies on search summaries and official GitHub
  sources and must be re-verified.
- Meta: business verification, Tech Provider app review, Embedded Signup configuration.
- Razorpay: merchant activation (Orders, Subscriptions, Recurring Payments card mandates).
- Owner decisions: SMTP provider and sending domain, hosting provider/region, legal entity for billing.

### Next task

Phase 3 foundations that unblock real usage: contacts with consent provenance and suppression,
message templates (drafts, Meta submission, approval sync) and template sends, then campaigns with
send-time consent checks. In parallel: phase 2 follow-ups (media storage, token health, quarantine
screen) and P5-01 plans and subscriptions.
