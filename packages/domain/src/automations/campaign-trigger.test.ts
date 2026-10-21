import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_WINDOW_HOURS } from '../campaigns/attribution';
import {
  CAMPAIGN_PLACEHOLDERS,
  CAMPAIGN_REPLY_HOURS,
  TRIGGER_LABELS,
  TRIGGER_TYPES,
  TRIGGER_TYPE_OF_RANK,
  campaignButtonKey,
  campaignTriggerIssues,
  checkGraph,
  describeTrigger,
  matchTrigger,
  parseGraph,
  parseTrigger,
  renderHttpText,
  renderText,
  triggerIssues,
  type AutomationGraph,
  type AutomationTrigger,
  type CampaignReference,
  type CampaignReplyContext,
} from './graph';
import { advance, initialRunState, type RunFacts } from './interpreter';
import { dispatchInboundToAutomation, findCampaignReply } from './dispatch';
import { campaignPlaceholderValues } from './run-campaigns';

/** Automations started by replies to a campaign: the trigger, its ranking and its fields (ADR-414). */

const DIWALI = '0190a3e4-1111-7000-8000-000000000001';
const SUMMER = '0190a3e4-2222-7000-8000-000000000002';
const NUMBER = '0190a3e4-3333-7000-8000-000000000003';
const OTHER_NUMBER = '0190a3e4-4444-7000-8000-000000000004';

function trigger(input: Record<string, unknown>): AutomationTrigger {
  const parsed = parseTrigger({ hours: 'any', cooldownMinutes: 0, ...input });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.trigger;
}

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

const anyCampaign = trigger({ type: 'campaign_reply', campaignId: null, button: null });
const anyCampaignYes = trigger({ type: 'campaign_reply', campaignId: null, button: 'Yes' });
const diwali = trigger({ type: 'campaign_reply', campaignId: DIWALI, button: null });
const diwaliYes = trigger({ type: 'campaign_reply', campaignId: DIWALI, button: 'Yes' });
const keyword = trigger({ type: 'keyword', keywords: ['yes'], match: 'exact' });
const any = trigger({ type: 'any_message' });
const started = trigger({ type: 'conversation_started' });

const tap = (campaignId: string, buttonText: string | null): CampaignReplyContext => ({
  campaignId,
  buttonText,
});
const at = (t: AutomationTrigger, campaign: CampaignReplyContext | null, text = 'Yes') =>
  matchTrigger(t, { text, newCase: true, campaign });

describe('the campaign reply trigger (ADR-414)', () => {
  it('is a trigger started by customer messages, with business hours and a cooldown', () => {
    expect(TRIGGER_TYPES).toContain('campaign_reply');
    expect(TRIGGER_LABELS.campaign_reply).toBe('A customer replies to a campaign message');
    const parsed = parseTrigger({
      type: 'campaign_reply',
      campaignId: DIWALI,
      button: '  Yes,   please ',
      hours: 'open',
      cooldownMinutes: 30,
    });
    expect(parsed).toEqual({
      ok: true,
      trigger: {
        type: 'campaign_reply',
        campaignId: DIWALI,
        button: 'Yes, please',
        hours: 'open',
        cooldownMinutes: 30,
      },
    });
    // Business hours and the cooldown are required and bounded, as for the other message triggers.
    for (const bad of [
      { campaignId: null, button: null, hours: 'any' },
      { campaignId: null, button: null, hours: 'any', cooldownMinutes: 1441 },
      { campaignId: null, button: null, hours: 'sometimes', cooldownMinutes: 0 },
    ]) {
      expect(parseTrigger({ type: 'campaign_reply', ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('chooses any campaign or one by id, and any reply or a button of at most 25 characters', () => {
    const refusal = (input: Record<string, unknown>) => {
      const parsed = parseTrigger({
        type: 'campaign_reply',
        hours: 'any',
        cooldownMinutes: 0,
        ...input,
      });
      return parsed.ok ? null : parsed.message;
    };
    expect(refusal({ campaignId: 'diwali', button: null })).toBe(
      'Choose a campaign, or any campaign.',
    );
    expect(refusal({ button: null })).not.toBeNull();
    expect(refusal({ campaignId: null })).not.toBeNull();
    expect(refusal({ campaignId: null, button: '   ' })).toBe(
      'Enter the button’s text, or choose any reply.',
    );
    expect(refusal({ campaignId: null, button: 'x'.repeat(26) })).toBe(
      'A quick-reply button’s text has at most 25 characters.',
    );
    expect(refusal({ campaignId: null, button: 'x'.repeat(25) })).toBeNull();
    expect(refusal({ campaignId: null, button: null })).toBeNull();
  });

  it('starts only from a reply to a campaign message, of the chosen campaign and button', () => {
    expect(at(anyCampaign, null)).toBeNull();
    expect(at(anyCampaign, tap(DIWALI, null))).toBe(3);
    expect(at(anyCampaign, tap(SUMMER, 'No'))).toBe(3);
    expect(at(diwali, tap(DIWALI, null))).toBe(1);
    expect(at(diwali, tap(SUMMER, null))).toBeNull();
    expect(at(anyCampaignYes, tap(SUMMER, 'Yes'))).toBe(2);
    expect(at(anyCampaignYes, tap(SUMMER, 'No'))).toBeNull();
    // A quoting reply has no button, so it never matches a trigger that names one, whatever it says.
    expect(at(anyCampaignYes, tap(SUMMER, null), 'Yes')).toBeNull();
    expect(at(diwaliYes, tap(DIWALI, 'Yes'))).toBe(0);
    expect(at(diwaliYes, tap(DIWALI, 'No'))).toBeNull();
    expect(at(diwaliYes, tap(SUMMER, 'Yes'))).toBeNull();
  });

  it('compares a button’s text apart from case and spacing, emoji and punctuation included', () => {
    expect(campaignButtonKey('  Yes,   PLEASE ')).toBe('yes, please');
    expect(campaignButtonKey('Yes, please')).not.toBe(campaignButtonKey('Yes please'));
    const thumbs = trigger({ type: 'campaign_reply', campaignId: null, button: '👍 Interested' });
    expect(at(thumbs, tap(DIWALI, '👍  interested'))).toBe(2);
    expect(at(thumbs, tap(DIWALI, 'Interested'))).toBeNull();
    // Composed and decomposed forms of the same letters are the same text.
    const cafe = trigger({ type: 'campaign_reply', campaignId: null, button: 'Café' });
    expect(at(cafe, tap(DIWALI, 'Café'))).toBe(2);
  });

  it('ranks every campaign reply above every keyword, and the chosen campaign above a button', () => {
    const ranks = [diwaliYes, diwali, anyCampaignYes, anyCampaign, keyword, started, any].map((t) =>
      at(t, tap(DIWALI, 'Yes')),
    );
    expect(ranks).toEqual([0, 1, 2, 3, 4, 7, 8]);
    // Without a campaign message the keyword and message triggers rank as before (ADR-240).
    expect([keyword, started, any].map((t) => at(t, null))).toEqual([4, 7, 8]);
    // What each rank records as the run's trigger.
    expect(TRIGGER_TYPE_OF_RANK).toEqual([
      'campaign_reply',
      'campaign_reply',
      'campaign_reply',
      'campaign_reply',
      'keyword',
      'keyword',
      'keyword',
      'conversation_started',
      'any_message',
    ]);
    // Order messages and the API still never start from a message, a campaign reply included.
    expect(at({ type: 'store_event' }, tap(DIWALI, 'Yes'))).toBeNull();
    expect(at({ type: 'api', inputs: [] }, tap(DIWALI, 'Yes'))).toBeNull();
  });

  it('accepts replies for as long as attribution counts them for the campaign', () => {
    expect(CAMPAIGN_REPLY_HOURS).toBe(72);
    expect(CAMPAIGN_REPLY_HOURS).toBe(ATTRIBUTION_WINDOW_HOURS);
  });

  it('is described in words, without the campaign’s name', () => {
    expect(describeTrigger(anyCampaign)).toBe('A customer replies to any campaign');
    expect(describeTrigger(diwaliYes)).toBe(
      'A customer replies to the chosen campaign by tapping “Yes”',
    );
    expect(describeTrigger({ ...diwali, hours: 'closed' } as AutomationTrigger)).toBe(
      'A customer replies to the chosen campaign while the business is closed',
    );
    expect(triggerIssues(diwali, null)).toEqual([]);
  });
});

describe('the campaign reply trigger’s campaign (ADR-414)', () => {
  const campaigns = new Map<string, CampaignReference>([
    [DIWALI, { id: DIWALI, name: 'Diwali', channelAccountId: NUMBER, buttons: ['Yes', 'No'] }],
    [SUMMER, { id: SUMMER, name: 'Summer', channelAccountId: null, buttons: [] }],
  ]);

  it('must be one of the company’s, sending from the automation’s number', () => {
    expect(campaignTriggerIssues(diwali, NUMBER, campaigns)).toEqual([]);
    expect(campaignTriggerIssues(diwali, null, campaigns)).toEqual([]);
    expect(campaignTriggerIssues(anyCampaign, OTHER_NUMBER, campaigns)).toEqual([]);
    expect(campaignTriggerIssues(diwali, OTHER_NUMBER, campaigns)).toEqual([
      {
        level: 'error',
        nodeId: null,
        message:
          '“Diwali” sends from another WhatsApp number, so replies to it never reach this automation. Choose its number or every number.',
      },
    ]);
    const unknown = trigger({
      type: 'campaign_reply',
      campaignId: '0190a3e4-9999-7000-8000-000000000009',
      button: null,
    });
    expect(campaignTriggerIssues(unknown, NUMBER, campaigns)).toEqual([
      {
        level: 'error',
        nodeId: null,
        message: 'The chosen campaign is not one of this company’s. Choose another campaign.',
      },
    ]);
    // Without the campaigns (a member who cannot see them) the server checks it.
    expect(campaignTriggerIssues(unknown, NUMBER, undefined)).toEqual([]);
    // Other triggers have no campaign.
    expect(campaignTriggerIssues(keyword, OTHER_NUMBER, campaigns)).toEqual([]);
  });

  it('warns when none of the campaign’s templates has the chosen button', () => {
    expect(campaignTriggerIssues(diwaliYes, NUMBER, campaigns)).toEqual([]);
    const shouting = trigger({ type: 'campaign_reply', campaignId: DIWALI, button: ' YES ' });
    expect(campaignTriggerIssues(shouting, NUMBER, campaigns)).toEqual([]);
    const maybe = trigger({ type: 'campaign_reply', campaignId: DIWALI, button: 'Maybe' });
    expect(campaignTriggerIssues(maybe, NUMBER, campaigns)).toEqual([
      {
        level: 'warning',
        nodeId: null,
        message:
          'None of the templates of “Diwali” has a quick-reply button “Maybe”: until one does, no reply starts this automation.',
      },
    ]);
    const summerYes = trigger({ type: 'campaign_reply', campaignId: SUMMER, button: 'Yes' });
    expect(campaignTriggerIssues(summerYes, NUMBER, campaigns).map((i) => i.level)).toEqual([
      'warning',
    ]);
  });
});

describe('campaign fields in texts (ADR-414)', () => {
  const graph = graphOf({
    version: 1,
    start: 'hi',
    nodes: [
      {
        id: 'hi',
        type: 'send_text',
        text: 'Thanks for answering {{campaign.name}} ({{campaign.variant}}): {{ campaign.BUTTON }}',
        next: 'call',
      },
      {
        id: 'call',
        type: 'http_request',
        method: 'POST',
        url: 'https://crm.example.com/leads?campaign={{campaign.name}}',
        headers: [],
        body: '{"button":"{{campaign.button}}"}',
        save: [],
        next: null,
        failureNext: null,
      },
    ],
  });

  it('work only in automations started by a reply to a campaign', () => {
    expect(checkGraph(graph, { campaignReply: true }).filter((i) => i.level === 'error')).toEqual(
      [],
    );
    const misplaced = checkGraph(graph, {}).filter((i) => i.level === 'error');
    expect(misplaced.map((i) => [i.nodeId, i.message])).toEqual([
      [
        'hi',
        '{{campaign.name}} is a campaign field: campaign fields work only in automations started by a reply to a campaign.',
      ],
      [
        'hi',
        '{{campaign.variant}} is a campaign field: campaign fields work only in automations started by a reply to a campaign.',
      ],
      [
        'hi',
        '{{ campaign.BUTTON }} is a campaign field: campaign fields work only in automations started by a reply to a campaign.',
      ],
      [
        'call',
        '{{campaign.name}} is a campaign field: campaign fields work only in automations started by a reply to a campaign.',
      ],
      [
        'call',
        '{{campaign.button}} is a campaign field: campaign fields work only in automations started by a reply to a campaign.',
      ],
    ]);
    // An unknown campaign field is an unknown placeholder, and the message names the fields.
    const unknown = graphOf({
      version: 1,
      start: 'hi',
      nodes: [{ id: 'hi', type: 'send_text', text: 'Hi {{campaign.id}}', next: null }],
    });
    expect(checkGraph(unknown, { campaignReply: true }).map((i) => i.message)).toEqual([
      'Unknown placeholder {{campaign.id}}. Use {{name}}, {{company}}, {{answer.<name>}} or {{campaign.<field>}}.',
    ]);
    expect(Object.keys(CAMPAIGN_PLACEHOLDERS)).toEqual(['name', 'variant', 'button']);
  });

  it('read the campaign the run answers, empty when it lacks a value', () => {
    const values = {
      contactName: 'Asha',
      companyName: 'Cora',
      variables: {},
      campaign: campaignPlaceholderValues({
        campaignId: DIWALI,
        name: 'Diwali offers',
        variant: 'B',
        buttonText: 'Yes',
      }),
    };
    expect(renderText('{{campaign.name}}/{{campaign.variant}}/{{campaign.button}}', values)).toBe(
      'Diwali offers/B/Yes',
    );
    expect(renderHttpText('{{campaign.name}}', values, encodeURIComponent)).toBe('Diwali%20offers');
    // A quoting reply has no button; a test run no variant.
    const quoted = campaignPlaceholderValues({
      campaignId: DIWALI,
      name: 'Diwali',
      variant: null,
      buttonText: null,
    });
    expect(quoted).toEqual({ name: 'Diwali', variant: '', button: '' });
    expect(campaignPlaceholderValues(null)).toBeNull();
    // A run that answers no campaign reads empty texts.
    expect(renderText('[{{campaign.name}}]', { ...values, campaign: null })).toBe('[]');
  });

  it('are filled in when a step runs', () => {
    const facts: RunFacts = {
      contactName: 'Asha',
      companyName: 'Cora',
      tags: new Set(),
      conversationTags: new Set(),
      fields: {},
      businessOpen: true,
      campaign: { name: 'Diwali', variant: 'C', button: 'Yes' },
    };
    const result = advance({
      graph,
      state: initialRunState(graph),
      event: { kind: 'continue' },
      facts,
      runId: '0190a3e4-5555-7000-8000-000000000005',
      now: new Date('2026-10-21T10:00:00Z'),
    });
    expect(result.effects).toContainEqual({
      kind: 'send_text',
      text: 'Thanks for answering Diwali (C): Yes',
    });
  });
});

describe('finding the campaign message a reply answers (ADR-414)', () => {
  /** A transaction whose one read answers `rows`; a second read fails the test. */
  function answering(rows: unknown[] | null) {
    let reads = 0;
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => {
        reads += 1;
        if (!rows || reads > 1) throw new Error('an unexpected read');
        return Promise.resolve(rows);
      },
    };
    return {
      tx: { select: () => chain } as unknown as Parameters<typeof findCampaignReply>[0],
      reads: () => reads,
    };
  }
  const input = {
    tenantId: '0190a3e4-6666-7000-8000-000000000006',
    channelAccountId: NUMBER,
    contactId: '0190a3e4-7777-7000-8000-000000000007',
    contextExternalId: 'wamid.HBgLOTE5ODQ1MDEyMzQ1',
    buttonText: null,
    sentAt: new Date('2026-10-21T10:00:00Z'),
  };

  it('reads nothing for a message that quotes no message', async () => {
    const none = answering(null);
    expect(await findCampaignReply(none.tx, { ...input, contextExternalId: null })).toBeNull();
    expect(none.reads()).toBe(0);
  });

  it('gives the campaign and variant with the button trimmed and clipped, or null', async () => {
    const found = answering([{ campaignId: DIWALI, variant: 'D' }]);
    expect(await findCampaignReply(found.tx, { ...input, buttonText: '  Yes  ' })).toEqual({
      campaignId: DIWALI,
      variant: 'D',
      buttonText: 'Yes',
    });
    expect(found.reads()).toBe(1);
    const long = await findCampaignReply(answering([{ campaignId: DIWALI, variant: 'A' }]).tx, {
      ...input,
      buttonText: 'x'.repeat(70),
    });
    expect(long?.buttonText).toBe('x'.repeat(60));
    const blank = await findCampaignReply(answering([{ campaignId: DIWALI, variant: 'A' }]).tx, {
      ...input,
      buttonText: '   ',
    });
    expect(blank?.buttonText).toBeNull();
    expect(await findCampaignReply(answering([]).tx, input)).toBeNull();
  });
});

describe('the dispatcher’s campaign lookup (ADR-414)', () => {
  /**
   * A transaction whose reads answer `answers` in order, each query once awaited, and that records
   * every query; a write or a read past the answers fails the test.
   */
  function recording(answers: unknown[][]) {
    const queue = [...answers];
    let reads = 0;
    const query = () => {
      reads += 1;
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'for']) {
        chain[method] = () => chain;
      }
      chain.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
        const rows = queue.shift();
        return rows ? resolve(rows) : reject(new Error('an unexpected read'));
      };
      return chain;
    };
    return {
      tx: { select: query } as unknown as Parameters<typeof dispatchInboundToAutomation>[0],
      reads: () => reads,
      unread: () => queue.length,
    };
  }
  const graph = {
    version: 1,
    start: 'say',
    nodes: [{ id: 'say', type: 'send_text', text: 'Hi', next: null }],
  };
  const candidate = (name: string, trigger: unknown) => ({
    automationId: '0190a3e4-8888-7000-8000-00000000000' + String(name.length % 10),
    name,
    versionId: '0190a3e4-9999-7000-8000-000000000009',
    trigger,
    graph,
  });
  const keywordOnly = candidate('Prices', {
    type: 'keyword',
    keywords: ['price'],
    match: 'contains',
    hours: 'any',
    cooldownMinutes: 0,
  });
  const input = {
    tenantId: '0190a3e4-6666-7000-8000-000000000006',
    conversationId: '0190a3e4-aaaa-7000-8000-00000000000a',
    channelAccountId: NUMBER,
    contactId: '0190a3e4-7777-7000-8000-000000000007',
    assignedMembershipId: null,
    messageId: '0190a3e4-bbbb-7000-8000-00000000000b',
    text: 'Interested',
    newCase: false,
    consent: null,
    contextExternalId: 'wamid.HBgLOTE5ODQ1MDEyMzQ1',
    buttonText: 'Interested',
    sentAt: new Date('2026-10-21T10:00:00Z'),
  };
  const deps = {
    clock: { now: () => new Date('2026-10-21T10:00:01Z') },
  } as unknown as Parameters<typeof dispatchInboundToAutomation>[1];
  const company = [{ status: 'active', timezone: 'Asia/Kolkata' }];

  it('looks nothing up when no active automation starts from replies to a campaign', async () => {
    const reads = recording([[], company, [keywordOnly]]);
    expect(await dispatchInboundToAutomation(reads.tx, deps, input)).toBe('none');
    // The active run, the company and the candidates: no fourth read for a campaign message.
    expect(reads.reads()).toBe(3);
    expect(reads.unread()).toBe(0);
  });

  it('looks the campaign message up once when one does, and not for a message quoting nothing', async () => {
    const replies = candidate('Diwali follow-up', {
      type: 'campaign_reply',
      campaignId: null,
      button: null,
      hours: 'any',
      cooldownMinutes: 0,
    });
    // The lookup finds no campaign message, so nothing matches and nothing is written.
    const found = recording([[], company, [keywordOnly, replies], []]);
    expect(await dispatchInboundToAutomation(found.tx, deps, input)).toBe('none');
    expect(found.reads()).toBe(4);
    expect(found.unread()).toBe(0);
    const unquoted = recording([[], company, [keywordOnly, replies]]);
    expect(
      await dispatchInboundToAutomation(unquoted.tx, deps, { ...input, contextExternalId: null }),
    ).toBe('none');
    expect(unquoted.reads()).toBe(3);
  });
});
