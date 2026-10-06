import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@w360/db';
import { assertCan, seesNumbersWhole, type TenantContext } from '../authz/context';
import {
  ALLOWED_WHEN_SUSPENDED,
  ROLE_PERMISSIONS,
  permissionsForRoles,
} from '../authz/permissions';
import {
  MASKABLE_ROLES,
  MASK_DOT,
  maskPhoneNumber,
  numberMaskingSchema,
  seesNumbers,
  shownNumber,
} from './number-masking';

const ctxOf = (permissions: Iterable<string>, roles: TenantRole[] = ['agent']) =>
  ({
    tenant: { id: 't', status: 'active', maskedNumberRoles: ['agent'] },
    membership: { id: 'm', roles },
    permissions: new Set(permissions),
    rolePermissions: permissionsForRoles(roles),
    plan: { modules: new Set() },
    mfa: { blocking: false },
  }) as unknown as TenantContext;

describe('hiding customers’ numbers (ADR-226)', () => {
  it('shows a few leading and trailing digits, a dot for every other, and hides at least three', () => {
    expect(maskPhoneNumber('+919845012345')).toBe('+919•••••••45');
    expect(maskPhoneNumber('+14155550123')).toBe('+141••••••23');
    expect(maskPhoneNumber('+4915123456789')).toBe('+491••••••••89');
    // A WhatsApp id has no plus.
    expect(maskPhoneNumber('919845012345')).toBe('919•••••••45');
    // Short numbers keep fewer digits, never fewer than three hidden.
    expect(maskPhoneNumber('+12345678')).toBe('+123•••78');
    expect(maskPhoneNumber('+123456')).toBe('+1•••56');
    expect(maskPhoneNumber('+1234')).toBe('+•••4');
    expect(maskPhoneNumber('+123')).toBe('+•••');
    for (const phone of ['+919845012345', '+14155550123', '+12345678', '+123456', '+1234']) {
      const masked = maskPhoneNumber(phone);
      const hidden = [...masked].filter((c) => c === MASK_DOT).length;
      expect(hidden, phone).toBeGreaterThanOrEqual(3);
      // One character per digit: the length shows, the digits do not.
      expect(masked.replace(/^\+/, '').length, phone).toBe(phone.replace(/\D/g, '').length);
      expect(masked, phone).not.toContain(phone.slice(1));
    }
  });

  it('gives a number whole only to members who may see it', () => {
    const whole = ctxOf(['contacts.read', 'contacts.view_numbers']);
    const masked = ctxOf(['contacts.read']);
    expect(seesNumbers(whole)).toBe(true);
    expect(seesNumbers(masked)).toBe(false);
    expect(shownNumber(whole, '+919845012345')).toBe('+919845012345');
    expect(shownNumber(masked, '+919845012345')).toBe('+919•••••••45');
    for (const none of [null, undefined, '']) {
      expect(shownNumber(whole, none)).toBeNull();
      expect(shownNumber(masked, none)).toBeNull();
    }
  });

  it('is granted to every role that sees contacts, and stays while the company is suspended', () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.has('contacts.view_numbers'))
      .map(([role]) => role);
    expect(holders).toEqual(['owner', 'admin', 'supervisor', 'agent', 'marketer', 'analyst']);
    expect(ALLOWED_WHEN_SUSPENDED.has('contacts.view_numbers')).toBe(true);
    // Owners and administrators cannot be masked.
    expect(MASKABLE_ROLES).toEqual(['supervisor', 'agent', 'marketer', 'analyst']);
  });

  it('is kept through any role the company does not mask', () => {
    expect(seesNumbersWhole(['agent'], [])).toBe(true);
    expect(seesNumbersWhole(['agent'], ['agent'])).toBe(false);
    expect(seesNumbersWhole(['agent', 'supervisor'], ['agent'])).toBe(true);
    expect(seesNumbersWhole(['agent', 'supervisor'], ['agent', 'supervisor'])).toBe(false);
    expect(seesNumbersWhole(['owner', 'agent'], [...MASKABLE_ROLES])).toBe(true);
    expect(seesNumbersWhole(['admin'], [...MASKABLE_ROLES])).toBe(true);
    expect(seesNumbersWhole(['marketer'], ['agent'])).toBe(true);
    expect(seesNumbersWhole(['analyst'], ['analyst'])).toBe(false);
    // A role that never had it gains nothing from not being masked.
    expect(seesNumbersWhole(['billing'], [])).toBe(false);
  });

  it('takes the roles to mask once each, in Settings’ order, and refuses others', () => {
    expect(numberMaskingSchema.parse({ maskedNumberRoles: ['analyst', 'agent', 'agent'] })).toEqual(
      { maskedNumberRoles: ['agent', 'analyst'] },
    );
    expect(numberMaskingSchema.parse({ maskedNumberRoles: [] })).toEqual({
      maskedNumberRoles: [],
    });
    for (const refused of [['owner'], ['admin'], ['billing'], ['Agent'], 'agent', [null]]) {
      expect(
        numberMaskingSchema.safeParse({ maskedNumberRoles: refused }).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
  });

  it('explains a refusal that needs numbers whole', () => {
    expect(() => assertCan(ctxOf(['contacts.read']), 'contacts.view_numbers')).toThrow(
      "Your company hides customers' phone numbers from your role",
    );
    // Without the role permission at all it is a plain refusal.
    expect(() => assertCan(ctxOf(['billing.read'], ['billing']), 'contacts.view_numbers')).toThrow(
      /permission/i,
    );
  });
});
