import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import {
  EMAIL_NOTICES,
  EMAIL_NOTICE_KINDS,
  emailPreferencesSchema,
  wantsEmail,
} from './email-preferences';

const ctxOf = (roles: TenantRole[]) =>
  ({ permissions: permissionsForRoles(roles) }) as unknown as TenantContext;
const shown = (roles: TenantRole[]) =>
  EMAIL_NOTICE_KINDS.filter((kind) => EMAIL_NOTICES[kind].applies(ctxOf(roles)));

describe('members’ choice of notice emails (ADR-215)', () => {
  it('lists the kinds migration 0142 allows, in the same order', () => {
    const migration = readFileSync(
      new URL('../../../db/migrations/0142_member_email_opt_outs.sql', import.meta.url),
      'utf8',
    );
    const allowed = /CHECK \(email_opt_outs <@ ARRAY\[([^\]]+)\]::text\[\]\)/.exec(migration)?.[1];
    expect(allowed?.split(',').map((kind) => kind.trim().replace(/'/g, ''))).toEqual([
      ...EMAIL_NOTICE_KINDS,
    ]);
    expect(EMAIL_NOTICE_KINDS).toEqual([
      'mentions',
      'campaign_approvals',
      'campaign_reviews',
      'campaign_pauses',
      'campaign_completions',
    ]);
  });

  it('sends a kind unless the member turned it off', () => {
    expect(wantsEmail([], 'mentions')).toBe(true);
    expect(wantsEmail(['campaign_pauses'], 'mentions')).toBe(true);
    expect(wantsEmail(['campaign_pauses', 'mentions'], 'mentions')).toBe(false);
  });

  it('shows each member the kinds their role can receive', () => {
    expect(shown(['owner'])).toEqual([...EMAIL_NOTICE_KINDS]);
    expect(shown(['admin'])).toEqual([...EMAIL_NOTICE_KINDS]);
    expect(shown(['supervisor'])).toEqual(['mentions']);
    expect(shown(['agent'])).toEqual(['mentions']);
    expect(shown(['marketer'])).toEqual([
      'campaign_reviews',
      'campaign_pauses',
      'campaign_completions',
    ]);
    expect(shown(['analyst'])).toEqual([]);
    expect(shown(['billing'])).toEqual([]);
    expect(shown(['agent', 'marketer'])).toEqual([
      'mentions',
      'campaign_reviews',
      'campaign_pauses',
      'campaign_completions',
    ]);
  });

  it('names and explains each kind', () => {
    expect(
      Object.fromEntries(EMAIL_NOTICE_KINDS.map((kind) => [kind, EMAIL_NOTICES[kind].label])),
    ).toEqual({
      mentions: 'Mentions in notes',
      campaign_approvals: 'Campaigns waiting for approval',
      campaign_reviews: 'Your campaigns reviewed',
      campaign_pauses: 'Campaigns HyFib paused',
      campaign_completions: 'Your campaigns finished',
    });
    expect(EMAIL_NOTICES.mentions.description).toContain('10 minutes later');
  });

  it('takes the kinds turned off, and nothing else', () => {
    expect(emailPreferencesSchema.parse({ off: ['mentions'] })).toEqual({ off: ['mentions'] });
    expect(emailPreferencesSchema.parse({ off: [] })).toEqual({ off: [] });
    for (const wrong of [{ off: ['security'] }, { off: 'mentions' }, {}]) {
      expect(emailPreferencesSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});
