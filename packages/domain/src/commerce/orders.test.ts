import { describe, expect, it } from 'vitest';
import { ORDER_STATUS_CHANGERS } from '@w360/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { orderStatusChangedBy } from './orders';

describe('who changed an order (ADR-270)', () => {
  it('records a member, a key it names or the Payment Link, marked as this transaction’s', () => {
    expect(ORDER_STATUS_CHANGERS).toEqual(['member', 'api', 'payment_link']);
    const recorded = (by: Parameters<typeof orderStatusChangedBy>[0]) => {
      const { statusChangedXact, ...rest } = orderStatusChangedBy(by);
      return { ...rest, xact: new PgDialect().sqlToQuery(statusChangedXact).sql };
    };
    const xact = 'pg_catalog.pg_current_xact_id()';
    expect(recorded('member')).toEqual({
      statusChangedBy: 'member',
      statusChangedByApiKeyId: null,
      xact,
    });
    expect(recorded('payment_link')).toEqual({
      statusChangedBy: 'payment_link',
      statusChangedByApiKeyId: null,
      xact,
    });
    const apiKeyId = '0192a1b2-0000-7000-8000-00000000000a';
    expect(recorded({ apiKeyId })).toEqual({
      statusChangedBy: 'api',
      statusChangedByApiKeyId: apiKeyId,
      xact,
    });
  });
});
