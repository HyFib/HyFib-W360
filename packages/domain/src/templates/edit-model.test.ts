import { describe, expect, it } from 'vitest';
import { GraphClient } from '../messaging/graph';
import { toMetaComponents, type TemplateDefinition } from './definition';
import {
  editReconciliation,
  editRefusalText,
  editTemplateRequest,
  sameTemplateContent,
  TEMPLATE_EDIT_CONFIRM_WINDOW_MS,
  templateEditBlocker,
  templateEditRefusal,
  type EditableTemplate,
} from './edit-model';

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

const refusal = (row: EditableTemplate, def: TemplateDefinition, sending = 0) => {
  const error = templateEditRefusal(row, def, sending);
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
  it('sends an edit of a template Meta has, of any status Meta gives', () => {
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
      expect(refusal(approved({ status }), changed)).toBeNull();
    }
    // A failed edit can be sent again.
    expect(refusal(approved({ editState: 'failed' }), changed)).toBeNull();
  });

  it('refuses a template Meta does not have, one deleted, and one whose edit is on its way', () => {
    expect(refusal(approved({ providerTemplateId: null, status: 'draft' }), changed)).toEqual([
      'precondition_failed',
      'Meta does not have this template yet. Change the draft and submit it instead.',
    ]);
    for (const status of ['deleted', 'pending_deletion'] as const) {
      expect(refusal(approved({ status }), changed)?.[0]).toBe('conflict');
    }
    expect(refusal(approved({ editState: 'sending' }), changed)).toEqual([
      'precondition_failed',
      'An edit of this template is waiting for Meta’s answer. Edit it again once it has one.',
    ]);
  });

  it('refuses content HyFib cannot represent, and an authentication template', () => {
    const media = [{ type: 'HEADER', format: 'IMAGE' }, ...toMetaComponents(shipped)];
    expect(refusal(approved({ components: media }), changed)?.[0]).toBe('unsupported');
    expect(refusal(approved({ category: 'AUTHENTICATION' }), changed)?.[0]).toBe('unsupported');
    expect(templateEditBlocker(approved({ components: media }))?.code).toBe('unsupported');
    expect(templateEditBlocker(approved())).toBeNull();
  });

  it('keeps the category, refuses no change, and refuses while a campaign sends it', () => {
    expect(refusal(approved(), { ...changed, category: 'MARKETING' })).toEqual([
      'validation_failed',
      'The category cannot change in an edit: it stays utility.',
    ]);
    expect(refusal(approved(), shipped)).toEqual([
      'precondition_failed',
      'This is the content Meta already has.',
    ]);
    // A different example is a change Meta reviews.
    expect(
      refusal(approved(), { ...shipped, body: { ...shipped.body, examples: ['Ravi', 'A-2'] } }),
    ).toBeNull();
    expect(refusal(approved(), changed, 1)).toEqual([
      'precondition_failed',
      'A campaign using this template is sending. Pause it or wait until it finishes, then edit the template.',
    ]);
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

  it('leaves no edit, or a failed one, alone', () => {
    const remote = toMetaComponents(changed);
    expect(editReconciliation({ ...sending, state: null }, 'UTILITY', remote, at(0))).toBe('none');
    expect(editReconciliation({ ...sending, state: 'failed' }, 'UTILITY', remote, at(0))).toBe(
      'none',
    );
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
