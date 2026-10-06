import { describe, expect, it } from 'vitest';
import type { Database, TenantRole } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { ALLOWED_WHEN_SUSPENDED, permissionsForRoles } from '../authz/permissions';
import {
  createContactMergeService,
  mergeContactsSchema,
  mergeRefusalMessage,
  mergeSummarySchema,
  mergedConsent,
  planContactMerge,
  type MergeSide,
} from './merge';

const KEEP = '0192f3a4-5b6c-7d8e-9f00-112233445566';
const MERGE = '0192f3a4-5b6c-7d8e-9f00-112233445577';
const NUMBER_A = '0192f3a4-5b6c-7d8e-9f00-1122334455a1';
const NUMBER_B = '0192f3a4-5b6c-7d8e-9f00-1122334455b2';

const side = (overrides: Partial<MergeSide>): MergeSide => ({
  id: KEEP,
  displayName: null,
  phoneE164: null,
  email: null,
  attributes: {},
  source: 'manual',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  erased: false,
  tags: [],
  identities: [],
  conversations: [],
  consent: { marketing: null, utility: null },
  counts: {
    consentEvents: 0,
    deals: 0,
    tasks: 0,
    notes: 0,
    orders: 0,
    storeMessages: 0,
    campaignSends: 0,
    automationRuns: 0,
    flowAnswers: 0,
  },
  ...overrides,
});

const ctxOf = (roles: TenantRole[]) =>
  ({
    tenant: { id: 't', status: 'active' },
    membership: { id: 'm' },
    user: { id: 'u' },
    permissions: permissionsForRoles(roles),
    rolePermissions: permissionsForRoles(roles),
    plan: { modules: new Set() },
    mfa: { blocking: false },
  }) as unknown as TenantContext;

const unreachableDb = {
  run: () => {
    throw new Error('the database was reached');
  },
} as unknown as Database;

const service = createContactMergeService({ db: unreachableDb, clock: { now: () => new Date() } });

describe('merging contacts (ADR-224)', () => {
  it('keeps the stricter consent: any opt-out stands, and no opt-in is added', () => {
    // The merged contact's opt-out replaces whatever the kept contact had.
    expect(mergedConsent('opted_in', 'opted_out')).toEqual({
      result: 'opted_out',
      carriedOptOut: true,
      optInNotCarried: false,
    });
    expect(mergedConsent(null, 'opted_out')).toMatchObject({
      result: 'opted_out',
      carriedOptOut: true,
    });
    // The kept contact's opt-out stays, whatever the other had.
    expect(mergedConsent('opted_out', 'opted_in')).toEqual({
      result: 'opted_out',
      carriedOptOut: false,
      optInNotCarried: false,
    });
    expect(mergedConsent('opted_out', 'opted_out')).toMatchObject({
      result: 'opted_out',
      carriedOptOut: false,
    });
    // An opt-in only the merged contact had does not carry over.
    expect(mergedConsent(null, 'opted_in')).toEqual({
      result: null,
      carriedOptOut: false,
      optInNotCarried: true,
    });
    // The kept contact's opt-in stays when the other has none or also opted in.
    expect(mergedConsent('opted_in', null)).toEqual({
      result: 'opted_in',
      carriedOptOut: false,
      optInNotCarried: false,
    });
    expect(mergedConsent('opted_in', 'opted_in')).toMatchObject({
      result: 'opted_in',
      optInNotCarried: false,
    });
    expect(mergedConsent(null, null)).toMatchObject({ result: null, optInNotCarried: false });
  });

  it('keeps the kept contact’s details and fills the gaps from the other', () => {
    const plan = planContactMerge(
      side({
        displayName: 'Asha Rao',
        email: 'asha@example.com',
        attributes: { city: 'Pune', plan: 'gold' },
        tags: ['vip', 'pune'],
        consent: { marketing: 'opted_in', utility: null },
      }),
      side({
        id: MERGE,
        displayName: 'Asha',
        phoneE164: '+919845000001',
        email: 'asha.rao@example.net',
        attributes: { city: 'Mumbai', birthday: '1990-04-01', plan: 'gold' },
        tags: ['pune', 'store'],
        consent: { marketing: 'opted_out', utility: 'opted_in' },
      }),
    );
    expect(plan).toEqual({
      refusals: [],
      displayName: 'Asha Rao',
      phoneE164: '+919845000001',
      email: 'asha@example.com',
      attributes: { city: 'Pune', birthday: '1990-04-01', plan: 'gold' },
      droppedAttributes: ['city'],
      droppedName: 'Asha',
      droppedEmail: 'asha.rao@example.net',
      tags: ['pune', 'store', 'vip'],
      consent: {
        marketing: { result: 'opted_out', carriedOptOut: true, optInNotCarried: false },
        utility: { result: null, carriedOptOut: false, optInNotCarried: true },
      },
    });
    // Nothing is dropped when the other contact's details are missing or equal.
    expect(
      planContactMerge(
        side({ displayName: 'Asha', email: 'a@example.com' }),
        side({ id: MERGE, displayName: 'Asha', email: 'a@example.com' }),
      ),
    ).toMatchObject({ droppedName: null, droppedEmail: null, droppedAttributes: [] });
    expect(planContactMerge(side({}), side({ id: MERGE, displayName: 'Asha' }))).toMatchObject({
      displayName: 'Asha',
      droppedName: null,
    });
  });

  it('refuses contacts that cannot be merged, saying why', () => {
    const refusals = (keep: Partial<MergeSide>, merge: Partial<MergeSide>) =>
      planContactMerge(side(keep), side({ id: MERGE, ...merge })).refusals;
    expect(refusals({}, {})).toEqual([]);
    expect(planContactMerge(side({}), side({})).refusals).toEqual([{ code: 'same_contact' }]);
    expect(refusals({ erased: true }, {})).toEqual([{ code: 'erased' }]);
    expect(refusals({}, { erased: true })).toEqual([{ code: 'erased' }]);
    expect(refusals({ phoneE164: '+919845000001' }, { phoneE164: '+919845000002' })).toEqual([
      { code: 'both_phones' },
    ]);
    // One number between them is fine, on either side.
    expect(refusals({ phoneE164: '+919845000001' }, {})).toEqual([]);
    expect(refusals({}, { phoneE164: '+919845000002' })).toEqual([]);
    // Conversations on different company numbers move; one on the same number cannot.
    expect(
      refusals(
        { conversations: [{ channelAccountId: NUMBER_A, channelName: '+91 80 1111 1111' }] },
        { conversations: [{ channelAccountId: NUMBER_B, channelName: '+91 80 2222 2222' }] },
      ),
    ).toEqual([]);
    expect(
      refusals(
        { conversations: [{ channelAccountId: NUMBER_A, channelName: '+91 80 1111 1111' }] },
        {
          conversations: [
            { channelAccountId: NUMBER_B, channelName: '+91 80 2222 2222' },
            { channelAccountId: NUMBER_A, channelName: '+91 80 1111 1111' },
          ],
        },
      ),
    ).toEqual([{ code: 'same_number', channelName: '+91 80 1111 1111' }]);
    // Fifty tags between them are fine; fifty-one are not.
    const tags = (from: number, n: number) => Array.from({ length: n }, (_, i) => `t${from + i}`);
    expect(refusals({ tags: tags(0, 30) }, { tags: tags(10, 40) })).toEqual([]);
    expect(refusals({ tags: tags(0, 30) }, { tags: tags(10, 41) })).toEqual([
      { code: 'too_many_tags', count: 51 },
    ]);
  });

  it('explains each refusal as app.merge_contacts does', () => {
    expect(mergeRefusalMessage({ code: 'same_contact' })).toBe(
      'A contact cannot be merged into itself.',
    );
    expect(mergeRefusalMessage({ code: 'erased' })).toBe('An erased contact cannot be merged.');
    expect(mergeRefusalMessage({ code: 'both_phones' })).toBe(
      'Both contacts have a phone number. A contact keeps one number, so they stay separate.',
    );
    expect(mergeRefusalMessage({ code: 'same_number', channelName: '+91 80 1111 1111' })).toBe(
      'Both contacts have a conversation on +91 80 1111 1111. Conversations cannot be joined, so they stay separate.',
    );
    expect(mergeRefusalMessage({ code: 'same_number', channelName: null })).toContain(
      'on the same WhatsApp number.',
    );
    expect(mergeRefusalMessage({ code: 'too_many_tags', count: 51 })).toBe(
      'Together these contacts have 51 tags, more than the 50 a contact can have. Remove some first.',
    );
  });

  it('takes two contact ids, and reads back the counts the database returns', () => {
    expect(
      mergeContactsSchema.safeParse({ keepContactId: KEEP, mergeContactId: MERGE }).success,
    ).toBe(true);
    expect(mergeContactsSchema.safeParse({ keepContactId: KEEP }).success).toBe(false);
    expect(
      mergeContactsSchema.safeParse({ keepContactId: KEEP, mergeContactId: 'x' }).success,
    ).toBe(false);
    const summary = {
      identities: 1,
      conversations: 1,
      consentEvents: 2,
      tags: 3,
      deals: 0,
      tasks: 0,
      notes: 0,
      orders: 0,
      storeMessages: 0,
      campaignSends: 4,
      automationRuns: 0,
      flowSends: 0,
      flowAnswers: 0,
      conversationSources: 0,
      optOutsCarried: ['marketing'],
    };
    expect(mergeSummarySchema.parse(summary)).toEqual(summary);
    // Every count app.merge_contacts returns is kept, for the audit record.
    const { flowSends: _omitted, ...missing } = summary;
    expect(mergeSummarySchema.safeParse(missing).success).toBe(false);
    expect(mergeSummarySchema.safeParse({ ...summary, optOutsCarried: ['email'] }).success).toBe(
      false,
    );
  });

  it('is for owners and administrators, checked before the database', async () => {
    for (const role of ['agent', 'marketer', 'supervisor', 'analyst', 'billing'] as const) {
      await expect(service.previewMerge(ctxOf([role]), KEEP, MERGE)).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(
        service.mergeContacts(ctxOf([role]), { keepContactId: KEEP, mergeContactId: MERGE }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(service.previewMerge(ctxOf(['admin']), KEEP, 'nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      service.mergeContacts(ctxOf(['owner']), { keepContactId: KEEP, mergeContactId: 'nope' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(service.previewMerge(ctxOf(['admin']), KEEP, MERGE)).rejects.toThrow(
      'the database was reached',
    );
    // Not while the company is suspended: its owners can still erase contacts, but not merge them.
    const suspended = {
      ...ctxOf(['owner']),
      tenant: { id: 't', status: 'suspended' },
      permissions: new Set(
        [...permissionsForRoles(['owner'])].filter((p) => ALLOWED_WHEN_SUSPENDED.has(p)),
      ),
    } as unknown as TenantContext;
    expect(suspended.permissions.has('contacts.delete')).toBe(true);
    await expect(
      service.mergeContacts(suspended, { keepContactId: KEEP, mergeContactId: MERGE }),
    ).rejects.toMatchObject({ code: 'tenant_suspended' });
    // Following a link to a merged contact needs only contacts.read; a malformed id is no merge.
    expect(await service.mergedInto(ctxOf(['agent']), 'nope')).toBeNull();
    await expect(service.mergedInto(ctxOf(['analyst']), MERGE)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
