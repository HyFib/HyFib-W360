import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { GraphClient, isRateLimited } from '../messaging/graph';
import type { ApiContext } from '../api/context';
import { apiUsageVisibility } from '../api/message-template-drafts';
import { toMetaComponents, type TemplateDefinition } from './definition';
import {
  editReconciliation,
  editRefusalText,
  editTemplateRequest,
  sameTemplateContent,
  SENDING_CAMPAIGN_STATUSES,
  shapeChanged,
  TEMPLATE_EDIT_CONFIRM_WINDOW_MS,
  templateShape,
  templateEditBlocker,
  templateEditRefusal,
  type EditableTemplate,
} from './edit-model';
import { maskUsage, parseTemplateEditRef, templateEditRef, usageLabels } from './edit';

/** Editing a template Meta has (ADR-404): the request, the refusals and the sync's settling. */

const shipped: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'text', text: 'Order {{1}}', example: 'A-1' },
  body: { text: 'Hi {{1}}, your order {{2}} has shipped.', examples: ['Asha', 'A-1'] },
  footer: 'Reply STOP to opt out',
  buttons: [{ type: 'URL', text: 'Track', url: 'https://shop.example/t/{{1}}', example: 'A-1' }],
};
const changed: TemplateDefinition = {
  ...shipped,
  body: { text: 'Hello {{1}}, order {{2}} is on its way.', examples: ['Asha', 'A-1'] },
};

const approved = (overrides: Partial<EditableTemplate> = {}): EditableTemplate => ({
  status: 'approved',
  providerTemplateId: '9000000001',
  category: 'UTILITY',
  components: toMetaComponents(shipped),
  editState: null,
  ...overrides,
});

const refusal = async (
  row: EditableTemplate,
  def: TemplateDefinition,
  sending = 0,
  users: string[] = ['campaign “Diwali”'],
) => {
  const error = await templateEditRefusal(row, def, {
    sendingCampaigns: sending,
    users: () => users,
  });
  return error ? [error.code, error.publicMessage] : null;
};

describe('the request an edit sends', () => {
  it('carries the category unchanged and the components creation sends, nothing else', () => {
    const request = editTemplateRequest('UTILITY', changed);
    expect(Object.keys(request).sort()).toEqual(['category', 'components']);
    expect(request).toEqual({ category: 'UTILITY', components: toMetaComponents(changed) });
    // The template's category wins over one in the definition.
    expect(editTemplateRequest('MARKETING', changed).category).toBe('MARKETING');
    expect(editTemplateRequest('MARKETING', changed).components).toEqual(toMetaComponents(changed));
  });

  it('is posted to the template’s id with only those fields, and success: true is the answer', async () => {
    const asked: { url: URL; method: string; body: unknown }[] = [];
    let answer: unknown = { success: true };
    const graph = new GraphClient({
      baseUrl: 'https://graph.test',
      version: 'v26.0',
      fetchImpl: async (input, init) => {
        asked.push({
          url: new URL(String(input)),
          method: String(init?.method),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const request = {
      ...editTemplateRequest('UTILITY', changed),
      name: 'smuggled',
    } as ReturnType<typeof editTemplateRequest>;
    expect(await graph.editTemplate('9000000001', 'tok', request)).toEqual({
      ok: true,
      data: { edited: true },
    });
    expect(asked[0]?.method).toBe('POST');
    expect(asked[0]?.url.pathname).toBe('/v26.0/9000000001');
    expect(asked[0]?.body).toEqual({ category: 'UTILITY', components: toMetaComponents(changed) });
    // Any other answer cannot be read: the sync settles it.
    answer = { success: false };
    expect(await graph.editTemplate('9000000001', 'tok', request)).toMatchObject({
      ok: false,
      kind: 'unknown',
    });
    // A read by id gives Meta's default fields.
    answer = {
      id: '9000000001',
      name: 'order_shipped',
      language: 'en',
      status: 'PENDING',
      category: 'UTILITY',
      components: toMetaComponents(changed),
    };
    expect(await graph.getTemplate('9000000001', 'tok')).toEqual({
      ok: true,
      data: {
        id: '9000000001',
        name: 'order_shipped',
        language: 'en',
        status: 'PENDING',
        category: 'UTILITY',
        components: toMetaComponents(changed),
        rejectedReason: null,
        qualityScore: null,
      },
    });
    expect(asked[2]?.method).toBe('GET');
    expect(asked[2]?.url.search).toBe('');
  });
});

describe('when HyFib refuses an edit', () => {
  it('sends an edit of a template Meta has, of any status Meta gives', async () => {
    for (const status of [
      'approved',
      'rejected',
      'paused',
      'pending',
      'disabled',
      'in_appeal',
      'flagged',
      'unknown',
    ] as const) {
      expect(await refusal(approved({ status }), changed)).toBeNull();
    }
    // A failed edit can be sent again.
    expect(await refusal(approved({ editState: 'failed' }), changed)).toBeNull();
  });

  it('refuses a template Meta does not have, one deleted, and one whose edit is on its way', async () => {
    expect(await refusal(approved({ providerTemplateId: null, status: 'draft' }), changed)).toEqual(
      [
        'precondition_failed',
        'Meta does not have this template yet. Change the draft and submit it instead.',
      ],
    );
    for (const status of ['deleted', 'pending_deletion'] as const) {
      expect((await refusal(approved({ status }), changed))?.[0]).toBe('conflict');
    }
    expect(await refusal(approved({ editState: 'sending' }), changed)).toEqual([
      'precondition_failed',
      'An edit of this template is waiting for Meta’s answer. Edit it again once it has one.',
    ]);
  });

  it('refuses content HyFib cannot represent, and an authentication template', async () => {
    const media = [{ type: 'HEADER', format: 'IMAGE' }, ...toMetaComponents(shipped)];
    expect((await refusal(approved({ components: media }), changed))?.[0]).toBe('unsupported');
    expect((await refusal(approved({ category: 'AUTHENTICATION' }), changed))?.[0]).toBe(
      'unsupported',
    );
    expect(templateEditBlocker(approved({ components: media }))?.code).toBe('unsupported');
    expect(templateEditBlocker(approved())).toBeNull();
  });

  it('keeps the category, refuses no change, and refuses while a campaign is scheduled or sending', async () => {
    expect(await refusal(approved(), { ...changed, category: 'MARKETING' })).toEqual([
      'validation_failed',
      'The category cannot change in an edit: it stays utility.',
    ]);
    expect(await refusal(approved(), shipped)).toEqual([
      'precondition_failed',
      'This is the content Meta already has.',
    ]);
    // A different example is a change Meta reviews.
    expect(
      await refusal(approved(), {
        ...shipped,
        body: { ...shipped.body, examples: ['Ravi', 'A-2'] },
      }),
    ).toBeNull();
    expect(await refusal(approved(), changed, 1)).toEqual([
      'precondition_failed',
      'A campaign using this template is scheduled or sending. Wait until it finishes, or pause or cancel it, then edit the template.',
    ]);
    expect(SENDING_CAMPAIGN_STATUSES).toEqual(['scheduled', 'running']);
  });

  it('refuses a change of variables or buttons while something sends the template, wording alone allowed', async () => {
    const users = ['campaign “Diwali”', 'automation “Follow-up”'];
    // Wording only: allowed even while it is used, and the users are not even asked.
    let asked = 0;
    const ask = () => {
      asked += 1;
      return users;
    };
    expect(
      await templateEditRefusal(approved(), changed, { sendingCampaigns: 0, users: ask }),
    ).toBe(null);
    expect(asked).toBe(0);
    const extraVariable: TemplateDefinition = {
      ...changed,
      body: { text: 'Hello {{1}}, order {{2}} arrives {{3}}.', examples: ['Asha', 'A-1', 'today'] },
    };
    expect(await refusal(approved(), extraVariable, 0, users)).toEqual([
      'precondition_failed',
      'This edit changes the template’s variables or buttons, which campaign “Diwali”, automation “Follow-up” rely on. Change those first so they no longer use it, or add a new template instead.',
    ]);
    // One user is enough.
    expect(await refusal(approved(), extraVariable, 0, ['campaign “Diwali”'])).toEqual([
      'precondition_failed',
      'This edit changes the template’s variables or buttons, which campaign “Diwali” rely on. Change those first so they no longer use it, or add a new template instead.',
    ]);
    // More than three are counted.
    expect((await refusal(approved(), extraVariable, 0, ['a', 'b', 'c', 'd', 'e']))?.[1]).toContain(
      'which a, b, c and 2 more rely on',
    );
    // Unused: the same change is allowed.
    expect(await refusal(approved(), extraVariable, 0, [])).toBeNull();
  });
});

describe('a template’s shape', () => {
  const quick: TemplateDefinition = {
    ...shipped,
    buttons: [
      { type: 'QUICK_REPLY', text: 'Yes' },
      { type: 'URL', text: 'Track', url: 'https://shop.example/t/{{1}}', example: 'A-1' },
      { type: 'URL', text: 'Help', url: 'https://shop.example/help' },
    ],
  };
  const shape = (def: TemplateDefinition) => templateShape(def.category, toMetaComponents(def));

  it('counts the values a send fills and lists link positions and quick replies', () => {
    expect(shape(quick)).toEqual({
      header: 1,
      body: 2,
      links: [1],
      quickReplies: [{ index: 0, title: 'Yes' }],
    });
    expect(templateShape('UTILITY', [{ type: 'HEADER', format: 'IMAGE' }])).toBeNull();
  });

  it('changes with a variable, a link, a quick reply’s title or position, not with wording', () => {
    const before = toMetaComponents(quick);
    const changedShape = (def: TemplateDefinition) =>
      shapeChanged('UTILITY', before, toMetaComponents(def));
    // Wording of the body, the header, the footer, a static link's text and address: no change.
    expect(
      changedShape({
        ...quick,
        header: { type: 'text', text: 'Parcel {{1}}', example: 'A-1' },
        body: { text: 'Hello {{1}}, parcel {{2}} left.', examples: ['Asha', 'A-1'] },
        footer: null,
        buttons: [
          { type: 'QUICK_REPLY', text: 'Yes' },
          { type: 'URL', text: 'Follow', url: 'https://shop.example/f/{{1}}', example: 'A-1' },
          { type: 'URL', text: 'FAQ', url: 'https://shop.example/faq' },
        ],
      }),
    ).toBe(false);
    expect(changedShape({ ...quick, header: { type: 'none' } })).toBe(true);
    expect(changedShape({ ...quick, body: { text: 'Hello {{1}}.', examples: ['Asha'] } })).toBe(
      true,
    );
    expect(
      changedShape({
        ...quick,
        buttons: [{ type: 'QUICK_REPLY', text: 'Sure' }, ...quick.buttons.slice(1)],
      }),
    ).toBe(true);
    expect(changedShape({ ...quick, buttons: [...quick.buttons].reverse() })).toBe(true);
    expect(
      changedShape({
        ...quick,
        buttons: [
          quick.buttons[0]!,
          { type: 'URL', text: 'Track', url: 'https://shop.example/t' },
          quick.buttons[2]!,
        ],
      }),
    ).toBe(true);
    // Content HyFib cannot read counts as changed.
    expect(shapeChanged('UTILITY', [{ type: 'HEADER', format: 'IMAGE' }], before)).toBe(true);
  });
});

describe('comparing content', () => {
  it('ignores key order, type case and how an example is given, and sees a changed text', () => {
    const meta = toMetaComponents(shipped);
    const listed = meta.map((c) =>
      c.type === 'BUTTONS'
        ? {
            buttons: [
              { example: 'A-1', url: 'https://shop.example/t/{{1}}', text: 'Track', type: 'url' },
            ],
            type: 'buttons',
          }
        : Object.fromEntries(Object.entries(c).reverse()),
    );
    expect(sameTemplateContent('UTILITY', meta, listed)).toBe(true);
    expect(sameTemplateContent('UTILITY', meta, toMetaComponents(changed))).toBe(false);
    // Content HyFib cannot read is compared as JSON.
    const media = [{ type: 'HEADER', format: 'IMAGE' }];
    expect(sameTemplateContent('UTILITY', media, [{ format: 'IMAGE', type: 'HEADER' }])).toBe(true);
    expect(sameTemplateContent('UTILITY', media, [{ type: 'HEADER', format: 'VIDEO' }])).toBe(
      false,
    );
  });
});

describe('settling an edit whose answer was lost', () => {
  const requestedAt = new Date('2026-10-21T10:00:00.000Z');
  const sending = {
    state: 'sending' as const,
    components: toMetaComponents(changed),
    requestedAt,
    deferredUntil: null,
  };
  const at = (ms: number) => new Date(requestedAt.getTime() + ms);

  it('confirms it when Meta lists the content sent, at any time', () => {
    expect(editReconciliation(sending, 'UTILITY', toMetaComponents(changed), at(60 * 60_000))).toBe(
      'confirmed',
    );
    expect(editReconciliation(sending, 'UTILITY', toMetaComponents(changed), at(0))).toBe(
      'confirmed',
    );
  });

  it('waits for the window, then calls it unconfirmed', () => {
    const old = toMetaComponents(shipped);
    expect(editReconciliation(sending, 'UTILITY', old, at(TEMPLATE_EDIT_CONFIRM_WINDOW_MS))).toBe(
      'waiting',
    );
    expect(
      editReconciliation(sending, 'UTILITY', old, at(TEMPLATE_EDIT_CONFIRM_WINDOW_MS + 1)),
    ).toBe('unconfirmed');
  });

  it('counts the window from a deferral for Meta’s pause when it is later', () => {
    const deferred = { ...sending, deferredUntil: at(30 * 60_000) };
    const old = toMetaComponents(shipped);
    expect(editReconciliation(deferred, 'UTILITY', old, at(35 * 60_000))).toBe('waiting');
    expect(editReconciliation(deferred, 'UTILITY', old, at(41 * 60_000))).toBe('unconfirmed');
    // An earlier deferral does not shorten the window.
    const early = { ...sending, deferredUntil: at(-60 * 60_000) };
    expect(editReconciliation(early, 'UTILITY', old, at(5 * 60_000))).toBe('waiting');
  });

  it('confirms a failed edit Meta applied late, and leaves other failed edits and none alone', () => {
    const remote = toMetaComponents(changed);
    expect(editReconciliation({ ...sending, state: null }, 'UTILITY', remote, at(0))).toBe('none');
    expect(
      editReconciliation({ ...sending, state: 'failed' }, 'UTILITY', remote, at(60 * 60_000)),
    ).toBe('confirmed');
    expect(
      editReconciliation(
        { ...sending, state: 'failed' },
        'UTILITY',
        toMetaComponents(shipped),
        at(60 * 60_000),
      ),
    ).toBe('none');
    expect(editReconciliation({ ...sending, components: null }, 'UTILITY', remote, at(0))).toBe(
      'none',
    );
  });
});

describe('Meta’s refusal as members read it', () => {
  it('gives Meta’s code and message', () => {
    expect(
      editRefusalText({
        kind: 'permanent',
        code: 2388299,
        httpStatus: 400,
        title: 'OAuthException',
        detail: 'Template edits are limited',
      }),
    ).toBe('Meta refused the edit (code 2388299): Template edits are limited');
    expect(editRefusalText({ kind: 'permanent', httpStatus: 400, title: 'HTTP 400' })).toBe(
      'Meta refused the edit (HTTP 400): HTTP 400',
    );
    expect(
      editRefusalText({ kind: 'auth', code: 190, title: 'OAuthException', detail: 'bad' }),
    ).toBe(
      'Meta rejected the stored credential (code 190): bad. Reconnect the WhatsApp account and edit the template again.',
    );
  });
});

describe('who sees where a template is used', () => {
  it('every role that submits templates reads campaigns, automations and stores', () => {
    // templateUsage names them to members with templates.submit (ADR-404); the service also hides
    // names from a member whose company took one of these away.
    const submitters = Object.entries(ROLE_PERMISSIONS).filter(([, p]) =>
      p.has('templates.submit'),
    );
    expect(submitters.map(([role]) => role).sort()).toEqual(['admin', 'marketer', 'owner']);
    for (const [, permissions] of submitters) {
      for (const read of ['campaigns.read', 'automations.read', 'commerce.read'] as const) {
        expect(permissions.has(read)).toBe(true);
      }
    }
  });

  it('names what uses it, or says what it is when the name is hidden', () => {
    expect(
      usageLabels({
        campaigns: [
          { id: 'c1', name: 'Diwali', status: 'draft' },
          { id: 'c2', name: null, status: 'paused' },
        ],
        automations: [{ id: 'a1', name: 'Follow-up', status: 'active' }],
        automationRuns: [
          { id: 'a1', name: 'Follow-up', runs: 2 },
          { id: 'a2', name: 'Old flow', runs: 1 },
          { id: 'a3', name: null, runs: 300 },
        ],
        storeRules: [
          { id: 'r1', storeName: 'Asha Stores', event: 'order_shipped', enabled: true },
          { id: 'r2', storeName: null, event: 'cart_reminder', enabled: false },
        ],
      }),
    ).toEqual([
      'campaign “Diwali”',
      'a campaign',
      'automation “Follow-up”',
      'automation “Old flow” (1 run in progress)',
      'an automation (300 runs in progress)',
      'the Asha Stores order shipped message',
      'a store’s cart reminder message',
    ]);
  });
});

describe('the edit job’s reference', () => {
  it('names the template and the edit, and nothing else', () => {
    const template = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
    const edit = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f09';
    expect(parseTemplateEditRef(templateEditRef(template, edit))).toEqual({
      templateId: template,
      editId: edit,
    });
    for (const ref of [template, `${template}:`, `${template}:${edit}:x`, `${template}:nope`, '']) {
      expect(parseTemplateEditRef(ref)).toBeNull();
    }
  });
});

describe('names a caller may not read', () => {
  const usage = {
    campaigns: [{ id: 'c1', name: 'Diwali', status: 'draft' as const }],
    automations: [{ id: 'a1', name: 'Follow-up', status: 'active' }],
    automationRuns: [{ id: 'a2', name: 'Old flow', runs: 3 }],
    storeRules: [{ id: 'r1', storeName: 'Asha Stores', event: 'order_shipped', enabled: true }],
  };

  it('are left out of the usage list and of a refusal’s labels, each kind by its own permission', () => {
    expect(
      usageLabels(maskUsage(usage, { campaigns: true, automations: true, stores: true })),
    ).toEqual([
      'campaign “Diwali”',
      'automation “Follow-up”',
      'automation “Old flow” (3 runs in progress)',
      'the Asha Stores order shipped message',
    ]);
    expect(
      usageLabels(maskUsage(usage, { campaigns: false, automations: true, stores: true })),
    ).toEqual([
      'a campaign',
      'automation “Follow-up”',
      'automation “Old flow” (3 runs in progress)',
      'the Asha Stores order shipped message',
    ]);
    expect(
      usageLabels(maskUsage(usage, { campaigns: true, automations: false, stores: true })),
    ).toEqual([
      'campaign “Diwali”',
      'an automation',
      'an automation (3 runs in progress)',
      'the Asha Stores order shipped message',
    ]);
    expect(
      usageLabels(maskUsage(usage, { campaigns: true, automations: true, stores: false }))[3],
    ).toBe('a store’s order shipped message');
  });

  it('leave out the ids of what the caller may not read, and list a published automation once', () => {
    const masked = maskUsage(
      {
        ...usage,
        automationRuns: [...usage.automationRuns, { id: 'a1', name: 'Follow-up', runs: 2 }],
      },
      { campaigns: false, automations: false, stores: false },
    );
    expect(masked).toEqual({
      campaigns: [{ id: null, name: null, status: 'draft' }],
      automations: [{ id: null, name: null, status: 'active' }],
      automationRuns: [{ id: null, name: null, runs: 3 }],
      storeRules: [{ id: null, storeName: null, event: 'order_shipped', enabled: true }],
    });
    expect(usageLabels(masked)).toEqual([
      'a campaign',
      'an automation',
      'an automation (3 runs in progress)',
      'a store’s order shipped message',
    ]);
  });

  it('for a key: campaigns with campaigns.read, never automations or stores', () => {
    const key = (scopes: string[]) =>
      ({
        tenant: { id: 't', status: 'active' },
        key: { id: 'k', scopes: new Set(scopes) },
        planScopes: null,
      }) as unknown as ApiContext;
    expect(apiUsageVisibility(key(['templates.submit']))).toEqual({
      campaigns: false,
      automations: false,
      stores: false,
    });
    expect(apiUsageVisibility(key(['templates.submit', 'campaigns.read', 'orders.read']))).toEqual({
      campaigns: true,
      automations: false,
      stores: false,
    });
  });
});

describe('which refusals prove Meta did nothing', () => {
  it('a retryable 429 or rate-limit code; not a 5xx, a transient code or another kind', () => {
    const retryable = 'retryable' as const;
    expect(isRateLimited({ kind: retryable, httpStatus: 429 })).toBe(true);
    for (const code of [4, 17, 32, 613, 80007, 130429, 131056]) {
      expect(isRateLimited({ kind: retryable, httpStatus: 400, code })).toBe(true);
    }
    expect(isRateLimited({ kind: retryable, httpStatus: 500, code: 1 })).toBe(false);
    expect(isRateLimited({ kind: retryable, httpStatus: 500, code: 2 })).toBe(false);
    expect(isRateLimited({ kind: retryable, httpStatus: 503, code: 131000 })).toBe(false);
    expect(isRateLimited({ kind: retryable })).toBe(false);
    // Only a retryable answer: an auth or permanent kind with such a code is not one.
    expect(isRateLimited({ kind: 'auth', httpStatus: 400, code: 4 })).toBe(false);
    expect(isRateLimited({ kind: 'permanent', httpStatus: 429 })).toBe(false);
  });
});
