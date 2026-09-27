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
    status: 'available',
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    path: '/campaigns',
    permission: 'campaigns.read',
    status: 'available',
    reason:
      'Template campaigns to saved segments with approval, scheduling, pacing and caps. Per-recipient time zones and A/B tests are not supported yet.',
  },
  {
    key: 'growth',
    label: 'Growth',
    path: '/growth',
    permission: 'campaigns.read',
    status: 'available',
    reason:
      'Click-to-chat links with QR codes and counted clicks, a website button, and conversations attributed to links and click-to-WhatsApp ads. Ad accounts, ad spend and conversion reporting to Meta are not connected.',
  },
  {
    key: 'templates',
    label: 'Templates',
    path: '/templates',
    permission: 'templates.read',
    status: 'available',
    reason:
      'Text, marketing and utility templates. Media headers, authentication templates and buttons with variables are not supported yet.',
  },
  {
    key: 'automations',
    label: 'Automations',
    path: '/automations',
    permission: 'automations.read',
    status: 'available',
    reason:
      'Keyword, new-conversation and any-message automations with messages, reply buttons, questions, conditions, contact updates, waits, hand-off and web requests to allowed domains; immutable versions, test runs and a simulator. WhatsApp Flows and drag-and-drop editing are not available yet.',
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
    status: 'available',
    reason:
      'Pipelines with ordered stages, deals linked to contacts and conversations, won and lost outcomes, tasks with emailed reminders, notes and a contact timeline. Custom deal fields, deal import and forecasting are not available yet.',
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
    status: 'available',
    reason:
      'Messaging outcomes, estimated Meta charges, inbox response times, CSAT, automation outcomes, member activity, campaign funnels and deal outcomes. Retention reports and campaign click or conversion tracking are not available yet.',
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
    status: 'available',
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
