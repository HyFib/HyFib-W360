/**
 * Metric definitions: what each reported number counts, its denominator, its time window, how
 * days are cut in time zones and how missing data is treated. These rows are persisted in
 * `ops.metric_definitions` (migrations 0007 and 0009) so a report can say which version of a definition
 * produced it; a test keeps this registry and the table identical. Changing a definition means a
 * new version (a new migration row), never an edited one.
 */
export type MetricUnit = 'count' | 'rate' | 'duration' | 'money';

export interface MetricDefinition {
  key: string;
  version: number;
  label: string;
  unit: MetricUnit;
  description: string;
  numerator: string;
  denominator: string | null;
  window: string | null;
  /** How the period and its days are cut in time zones, when the metric is reported by period. */
  timezoneRule: string | null;
  /** How missing or delayed data affects the number. */
  missingData: string;
  /** When the number is computed and how current it is. */
  freshness: string;
  /** False when the platform cannot measure it; the UI shows the reason instead of a number. */
  available: boolean;
}

const LIVE =
  'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.';
const NOW = 'The state when the page loads.';
const DAYS =
  'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.';
const TURNS =
  'A reply turn starts with the first customer message that has no reply from a member yet and ends when a member replies or the conversation is resolved. Turns are counted by the time they started, in calendar days of the company’s time zone.';
/** Turns once automations exist (migration 0011): hand-offs start turns, automated time does not count. */
const TURNS_V2 =
  'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.';
const NOT_AVAILABLE = 'Not available.';
const RUN_DAYS =
  'Counted by the time the run started, in calendar days of the company’s time zone. Test runs started by members are not counted.';
const TARGET_CLOCK =
  'The target, counted in business hours when business hours are on (Settings → Messaging → Business hours), otherwise in absolute time.';
const SURVEY_DAYS =
  'Counted by the time the survey was created (when the conversation was resolved), in calendar days of the company’s time zone.';
const RECORDS = 'Computed when the page loads from HyFib’s records.';
const CLOSE_DAYS =
  'Counted by the time the deal was closed, in calendar days of the company’s time zone.';

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: 'campaign.audience',
    version: 1,
    label: 'Audience',
    unit: 'count',
    description: 'Contacts in the audience snapshot taken when the campaign was submitted.',
    numerator: 'Recipients in the snapshot.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Contacts erased later stay counted, as skipped.',
    freshness: 'Fixed at submission.',
    available: true,
  },
  {
    key: 'campaign.skipped',
    version: 1,
    label: 'Not sent',
    unit: 'count',
    description:
      'Snapshot recipients HyFib did not send to, by reason: opted out, suppressed, no marketing opt-in, missing variable, frequency cap, unknown cost under a spending cap, erased, no number, or the sending period ended.',
    numerator: 'Recipients with state skipped.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'None: every skip records its reason.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'campaign.queued',
    version: 1,
    label: 'Handed to WhatsApp',
    unit: 'count',
    description: 'Recipients whose message was queued for sending through the WhatsApp number.',
    numerator: 'Recipients with state queued.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'None.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'campaign.sent_rate',
    version: 1,
    label: 'Sent',
    unit: 'rate',
    description: 'Share of queued messages that Meta reported as sent (or delivered or read).',
    numerator: 'Queued recipients whose message status is sent, delivered or read.',
    denominator: 'Queued recipients.',
    window: null,
    timezoneRule: null,
    missingData:
      'Messages without a status webhook yet count as not sent; they appear as "in progress".',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'campaign.delivered_rate',
    version: 1,
    label: 'Delivered',
    unit: 'rate',
    description: 'Share of sent messages that reached the customer’s phone.',
    numerator: 'Recipients whose message status is delivered or read.',
    denominator: 'Recipients whose message status is sent, delivered or read.',
    window: null,
    timezoneRule: null,
    missingData: 'A delivered status can arrive late; the rate can rise after sending ends.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'campaign.read_rate',
    version: 1,
    label: 'Read',
    unit: 'rate',
    description: 'Share of delivered messages that Meta reported as read.',
    numerator: 'Recipients whose message status is read.',
    denominator: 'Recipients whose message status is delivered or read.',
    window: null,
    timezoneRule: null,
    missingData:
      'Customers can turn read receipts off, so this is a lower bound of the true read rate.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'campaign.reply_rate',
    version: 1,
    label: 'Replied',
    unit: 'rate',
    description:
      'Share of delivered messages followed by a reply from the customer on the same number within 72 hours (quick-reply taps count; reactions do not). A reply counts for the most recent campaign message only.',
    numerator: 'Delivered recipients with a reply attributed to this campaign.',
    denominator: 'Recipients whose message status is delivered or read.',
    window: '72 hours after the message was queued, last touch.',
    timezoneRule: null,
    missingData:
      'Replies Meta has not delivered to HyFib yet are not counted, and a reply to a message whose delivered status has not arrived counts once it does; the window is measured in absolute time.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'campaign.opt_out_rate',
    version: 1,
    label: 'Opted out',
    unit: 'rate',
    description:
      'Share of delivered messages followed within 72 hours by a marketing opt-out (keyword, Meta error 131050, or recorded by a member).',
    numerator: 'Delivered recipients with a marketing opt-out attributed to this campaign.',
    denominator: 'Recipients whose message status is delivered or read.',
    window: '72 hours after the message was queued, last touch.',
    timezoneRule: null,
    missingData:
      'Opt-outs made outside WhatsApp and not recorded in HyFib are not counted; an opt-out is never attributed to a message that failed or was not sent.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'campaign.failure_rate',
    version: 1,
    label: 'Failed',
    unit: 'rate',
    description:
      'Share of queued messages that failed or whose outcome is unknown (a dropped connection after the request left; never resent automatically).',
    numerator: 'Queued recipients whose message status is failed or unknown outcome.',
    denominator: 'Queued recipients.',
    window: null,
    timezoneRule: null,
    missingData: 'Failure codes are Meta’s; see the breakdown for each code.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'campaign.clicked',
    version: 1,
    label: 'Clicked',
    unit: 'rate',
    description: 'Taps on website buttons.',
    numerator: '—',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData:
      'Not measured: Meta does not report website-button taps in webhooks, and HyFib does not rewrite links to track them.',
    freshness: 'Not available.',
    available: false,
  },
  {
    key: 'campaign.converted',
    version: 1,
    label: 'Converted',
    unit: 'rate',
    description: 'Purchases or deals attributed to the campaign.',
    numerator: '—',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Not measured: no conversion source (orders or deals) is connected yet.',
    freshness: 'Not available.',
    available: false,
  },
  {
    key: 'campaign.estimated_cost',
    version: 1,
    label: 'Estimated Meta cost',
    unit: 'money',
    description:
      'Sum of the list price of each queued message from the published rate card for the company’s billing currency, by the recipient’s market and the template’s category. Meta bills the company directly; HyFib does not charge this.',
    numerator: 'Sum of estimated prices of queued messages.',
    denominator: null,
    window: 'Rate card in force when each message was queued.',
    timezoneRule: null,
    missingData:
      'An upper bound: Meta charges delivered messages only, and free windows and volume tiers are not applied. Recipients in markets without a rate are listed as unpriced.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'messaging.inbound',
    version: 1,
    label: 'Customer messages',
    unit: 'count',
    description: 'Messages customers sent to the company’s WhatsApp numbers.',
    numerator: 'Inbound messages from contacts, excluding reactions and system notices.',
    denominator: null,
    window: null,
    timezoneRule: DAYS,
    missingData: 'Messages Meta has not delivered to HyFib yet are not counted.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'messaging.outbound',
    version: 1,
    label: 'Messages sent',
    unit: 'count',
    description:
      'Messages the company sent, by sender: members (replies and templates), campaigns, and other senders (API or system).',
    numerator: 'Outbound messages recorded in the period.',
    denominator: null,
    window: null,
    timezoneRule: DAYS,
    missingData: 'Includes messages canceled before sending; they are shown separately.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'messaging.sent_rate',
    version: 1,
    label: 'Sent',
    unit: 'rate',
    description: 'Share of outbound messages that Meta reported as sent (or delivered or read).',
    numerator: 'Outbound messages whose status is sent, delivered or read.',
    denominator: 'Outbound messages, excluding those canceled before sending.',
    window: null,
    timezoneRule: DAYS,
    missingData:
      'Messages without a status webhook yet count as not sent; they appear as "in progress".',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'messaging.delivered_rate',
    version: 1,
    label: 'Delivered',
    unit: 'rate',
    description: 'Share of sent messages that reached the customer’s phone.',
    numerator: 'Outbound messages whose status is delivered or read.',
    denominator: 'Outbound messages whose status is sent, delivered or read.',
    window: null,
    timezoneRule: DAYS,
    missingData: 'A delivered status can arrive late; the rate can rise for recent days.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'messaging.read_rate',
    version: 1,
    label: 'Read',
    unit: 'rate',
    description: 'Share of delivered messages that Meta reported as read.',
    numerator: 'Outbound messages whose status is read.',
    denominator: 'Outbound messages whose status is delivered or read.',
    window: null,
    timezoneRule: DAYS,
    missingData:
      'Customers can turn read receipts off, so this is a lower bound of the true read rate.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'messaging.failure_rate',
    version: 1,
    label: 'Failed',
    unit: 'rate',
    description:
      'Share of outbound messages that failed or whose outcome is unknown (a dropped connection after the request left; never resent automatically).',
    numerator: 'Outbound messages whose status is failed or unknown outcome.',
    denominator: 'Outbound messages, excluding those canceled before sending.',
    window: null,
    timezoneRule: DAYS,
    missingData: 'Failure codes are Meta’s; see the breakdown for each code.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'messaging.estimated_cost',
    version: 1,
    label: 'Estimated Meta charges',
    unit: 'money',
    description:
      'Estimated charges for delivered messages that Meta marked billable, at the list price of the published rate card for the company’s billing currency (Settings → Messaging), by the recipient’s market and Meta’s pricing category. Meta bills the company directly; HyFib does not charge this.',
    numerator: 'Sum of the list prices of delivered, billable messages.',
    denominator: null,
    window: 'The rate card in force when each message was recorded.',
    timezoneRule: DAYS,
    missingData:
      'An estimate: volume-tier discounts are not applied and Meta’s invoice is authoritative. Messages Meta has not priced yet, recipients whose market has no rate, and erased recipients are listed as unpriced, not guessed.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.open_conversations',
    version: 1,
    label: 'Open conversations',
    unit: 'count',
    description: 'Conversations that are open or pending.',
    numerator: 'Conversations whose status is open or pending.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'None.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.unassigned',
    version: 1,
    label: 'Unassigned',
    unit: 'count',
    description: 'Open or pending conversations that no member is assigned to.',
    numerator: 'Open or pending conversations without an assignee.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'None.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.waiting',
    version: 1,
    label: 'Waiting for a reply',
    unit: 'count',
    description:
      'Conversations whose customer is waiting: their latest messages have no reply from a member and the conversation is not resolved.',
    numerator: 'Open reply turns.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Reply turns are recorded from the release of reports onwards.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.waiting',
    version: 2,
    label: 'Waiting for a reply',
    unit: 'count',
    description:
      'Conversations whose customer is waiting for a member: their latest messages have no reply from a member, no automation is handling the conversation, and it is not resolved. A conversation an automation passed to people waits from that moment.',
    numerator: 'Open reply turns.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Reply turns are recorded from the release of reports onwards.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.oldest_wait',
    version: 1,
    label: 'Longest wait',
    unit: 'duration',
    description: 'How long the longest-waiting customer has been waiting for a reply.',
    numerator: 'Time since the start of the oldest open reply turn.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Measured in absolute time; there is no business-hours calendar yet.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.oldest_wait',
    version: 2,
    label: 'Longest wait',
    unit: 'duration',
    description: 'How long the longest-waiting customer has been waiting for a reply.',
    numerator: 'Time since the start of the oldest open reply turn.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Measured in absolute time, including hours outside business hours.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.oldest_wait',
    version: 3,
    label: 'Longest wait',
    unit: 'duration',
    description:
      'How long the longest-waiting customer has been waiting for a member. Time while an automation was handling the conversation does not count.',
    numerator:
      'Time since the start of the oldest open reply turn (the customer’s first waiting message, or an automation’s hand-off).',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Measured in absolute time, including hours outside business hours.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.overdue',
    version: 1,
    label: 'Overdue',
    unit: 'count',
    description:
      'Waiting conversations whose customer has waited longer than the company’s first-response target.',
    numerator: 'Open reply turns that have waited longer than the target.',
    denominator: null,
    window: TARGET_CLOCK,
    timezoneRule: null,
    missingData:
      'Shown only when a target is set. Reply turns are recorded from the release of reports onwards.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.overdue',
    version: 2,
    label: 'Overdue',
    unit: 'count',
    description:
      'Waiting conversations whose customer has waited longer than the company’s first-response target. After an automation’s hand-off the wait counts from the hand-off.',
    numerator: 'Open reply turns that have waited longer than the target.',
    denominator: null,
    window: TARGET_CLOCK,
    timezoneRule: null,
    missingData:
      'Shown only when a target is set. Reply turns are recorded from the release of reports onwards.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.windows_closing',
    version: 1,
    label: 'Reply windows closing',
    unit: 'count',
    description:
      'Waiting conversations whose 24-hour customer service window closes within 2 hours. After it closes only approved templates can be sent.',
    numerator: 'Open reply turns whose customer’s last message was 22 to 24 hours ago.',
    denominator: null,
    window: 'The window closes 24 hours after the customer’s last message.',
    timezoneRule: null,
    missingData: 'None.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.windows_closing',
    version: 2,
    label: 'Reply windows closing',
    unit: 'count',
    description:
      'Conversations waiting for a member whose 24-hour customer service window closes within 2 hours. After it closes only approved templates can be sent. Conversations an automation is handling are not counted.',
    numerator: 'Open reply turns whose customer’s last message was 22 to 24 hours ago.',
    denominator: null,
    window: 'The window closes 24 hours after the customer’s last message.',
    timezoneRule: null,
    missingData: 'None.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'inbox.first_response_time',
    version: 1,
    label: 'First response time',
    unit: 'duration',
    description:
      'Time from the start of a reply turn to the first reply by a member, reported as the median and the 90th percentile.',
    numerator: 'Reply times of answered turns.',
    denominator: 'Turns that started in the period and were answered.',
    window:
      'From when HyFib received the customer’s first waiting message to when the member sent the reply, in absolute time (no business-hours calendar yet).',
    timezoneRule: TURNS,
    missingData:
      'Turns still waiting are not in the median; see Waiting. A reply counts when the member sends it, even if WhatsApp later rejects it (see Failed). Reply turns are recorded from the release of reports onwards.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.first_response_time',
    version: 2,
    label: 'First response time',
    unit: 'duration',
    description:
      'Time from the start of a reply turn to the first reply by a member, reported as the median and the 90th percentile.',
    numerator: 'Reply times of answered turns.',
    denominator: 'Turns that started in the period and were answered.',
    window:
      'From when HyFib received the customer’s first waiting message to when the member sent the reply, in absolute time, including hours outside business hours (see First response in business hours).',
    timezoneRule: TURNS,
    missingData:
      'Turns still waiting are not in the median; see Waiting. A reply counts when the member sends it, even if WhatsApp later rejects it (see Failed). Reply turns are recorded from the release of reports onwards.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.first_response_time',
    version: 3,
    label: 'First response time',
    unit: 'duration',
    description:
      'Time from the start of a reply turn to the first reply by a member, reported as the median and the 90th percentile.',
    numerator: 'Reply times of answered turns.',
    denominator: 'Turns that started in the period and were answered.',
    window:
      'From when HyFib received the customer’s first waiting message, or from an automation’s hand-off, to when the member sent the reply, in absolute time, including hours outside business hours (see First response in business hours).',
    timezoneRule: TURNS_V2,
    missingData:
      'Turns still waiting are not in the median; see Waiting. A reply counts when the member sends it, even if WhatsApp later rejects it (see Failed). Reply turns are recorded from the release of reports onwards.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.first_response_business_time',
    version: 1,
    label: 'First response in business hours',
    unit: 'duration',
    description:
      'Time from the start of a reply turn to the first reply by a member, counting business hours only, reported as the median and the 90th percentile.',
    numerator: 'Business-hours reply times of answered turns.',
    denominator: 'Turns that started in the period and were answered.',
    window:
      'Only time inside the company’s business hours counts (Settings → Messaging → Business hours); closed days and hours outside the weekly schedule are skipped, in the company’s time zone.',
    timezoneRule: TURNS,
    missingData:
      'Shown only when business hours are on. The current schedule and closed days are applied to the whole period, including turns from before a change.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.first_response_business_time',
    version: 2,
    label: 'First response in business hours',
    unit: 'duration',
    description:
      'Time from the start of a reply turn to the first reply by a member, counting business hours only, reported as the median and the 90th percentile.',
    numerator: 'Business-hours reply times of answered turns.',
    denominator: 'Turns that started in the period and were answered.',
    window:
      'Only time inside the company’s business hours counts (Settings → Messaging → Business hours); closed days and hours outside the weekly schedule are skipped, in the company’s time zone.',
    timezoneRule: TURNS_V2,
    missingData:
      'Shown only when business hours are on. The current schedule and closed days are applied to the whole period, including turns from before a change.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.within_target',
    version: 1,
    label: 'Answered within target',
    unit: 'rate',
    description:
      'Share of reply turns answered within the company’s first-response target (Settings → Messaging).',
    numerator: 'Turns answered within the target.',
    denominator:
      'Turns that started in the period and were answered or have waited longer than the target. Turns resolved without a reply and turns still within the target are left out.',
    window: 'The target, in absolute time.',
    timezoneRule: TURNS,
    missingData: 'Shown only when a target is set.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.within_target',
    version: 2,
    label: 'Answered within target',
    unit: 'rate',
    description:
      'Share of reply turns answered within the company’s first-response target (Settings → Messaging).',
    numerator: 'Turns answered within the target.',
    denominator:
      'Turns that started in the period and were answered or have waited longer than the target. Turns resolved without a reply and turns still within the target are left out.',
    window: TARGET_CLOCK,
    timezoneRule: TURNS,
    missingData:
      'Shown only when a target is set. With business hours on, the current schedule and closed days are applied to the whole period.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.within_target',
    version: 3,
    label: 'Answered within target',
    unit: 'rate',
    description:
      'Share of reply turns answered within the company’s first-response target (Settings → Messaging).',
    numerator: 'Turns answered within the target.',
    denominator:
      'Turns that started in the period and were answered or have waited longer than the target. Turns resolved without a reply, turns still within the target and turns an automation took over are left out.',
    window: TARGET_CLOCK,
    timezoneRule: TURNS_V2,
    missingData:
      'Shown only when a target is set. With business hours on, the current schedule and closed days are applied to the whole period.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.resolved_without_reply',
    version: 1,
    label: 'Resolved without a reply',
    unit: 'count',
    description:
      'Reply turns closed by resolving the conversation without replying, for example after a customer’s thank-you.',
    numerator: 'Turns that ended because the conversation was resolved.',
    denominator: null,
    window: null,
    timezoneRule: TURNS,
    missingData: 'None.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.resolved_without_reply',
    version: 2,
    label: 'Resolved without a reply',
    unit: 'count',
    description:
      'Reply turns closed by resolving the conversation without replying, for example after a customer’s thank-you.',
    numerator: 'Turns that ended because the conversation was resolved.',
    denominator: null,
    window: null,
    timezoneRule: TURNS_V2,
    missingData: 'None.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'inbox.resolution_time',
    version: 1,
    label: 'Resolution time',
    unit: 'duration',
    description:
      'Time from when a conversation opened, or reopened after being resolved, to when it was resolved, reported as the median and the 90th percentile.',
    numerator: 'Durations of cases resolved in the period.',
    denominator: 'Cases resolved in the period.',
    window: 'Absolute time, including hours outside business hours.',
    timezoneRule:
      'Counted by the time the case was resolved, in calendar days of the company’s time zone.',
    missingData:
      'Cases are recorded from the release of inbox teams onwards; a conversation that was already open then is counted from its next reopening.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'csat.surveys',
    version: 1,
    label: 'CSAT surveys',
    unit: 'count',
    description:
      'Rating questions sent after a member resolved a conversation, and resolves that sent none, by reason: the 24-hour window had closed, the customer opted out, the number is suppressed, the contact was erased, the contact has no phone number, the WhatsApp number is inactive, or the customer was asked in the last 24 hours.',
    numerator: 'Surveys created in the period, by outcome.',
    denominator: null,
    window: null,
    timezoneRule: SURVEY_DAYS,
    missingData: 'None: every survey that was not sent records its reason.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'csat.response_rate',
    version: 1,
    label: 'CSAT response rate',
    unit: 'rate',
    description: 'Share of delivered rating questions that the customer answered.',
    numerator: 'Surveys with an answer.',
    denominator:
      'Surveys created in the period whose message WhatsApp delivered (delivered, read or answered).',
    window: 'Answers count whenever they arrive; only the first tap on the question counts.',
    timezoneRule: SURVEY_DAYS,
    missingData:
      'Delivery statuses come from Meta’s webhooks and can arrive late; a late status moves a survey into the denominator.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'csat.score',
    version: 1,
    label: 'CSAT',
    unit: 'rate',
    description:
      'Share of answers that chose the best of the three ratings; the other answers are shown next to it.',
    numerator: 'Answers with the best rating.',
    denominator: 'Answered surveys created in the period.',
    window: null,
    timezoneRule: SURVEY_DAYS,
    missingData:
      'With few answers the share is unstable, so the number of answers is shown with it.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'agent.replies',
    version: 1,
    label: 'Replies sent',
    unit: 'count',
    description: 'Messages the member sent in conversations: text replies and templates.',
    numerator: 'Outbound messages sent by the member.',
    denominator: null,
    window: null,
    timezoneRule: DAYS,
    missingData: 'Includes messages that failed or were canceled before sending.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'agent.turns_answered',
    version: 1,
    label: 'Turns answered',
    unit: 'count',
    description: 'Reply turns the member answered first.',
    numerator: 'Turns that ended with the member’s reply.',
    denominator: null,
    window: null,
    timezoneRule:
      'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
    missingData: 'Reply turns are recorded from the release of reports onwards.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'agent.turns_answered',
    version: 2,
    label: 'Turns answered',
    unit: 'count',
    description:
      'Reply turns the member answered first, including turns that started when an automation passed the conversation to people.',
    numerator: 'Turns that ended with the member’s reply.',
    denominator: null,
    window: null,
    timezoneRule:
      'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
    missingData:
      'Reply turns are recorded from the release of reports onwards. Replies that took a conversation over from an automation answer no turn.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'agent.first_response_time',
    version: 1,
    label: 'Median first response',
    unit: 'duration',
    description: 'Median reply time of the turns the member answered.',
    numerator: 'Reply times of the turns the member answered.',
    denominator: 'Turns the member answered in the period.',
    window: 'Absolute time; no business-hours calendar yet.',
    timezoneRule:
      'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
    missingData: 'Reply turns are recorded from the release of reports onwards.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'agent.first_response_time',
    version: 2,
    label: 'Median first response',
    unit: 'duration',
    description: 'Median reply time of the turns the member answered.',
    numerator: 'Reply times of the turns the member answered.',
    denominator: 'Turns the member answered in the period.',
    window: 'Absolute time, including hours outside business hours.',
    timezoneRule:
      'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
    missingData: 'Reply turns are recorded from the release of reports onwards.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'agent.first_response_time',
    version: 3,
    label: 'Median first response',
    unit: 'duration',
    description: 'Median reply time of the turns the member answered.',
    numerator: 'Reply times of the turns the member answered.',
    denominator: 'Turns the member answered in the period.',
    window:
      'Absolute time from the start of the turn (the customer’s first waiting message, or an automation’s hand-off), including hours outside business hours.',
    timezoneRule:
      'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
    missingData: 'Reply turns are recorded from the release of reports onwards.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'agent.resolved',
    version: 1,
    label: 'Resolved',
    unit: 'count',
    description: 'Times the member marked a conversation resolved.',
    numerator: 'Resolve actions in the audit log by the member.',
    denominator: null,
    window: null,
    timezoneRule: DAYS,
    missingData:
      'Counted from the release of reports; earlier resolutions were not recorded per member.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'agent.csat',
    version: 1,
    label: 'CSAT',
    unit: 'rate',
    description:
      'Share of best ratings among the answers to rating questions sent after the member’s conversations were resolved.',
    numerator: 'Best-rated answers credited to the member.',
    denominator:
      'Answered surveys credited to the member: the conversation was assigned to them when it was resolved.',
    window: null,
    timezoneRule: SURVEY_DAYS,
    missingData: 'Surveys of conversations resolved while unassigned are credited to nobody.',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'automation.outcomes',
    version: 1,
    label: 'Automation success and failure',
    unit: 'rate',
    description: 'Runs of automations that completed or failed.',
    numerator: '—',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Not measured: automations are not available yet (planned for Phase 4).',
    freshness: NOT_AVAILABLE,
    available: false,
  },
  {
    key: 'automation.outcomes',
    version: 2,
    label: 'Automation outcomes',
    unit: 'rate',
    description:
      'Share of finished runs that completed without people, were handed off by the automation, were taken over by a member, were stopped, or failed (budget, closed window, errors).',
    numerator: 'Finished runs with each outcome.',
    denominator: 'Runs started in the period that have finished.',
    window: 'Runs still running or waiting are not in the denominator until they finish.',
    timezoneRule: RUN_DAYS,
    missingData: 'Runs older than 180 days are deleted (docs/DATA-RETENTION.md).',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'automation.runs',
    version: 1,
    label: 'Automation runs',
    unit: 'count',
    description:
      'Runs of published automations started by customer messages, by how they ended: completed, handed off to people, taken over by a member, stopped, failed, or still running.',
    numerator: 'Runs started in the period, by outcome.',
    denominator: null,
    window: null,
    timezoneRule: RUN_DAYS,
    missingData: 'Runs older than 180 days are deleted (docs/DATA-RETENTION.md).',
    freshness: LIVE,
    available: true,
  },
  {
    key: 'crm.deal_outcomes',
    version: 1,
    label: 'Deal outcomes',
    unit: 'count',
    description: 'Deals won and lost, and their value.',
    numerator: '—',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Not measured: CRM deals are not available yet (planned for Phase 4).',
    freshness: NOT_AVAILABLE,
    available: false,
  },
  {
    key: 'crm.deal_outcomes',
    version: 2,
    label: 'Deal outcomes',
    unit: 'count',
    description: 'Deals won and lost in the period, with their value in each pipeline currency.',
    numerator:
      'Deals whose status became won or lost in the period (a deal reopened and closed again counts once, at its latest close).',
    denominator: null,
    window: null,
    timezoneRule: CLOSE_DAYS,
    missingData:
      'Values are the deals’ current values. Values in different currencies are never added together. Deals of erased contacts keep their value and outcome.',
    freshness: RECORDS,
    available: true,
  },
  {
    key: 'crm.win_rate',
    version: 1,
    label: 'Win rate',
    unit: 'rate',
    description: 'Share of deals closed in the period that were won.',
    numerator: 'Deals won in the period.',
    denominator: 'Deals won or lost in the period.',
    window: null,
    timezoneRule: CLOSE_DAYS,
    missingData: 'Not shown when no deal was closed in the period.',
    freshness: RECORDS,
    available: true,
  },
  {
    key: 'crm.time_to_win',
    version: 1,
    label: 'Time to win',
    unit: 'duration',
    description: 'How long won deals took from creation to being won, reported as the median.',
    numerator: 'Time from creation to close of deals won in the period.',
    denominator: 'Deals won in the period.',
    window: 'From when the deal was created in HyFib to when it was marked won, in absolute time.',
    timezoneRule: CLOSE_DAYS,
    missingData: 'Not shown when no deal was won in the period.',
    freshness: RECORDS,
    available: true,
  },
  {
    key: 'crm.open_pipeline',
    version: 1,
    label: 'Open pipeline',
    unit: 'count',
    description: 'Open deals and their total value in each stage of each pipeline, now.',
    numerator: 'Open deals, by pipeline and stage.',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData: 'Deals without a value count in the number of deals but add nothing to the value.',
    freshness: NOW,
    available: true,
  },
  {
    key: 'contacts.retention',
    version: 1,
    label: 'Retention cohorts',
    unit: 'rate',
    description: 'Share of customers from each starting month who are still active later.',
    numerator: '—',
    denominator: null,
    window: null,
    timezoneRule: null,
    missingData:
      'Not computed: HyFib has no record yet of what makes a customer active (orders or deals), and message activity alone would overstate retention.',
    freshness: NOT_AVAILABLE,
    available: false,
  },
];

/** The current version of every metric, in registry order (older versions stay in the registry). */
export function currentMetricDefinitions(): MetricDefinition[] {
  const latest = new Map<string, MetricDefinition>();
  for (const m of METRIC_DEFINITIONS) {
    const seen = latest.get(m.key);
    if (!seen || seen.version < m.version) latest.set(m.key, m);
  }
  return [...latest.values()];
}

/** Current definitions whose key starts with `prefix` (for example `inbox.`), in registry order. */
export function metricDefinitions(prefix: string): MetricDefinition[] {
  return currentMetricDefinitions().filter((m) => m.key.startsWith(prefix));
}

export function metricDefinition(key: string): MetricDefinition {
  const found = currentMetricDefinitions().find((m) => m.key === key);
  if (!found) throw new Error(`Unknown metric ${key}`);
  return found;
}
