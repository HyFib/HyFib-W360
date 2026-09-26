import type { Permission } from '@w360/domain';

/**
 * Product modules and their truthful availability. A module appears in navigation only when it is
 * shipped AND the member has permission. Unavailable modules are explained in Settings → Modules;
 * nothing here is a placeholder presented as a feature. Update `status` only when the module's
 * vertical slice (UI, policy, data, jobs, tests) is complete.
 */
export type ModuleStatus = 'available' | 'planned' | 'externally_blocked';

export interface ModuleDefinition {
  key: string;
  label: string;
  path: string;
  permission: Permission;
  status: ModuleStatus;
  /** Why the module is not available yet (shown to administrators). */
  reason?: string;
}

export const MODULES: ModuleDefinition[] = [
  { key: 'overview', label: 'Overview', path: '', permission: 'tenant.read', status: 'available' },
  {
    key: 'inbox',
    label: 'Inbox',
    path: '/inbox',
    permission: 'inbox.read_assigned',
    status: 'available',
  },
  {
    key: 'contacts',
    label: 'Contacts',
    path: '/contacts',
    permission: 'contacts.read',
    status: 'planned',
    reason: 'Phase 3: contacts, consent and segments.',
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    path: '/campaigns',
    permission: 'campaigns.read',
    status: 'planned',
    reason: 'Phase 3: campaigns with consent and suppression checks at send time.',
  },
  {
    key: 'templates',
    label: 'Templates',
    path: '/templates',
    permission: 'templates.read',
    status: 'planned',
    reason: 'Phase 3: template drafts, Meta submission and approval sync.',
  },
  {
    key: 'automations',
    label: 'Automations',
    path: '/automations',
    permission: 'automations.read',
    status: 'planned',
    reason: 'Phase 4: versioned automation builder.',
  },
  {
    key: 'flows',
    label: 'Flows',
    path: '/flows',
    permission: 'flows.read',
    status: 'planned',
    reason: 'Phase 4: WhatsApp Flows lifecycle and encrypted data endpoint.',
  },
  {
    key: 'crm',
    label: 'CRM',
    path: '/crm',
    permission: 'crm.read',
    status: 'planned',
    reason: 'Phase 4: deals, pipelines and tasks.',
  },
  {
    key: 'commerce',
    label: 'Commerce',
    path: '/commerce',
    permission: 'commerce.read',
    status: 'planned',
    reason: 'Phase 4: catalog, orders and store connectors.',
  },
  {
    key: 'ai',
    label: 'AI',
    path: '/ai',
    permission: 'ai.use',
    status: 'planned',
    reason: 'Phase 6: opt-in AI assistance with per-company budgets.',
  },
  {
    key: 'reports',
    label: 'Reports',
    path: '/reports',
    permission: 'reports.read',
    status: 'planned',
    reason: 'Phase 3: messaging, inbox and campaign reports.',
  },
  {
    key: 'integrations',
    label: 'Integrations',
    path: '/integrations',
    permission: 'integrations.read',
    status: 'planned',
    reason: 'Phase 4–6: connector framework and prioritised connectors.',
  },
  {
    key: 'billing',
    label: 'Billing',
    path: '/billing',
    permission: 'billing.read',
    status: 'planned',
    reason: 'Phase 5: subscriptions, prepaid wallet and recharge.',
  },
  {
    key: 'settings',
    label: 'Settings',
    path: '/settings',
    permission: 'tenant.read',
    status: 'available',
  },
];

export function visibleModules(permissions: ReadonlySet<Permission>): ModuleDefinition[] {
  return MODULES.filter((m) => m.status === 'available' && permissions.has(m.permission));
}
