import { describe, expect, it } from 'vitest';
import { CRM_CHANGERS } from '@w360/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { crmChangedBy, crmCreatedBy } from './common';
import { taskDetailsChanged } from './tasks';

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

describe('who last changed a task, as the API reads it (ADR-278)', () => {
  it('is recorded by a member’s save only when it changes something the task events report', () => {
    const member = '0192a1b2-0000-7000-8000-00000000000c';
    const task = {
      title: 'Call Asha',
      notes: 'About the renewal',
      dueAt: new Date('2026-10-09T10:00:00.000Z'),
      remindAt: new Date('2026-10-08T10:00:00.000Z'),
      assigneeMembershipId: member,
    };
    // The same details, the times as new dates, change nothing.
    const same = {
      ...task,
      dueAt: new Date(task.dueAt.getTime()),
      remindAt: new Date(task.remindAt.getTime()),
    };
    expect(taskDetailsChanged(task, same)).toBe(false);
    expect(
      taskDetailsChanged(
        { ...task, dueAt: null, remindAt: null },
        { ...same, dueAt: null, remindAt: null },
      ),
    ).toBe(false);
    for (const change of [
      { title: 'Call Asha back' },
      { notes: null },
      { dueAt: new Date('2026-10-10T10:00:00.000Z') },
      { dueAt: null },
      { remindAt: new Date('2026-10-08T11:00:00.000Z') },
      { remindAt: null },
      { assigneeMembershipId: '0192a1b2-0000-7000-8000-00000000000d' },
    ]) {
      expect(taskDetailsChanged(task, { ...same, ...change }), JSON.stringify(change)).toBe(true);
    }
    expect(taskDetailsChanged({ ...task, dueAt: null }, same)).toBe(true);
  });
});

describe('who added a deal or a task, as the API reads it (ADR-282)', () => {
  it('is its one creator: a key by its id, an automation’s run, or a member never named', () => {
    const apiKeyId = '0192a1b2-0000-7000-8000-00000000000d';
    const automationId = '0192a1b2-0000-7000-8000-00000000000e';
    expect(crmCreatedBy(null, apiKeyId)).toEqual({ createdBy: 'api', createdByApiKeyId: apiKeyId });
    expect(crmCreatedBy(automationId, null)).toEqual({
      createdBy: 'automation',
      createdByApiKeyId: null,
    });
    expect(crmCreatedBy(null, null)).toEqual({ createdBy: 'member', createdByApiKeyId: null });
  });
});
