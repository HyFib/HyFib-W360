import { readFileSync, readdirSync } from 'node:fs';
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
  it('lists the kinds the latest migration allows (0154), in the same order', () => {
    const dir = new URL('../../../db/migrations/', import.meta.url);
    // The check as the last migration that sets it leaves it.
    const allowed = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map(
        (name) =>
          /CHECK \(email_opt_outs <@ ARRAY\[([^\]]+)\]::text\[\]\)/.exec(
            readFileSync(new URL(name, dir), 'utf8'),
          )?.[1],
      )
      .filter((list) => list !== undefined)
      .pop();
    expect(allowed?.split(',').map((kind) => kind.trim().replace(/'/g, ''))).toEqual([
      ...EMAIL_NOTICE_KINDS,
    ]);
    expect(EMAIL_NOTICE_KINDS).toEqual([
      'mentions',
      'reply_overdue',
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
    expect(shown(['supervisor'])).toEqual(['mentions', 'reply_overdue']);
    expect(shown(['agent'])).toEqual(['mentions', 'reply_overdue']);
    expect(shown(['marketer'])).toEqual([
      'campaign_reviews',
      'campaign_pauses',
      'campaign_completions',
    ]);
    expect(shown(['analyst'])).toEqual([]);
    expect(shown(['billing'])).toEqual([]);
    expect(shown(['agent', 'marketer'])).toEqual([
      'mentions',
      'reply_overdue',
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
      reply_overdue: 'Customers waiting past the reply target',
      campaign_approvals: 'Campaigns waiting for approval',
      campaign_reviews: 'Your campaigns reviewed',
      campaign_pauses: 'Campaigns HyFib paused',
      campaign_completions: 'Your campaigns finished',
    });
    expect(EMAIL_NOTICES.mentions.description).toContain('10 minutes later');
    expect(EMAIL_NOTICES.reply_overdue.description).toContain('first-response target');
  });

  it('takes the kinds turned off, and nothing else', () => {
    expect(emailPreferencesSchema.parse({ off: ['mentions'] })).toEqual({ off: ['mentions'] });
    expect(emailPreferencesSchema.parse({ off: [] })).toEqual({ off: [] });
    for (const wrong of [{ off: ['security'] }, { off: 'mentions' }, {}]) {
      expect(emailPreferencesSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});
