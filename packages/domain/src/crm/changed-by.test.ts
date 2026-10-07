import { describe, expect, it } from 'vitest';
import { CRM_CHANGERS } from '@w360/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { crmChangedBy } from './common';

describe('who changed a deal or a task (ADR-277)', () => {
  it('records a member, an automation or a key it names, marked as this transaction’s', () => {
    expect(CRM_CHANGERS).toEqual(['member', 'automation', 'api']);
    const recorded = (by: Parameters<typeof crmChangedBy>[0]) => {
      const { changedXact, ...rest } = crmChangedBy(by);
      return { ...rest, xact: new PgDialect().sqlToQuery(changedXact).sql };
    };
    const xact = 'pg_catalog.pg_current_xact_id()';
    expect(recorded('member')).toEqual({ changedBy: 'member', changedByApiKeyId: null, xact });
    expect(recorded('automation')).toEqual({
      changedBy: 'automation',
      changedByApiKeyId: null,
      xact,
    });
    const apiKeyId = '0192a1b2-0000-7000-8000-00000000000b';
    expect(recorded({ apiKeyId })).toEqual({ changedBy: 'api', changedByApiKeyId: apiKeyId, xact });
  });
});
