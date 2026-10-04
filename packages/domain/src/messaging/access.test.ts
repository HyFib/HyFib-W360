import { describe, expect, it } from 'vitest';
import {
  accessExpiresSoon,
  accessExpiryNotice,
  accessLostNotice,
  accessProblemReason,
  accountLabel,
  assessGrant,
  lostAccessNumberError,
  missingPermissions,
  REQUIRED_META_PERMISSIONS,
  type TokenGrant,
} from './access';

const APP = '1000000000001';
const WABA = '800000000000001';
const healthy: TokenGrant = {
  appId: APP,
  isValid: true,
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'],
  granularScopes: [],
  expiresAt: null,
};

describe('which tokens admit an account (the rules of onboarding and of the daily checks)', () => {
  it('admits a valid token of HyFib’s app with both WhatsApp permissions', () => {
    expect(assessGrant(healthy, APP, WABA)).toBeNull();
    // Target ids that include the account, or none at all, admit it too.
    expect(
      assessGrant(
        {
          ...healthy,
          granularScopes: [
            { scope: 'whatsapp_business_management', targetIds: ['1', WABA] },
            { scope: 'whatsapp_business_messaging', targetIds: ['1'] },
          ],
        },
        APP,
        WABA,
      ),
    ).toBeNull();
    expect(
      assessGrant(
        { ...healthy, granularScopes: [{ scope: 'whatsapp_business_management', targetIds: [] }] },
        APP,
        WABA,
      ),
    ).toBeNull();
  });

  it('names why a token does not, in onboarding’s order', () => {
    expect(assessGrant({ ...healthy, isValid: false, appId: 'other' }, APP, WABA)).toEqual({
      problem: 'invalid',
      missing: [],
    });
    expect(assessGrant({ ...healthy, appId: '999', scopes: [] }, APP, WABA)).toEqual({
      problem: 'other_app',
      missing: [],
    });
    expect(
      assessGrant({ ...healthy, scopes: ['whatsapp_business_management'] }, APP, WABA),
    ).toEqual({ problem: 'missing_permission', missing: ['whatsapp_business_messaging'] });
    expect(
      assessGrant(
        {
          ...healthy,
          scopes: [],
          granularScopes: [{ scope: 'whatsapp_business_management', targetIds: ['1'] }],
        },
        APP,
        WABA,
      ),
    ).toEqual({
      problem: 'missing_permission',
      missing: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    });
    expect(
      assessGrant(
        {
          ...healthy,
          granularScopes: [{ scope: 'whatsapp_business_management', targetIds: ['1', '2'] }],
        },
        APP,
        WABA,
      ),
    ).toEqual({ problem: 'account_not_shared', missing: [] });
  });

  it('lists the permissions missing from those granted', () => {
    expect(missingPermissions([...REQUIRED_META_PERMISSIONS])).toEqual([]);
    expect(missingPermissions(['whatsapp_business_messaging'])).toEqual([
      'whatsapp_business_management',
    ]);
    expect(missingPermissions([])).toEqual([...REQUIRED_META_PERMISSIONS]);
  });
});

describe('what the company is told', () => {
  it('says why Meta no longer accepts the access', () => {
    expect(accessProblemReason('invalid', [])).toBe(
      'Meta reports that the access token is no longer valid',
    );
    expect(accessProblemReason('other_app', [])).toBe(
      'Meta reports that the access token belongs to another app',
    );
    expect(accessProblemReason('missing_permission', ['whatsapp_business_messaging'])).toBe(
      'the permission to send messages (whatsapp_business_messaging) was removed',
    );
    expect(
      accessProblemReason('missing_permission', [
        'whatsapp_business_management',
        'whatsapp_business_messaging',
      ]),
    ).toBe(
      'the permissions to manage the account, its numbers and templates and to send messages (whatsapp_business_management, whatsapp_business_messaging) were removed',
    );
    expect(accessProblemReason('missing_permission', [])).toBe('a WhatsApp permission was removed');
    expect(accessProblemReason('account_not_shared', [])).toBe(
      'Meta no longer lists the account among those shared with HyFib’s app',
    );
    // An account marked before the checks (a setup step Meta refused) has no recorded reason.
    expect(accessProblemReason(null, [])).toBe('Meta refused HyFib’s access token');
  });

  it('names the account by its name or its id', () => {
    expect(accountLabel({ name: '  Main account ', wabaId: WABA })).toBe('Main account');
    expect(accountLabel({ name: null, wabaId: WABA })).toBe(`WhatsApp Business Account ${WABA}`);
    expect(accountLabel({ name: ' ', wabaId: WABA })).toBe(`WhatsApp Business Account ${WABA}`);
  });

  it('emails the reason, the numbers that stopped and how to reconnect', () => {
    const notice = accessLostNotice({
      account: 'Main\naccount',
      reason: accessProblemReason('invalid', []),
      numbers: ['+91 90000 12345', '+91 90000 12346', 'number 800000000000003'],
    });
    expect(notice.subject).toBe(
      'Reconnect WhatsApp: Meta no longer accepts HyFib’s access to Main account',
    );
    expect(notice.lines[0]).toBe(
      'Meta no longer accepts HyFib’s access to Main account: Meta reports that the access token is no longer valid.',
    );
    expect(notice.lines[1]).toBe(
      'Until it is reconnected, +91 90000 12345, +91 90000 12346 and number 800000000000003 cannot send messages, templates or campaigns from HyFib.',
    );
    expect(notice.lines[2]).toContain('Settings → Channels');
    expect(notice.lines[2]).toContain('checks the account’s other numbers');
    expect(
      accessLostNotice({ account: 'A', reason: 'r', numbers: ['+91 90000 12345'] }).lines[1],
    ).toBe(
      'Until it is reconnected, +91 90000 12345 cannot send messages, templates or campaigns from HyFib.',
    );
    expect(accessLostNotice({ account: 'A', reason: 'r', numbers: [] }).lines[1]).toBe(
      'Until it is reconnected, none of its numbers can send messages from HyFib.',
    );
  });

  it('reminds of an expiry in the company’s time zone', () => {
    const notice = accessExpiryNotice({
      account: 'Main account',
      numbers: ['+91 90000 12345'],
      expiresAt: new Date('2026-10-09T20:00:00Z'),
      timeZone: 'Asia/Kolkata',
    });
    // 20:00 UTC is 01:30 the next day in India.
    expect(notice.subject).toBe('HyFib’s access to Main account expires on 10 Oct 2026');
    expect(notice.lines[0]).toContain('expires on 10 October 2026 at 01:30');
    expect(notice.lines[1]).toBe(
      'From then on +91 90000 12345 cannot send messages from HyFib until the account is reconnected.',
    );
    expect(notice.lines[2]).toContain('Reconnecting gives HyFib a new access token.');
  });

  it('reminds only of an expiry within 7 days that has not passed', () => {
    const now = new Date('2026-10-04T00:00:00Z');
    const day = 86_400_000;
    expect(accessExpiresSoon(null, now)).toBe(false);
    expect(accessExpiresSoon(new Date(now.getTime() - 1), now)).toBe(false);
    expect(accessExpiresSoon(now, now)).toBe(false);
    expect(accessExpiresSoon(new Date(now.getTime() + 1), now)).toBe(true);
    expect(accessExpiresSoon(new Date(now.getTime() + 7 * day), now)).toBe(true);
    expect(accessExpiresSoon(new Date(now.getTime() + 7 * day + 1), now)).toBe(false);
  });

  it('keeps the message on each number within its column', () => {
    const message = lostAccessNumberError(accessProblemReason('invalid', []));
    expect(message).toBe(
      'Meta no longer accepts HyFib’s access to this number’s WhatsApp Business Account: Meta reports that the access token is no longer valid. Reconnect WhatsApp.',
    );
    expect(lostAccessNumberError('x'.repeat(2000))).toHaveLength(1000);
  });
});
