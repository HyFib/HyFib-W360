/**
 * Metric definitions: what each reported number counts, its denominator, its time window and how
 * missing data is treated. These rows are persisted in `ops.metric_definitions` (migration 0007)
 * so a report can say which version of a definition produced it; a test keeps this registry and
 * the table identical. Changing a definition means a new version, never an edited one.
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
  /** How missing or delayed data affects the number. */
  missingData: string;
  /** When the number is computed and how current it is. */
  freshness: string;
  /** False when the platform cannot measure it; the UI shows the reason instead of a number. */
  available: boolean;
}

const LIVE =
  'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.';

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
    numerator: 'Recipients with a reply attributed to this campaign.',
    denominator: 'Recipients whose message status is delivered or read.',
    window: '72 hours after the message was queued, last touch.',
    missingData:
      'Replies Meta has not delivered to HyFib yet are not counted; the window is measured in absolute time.',
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
    numerator: 'Recipients with a marketing opt-out attributed to this campaign.',
    denominator: 'Recipients whose message status is delivered or read.',
    window: '72 hours after the message was queued, last touch.',
    missingData: 'Opt-outs made outside WhatsApp and not recorded in HyFib are not counted.',
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
    missingData:
      'An upper bound: Meta charges delivered messages only, and free windows and volume tiers are not applied. Recipients in markets without a rate are listed as unpriced.',
    freshness: LIVE,
    available: true,
  },
];

export function metricDefinition(key: string): MetricDefinition {
  const found = METRIC_DEFINITIONS.find((m) => m.key === key);
  if (!found) throw new Error(`Unknown metric ${key}`);
  return found;
}
