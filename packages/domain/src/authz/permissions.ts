import type { TenantRole } from '@w360/db';

/**
 * Permission catalogue and role matrix (documented in docs/SECURITY.md#permission-matrix).
 * Permissions for modules that are not yet shipped are declared now so the matrix is stable and
 * reviewable; declaring a permission does not make its module available.
 */
export const PERMISSIONS = [
  'tenant.read',
  'tenant.settings.manage',
  'tenant.security.manage',
  'tenant.export',
  'tenant.delete',
  'members.read',
  'members.invite',
  'members.manage',
  'members.manage_owners',
  'audit.read',
  'channels.read',
  'channels.manage',
  'inbox.read_all',
  'inbox.read_assigned',
  'inbox.reply',
  'inbox.assign',
  'inbox.supervise',
  /** Download a conversation's transcript (ADR-212). */
  'inbox.export',
  'contacts.read',
  'contacts.write',
  'contacts.import',
  'contacts.export',
  'contacts.delete',
  /**
   * See customers' phone numbers whole (ADR-226); without it a member sees them masked. A company
   * can take it from the roles it chooses.
   */
  'contacts.view_numbers',
  'templates.read',
  'templates.write',
  'templates.submit',
  'campaigns.read',
  'campaigns.write',
  'campaigns.approve',
  'campaigns.send',
  'automations.read',
  'automations.write',
  'automations.publish',
  'flows.read',
  'flows.write',
  'flows.publish',
  'crm.read',
  'crm.write',
  'commerce.read',
  'commerce.manage',
  'ai.use',
  'ai.manage',
  'reports.read',
  'reports.export',
  'integrations.read',
  'integrations.manage',
  'developer.manage',
  'billing.read',
  'billing.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

const without = (...excluded: Permission[]): Set<Permission> => {
  const set = new Set(ALL);
  for (const p of excluded) set.delete(p);
  return set;
};

export const ROLE_PERMISSIONS: Record<TenantRole, ReadonlySet<Permission>> = {
  owner: ALL,
  admin: without('tenant.delete', 'tenant.export', 'members.manage_owners', 'billing.manage'),
  supervisor: new Set<Permission>([
    'tenant.read',
    'members.read',
    'channels.read',
    'inbox.read_all',
    'inbox.read_assigned',
    'inbox.reply',
    'inbox.assign',
    'inbox.supervise',
    'inbox.export',
    'contacts.read',
    'contacts.write',
    'contacts.import',
    'contacts.view_numbers',
    'templates.read',
    'campaigns.read',
    'automations.read',
    'flows.read',
    'crm.read',
    'crm.write',
    'commerce.read',
    'ai.use',
    'reports.read',
    'reports.export',
    'integrations.read',
  ]),
  agent: new Set<Permission>([
    'tenant.read',
    'members.read',
    'channels.read',
    'inbox.read_assigned',
    'inbox.reply',
    'contacts.read',
    'contacts.write',
    'contacts.view_numbers',
    'templates.read',
    'crm.read',
    'crm.write',
    'commerce.read',
    'ai.use',
  ]),
  marketer: new Set<Permission>([
    'tenant.read',
    'members.read',
    'channels.read',
    'contacts.read',
    'contacts.write',
    'contacts.import',
    'contacts.export',
    'contacts.view_numbers',
    'templates.read',
    'templates.write',
    'templates.submit',
    'campaigns.read',
    'campaigns.write',
    'campaigns.send',
    'automations.read',
    'automations.write',
    'flows.read',
    'flows.write',
    'commerce.read',
    'ai.use',
    'reports.read',
    'integrations.read',
  ]),
  analyst: new Set<Permission>([
    'tenant.read',
    'members.read',
    'channels.read',
    'contacts.view_numbers',
    'templates.read',
    'campaigns.read',
    'automations.read',
    'flows.read',
    'reports.read',
    'reports.export',
  ]),
  billing: new Set<Permission>(['tenant.read', 'members.read', 'billing.read', 'billing.manage']),
};

/** Roles whose members must use multi-factor authentication (after the grace period). */
export const PRIVILEGED_ROLES: ReadonlySet<TenantRole> = new Set<TenantRole>([
  'owner',
  'admin',
  'billing',
]);

/**
 * Permissions that remain available while a company is suspended, restricted or pending deletion:
 * read access, exports, billing recovery and owner administration, including asking for the
 * company to be deleted and cancelling that (leaving must not depend on paying). Everything that
 * causes outbound activity is blocked.
 */
export const ALLOWED_WHEN_SUSPENDED: ReadonlySet<Permission> = new Set<Permission>([
  'tenant.read',
  'tenant.export',
  'tenant.delete',
  'members.read',
  'members.manage',
  'members.manage_owners',
  'audit.read',
  'channels.read',
  'inbox.read_all',
  'inbox.read_assigned',
  'inbox.export',
  'contacts.read',
  'contacts.export',
  'contacts.delete',
  'contacts.view_numbers',
  'templates.read',
  'campaigns.read',
  'automations.read',
  'flows.read',
  'crm.read',
  'commerce.read',
  'reports.read',
  'reports.export',
  'integrations.read',
  'billing.read',
  'billing.manage',
]);

/** Permissions available before a privileged member completes required MFA set-up. */
export const ALLOWED_WITHOUT_MFA: ReadonlySet<Permission> = new Set<Permission>([
  'tenant.read',
  'members.read',
]);

export function permissionsForRoles(roles: readonly TenantRole[]): Set<Permission> {
  const result = new Set<Permission>();
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role]) result.add(p);
  }
  return result;
}

export function isPrivileged(roles: readonly TenantRole[]): boolean {
  return roles.some((r) => PRIVILEGED_ROLES.has(r));
}

/** Only owners may grant or revoke the owner role; admins may manage every other role. */
export function canAssignRoles(
  actorRoles: readonly TenantRole[],
  targetRoles: readonly TenantRole[],
): boolean {
  if (actorRoles.includes('owner')) return true;
  if (!actorRoles.includes('admin')) return false;
  return !targetRoles.includes('owner');
}

export const ROLE_LABELS: Record<TenantRole, { label: string; description: string }> = {
  owner: {
    label: 'Owner',
    description: 'Full control, including billing, ownership and company deletion.',
  },
  admin: {
    label: 'Administrator',
    description: 'Manages members, channels, settings and integrations.',
  },
  supervisor: {
    label: 'Supervisor',
    description: 'Oversees the shared inbox, assignments and team performance.',
  },
  agent: { label: 'Agent', description: 'Handles assigned conversations and customer records.' },
  marketer: {
    label: 'Marketer',
    description: 'Builds audiences, templates, campaigns and automations.',
  },
  analyst: { label: 'Analyst', description: 'Reads reports and aggregated analytics.' },
  billing: {
    label: 'Billing',
    description: 'Manages plans, wallet, payment methods and invoices.',
  },
};
