import type { Clock } from '@w360/core';
import type { Database } from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { crmMembers } from './common';
import { dealFieldOperations } from './deal-fields';
import { dealImportOperations } from './deal-import';
import { dealOperations } from './deals';
import { pipelineOperations } from './pipelines';
import { taskOperations } from './tasks';

export interface CrmServiceDeps {
  db: Database;
  clock: Clock;
  /** Task reminders are scheduled as jobs in the transaction that sets them. */
  jobs: JobQueue;
  signer: JobSigner;
}

/**
 * CRM for the web tier: pipelines and stages (company settings, `tenant.settings.manage`), deals,
 * notes and tasks (`crm.write` to change, `crm.read` to see), and deal fields (ADR-373, defined as
 * company settings), and deal import (ADR-374). Deal and task changes are recorded on
 * the contact's timeline; pipeline changes in the audit log.
 */
export function createCrmService(deps: CrmServiceDeps) {
  return {
    ...pipelineOperations(deps),
    ...dealOperations(deps),
    ...dealFieldOperations(deps),
    ...dealImportOperations(deps),
    ...taskOperations(deps),

    /** Members who can own deals and be assigned tasks. */
    async members(ctx: TenantContext) {
      assertCan(ctx, 'crm.read');
      return deps.db.run(ctx.scope, (tx) => crmMembers(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
    },
  };
}

export type CrmService = ReturnType<typeof createCrmService>;
