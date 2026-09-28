import { describe, expect, it } from 'vitest';
import {
  ALLOWED_WHEN_SUSPENDED,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  canAssignRoles,
  isPrivileged,
  permissionsForRoles,
} from './permissions';

describe('permission matrix', () => {
  it('owners hold every permission', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('admins cannot delete the company, manage owners or change payment settings', () => {
    for (const p of ['tenant.delete', 'members.manage_owners', 'billing.manage'] as const) {
      expect(ROLE_PERMISSIONS.admin.has(p)).toBe(false);
    }
  });

  it('billing members cannot read customer conversations and agents cannot touch billing', () => {
    expect(ROLE_PERMISSIONS.billing.has('inbox.read_all')).toBe(false);
    expect(ROLE_PERMISSIONS.billing.has('contacts.read')).toBe(false);
    expect(ROLE_PERMISSIONS.agent.has('billing.read')).toBe(false);
    expect(ROLE_PERMISSIONS.analyst.has('contacts.read')).toBe(false);
  });

  it('roles combine as a union', () => {
    const p = permissionsForRoles(['agent', 'billing']);
    expect(p.has('inbox.reply')).toBe(true);
    expect(p.has('billing.manage')).toBe(true);
    expect(p.has('members.invite')).toBe(false);
  });

  it('suspension blocks every outbound capability', () => {
    for (const p of [
      'inbox.reply',
      'campaigns.send',
      'automations.publish',
      'templates.submit',
      'members.invite',
      'channels.manage',
    ] as const) {
      expect(ALLOWED_WHEN_SUSPENDED.has(p)).toBe(false);
    }
    expect(ALLOWED_WHEN_SUSPENDED.has('billing.manage')).toBe(true);
    expect(ALLOWED_WHEN_SUSPENDED.has('tenant.export')).toBe(true);
    // Leaving must not depend on paying: deletion can be asked for (and cancelled) while suspended.
    expect(ALLOWED_WHEN_SUSPENDED.has('tenant.delete')).toBe(true);
  });

  it('only owners can assign the owner role', () => {
    expect(canAssignRoles(['admin'], ['owner'])).toBe(false);
    expect(canAssignRoles(['admin'], ['agent', 'billing'])).toBe(true);
    expect(canAssignRoles(['owner'], ['owner'])).toBe(true);
    expect(canAssignRoles(['supervisor'], ['agent'])).toBe(false);
  });

  it('owner, admin and billing are privileged (MFA required)', () => {
    expect(isPrivileged(['agent'])).toBe(false);
    expect(isPrivileged(['agent', 'billing'])).toBe(true);
    expect(isPrivileged(['admin'])).toBe(true);
  });
});
