import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, systemClock, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope } from '@w360/db';
import {
  CRM_LIMITS,
  DEAL_CSV_COLUMNS,
  DEAL_EXPORT_BATCH,
  createContactsService,
  createCrmService,
  createReportsService,
  findDueReminders,
  maskPhoneNumber,
  forecastMonths,
  monthEndIn,
  sendTaskReminder,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * CRM against real PostgreSQL: pipelines and stages (settings), deals with exact minor-unit values
 * per pipeline currency, stage moves, won/lost/reopen, the append-only timeline, notes, tasks and
 * reminders emailed exactly once, contact erasure, the deals report and company isolation.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });
const crm = (clock: Clock = systemClock) =>
  createCrmService({ db: fx.dbs.app, clock, jobs: fx.jobs(), signer: fx.signer });
const reminderDeps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  clock,
  outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
  appBaseUrl: 'https://app.example.test',
});

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

/**
 * Opens a transaction on its own connection and takes a row lock with `lockSql`, standing in for
 * another writer (an erasure, a settings change) caught in the middle of its transaction.
 */
async function holdLock(lockSql: string, params: unknown[]) {
  const client: pg.PoolClient = await fx.dbs.adminPool.connect();
  await client.query('begin');
  const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
  await client.query(lockSql, params);
  return {
    client,
    /** Resolves once another backend is waiting for this transaction's locks. */
    async blocking() {
      await vi.waitFor(
        async () => {
          const [row] = await fx.query<{ n: number }>(
            'select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
            [pid],
          );
          if (!row || row.n < 1) throw new Error('nobody is waiting yet');
        },
        { timeout: 10_000, interval: 20 },
      );
    },
    async commit() {
      await client.query('commit');
      client.release();
    },
  };
}

async function newContact(owner: TenantContext, name: string) {
  const phone = `+91${randomInt(7_000_000_000, 9_999_999_999)}`;
  const { id } = await createContactsService({ db: fx.dbs.app, clock: systemClock }).createContact(
    owner,
    { displayName: name, phone },
  );
  return id;
}

async function setup(company?: Company) {
  const c = company ?? (await fx.company());
  const owner = await fx.ctx(c, c.owner);
  const agent = await fx.ctx(c, c.agent);
  const marketer = await fx.ctx(c, c.marketer);
  const { id: pipelineId } = await crm().createPipeline(owner, {
    name: 'Sales',
    currency: 'INR',
    stages: ['New', 'Qualified', 'Proposal'],
  });
  const [pipeline] = (await crm().listPipelines(owner)).filter((p) => p.id === pipelineId);
  const [newStage, qualified, proposal] = pipeline!.stages;
  return {
    c,
    owner,
    agent,
    marketer,
    pipeline: pipeline!,
    newStage: newStage!,
    qualified: qualified!,
    proposal: proposal!,
  };
}

describe('crm pipelines', () => {
  it('are company settings with ordered stages, one currency, and archived instead of deleted', async () => {
    const { owner, agent, pipeline, newStage, qualified, proposal } = await setup();
    const svc = crm();
    expect(pipeline).toMatchObject({ name: 'Sales', currency: 'INR', archived: false, version: 1 });
    expect(pipeline.stages.map((s) => s.name)).toEqual(['New', 'Qualified', 'Proposal']);

    await expectAppError(
      svc.createPipeline(agent, { name: 'Mine', currency: 'INR', stages: ['A'] }),
      'forbidden',
    );
    await expectAppError(
      svc.createPipeline(owner, { name: 'sales ', currency: 'INR', stages: ['A'] }),
      'conflict',
      /already has this name/,
    );
    await expectAppError(
      svc.createPipeline(owner, { name: 'Other', currency: 'XYZ', stages: ['A'] }),
      'validation_failed',
    );
    await expectAppError(
      svc.createPipeline(owner, { name: 'Other', currency: 'INR', stages: ['A', 'a'] }),
      'validation_failed',
      /Two stages/,
    );

    // A stage with an open deal cannot be removed until the deal moves.
    const contactId = await newContact(owner, 'Asha');
    const { id: dealId } = await svc.createDeal(owner, {
      contactId,
      pipelineId: pipeline.id,
      stageId: proposal.id,
      title: 'Annual plan',
    });
    await expectAppError(
      svc.updatePipeline(owner, {
        id: pipeline.id,
        expectedVersion: 1,
        name: 'Sales',
        stages: [
          { id: newStage.id, name: 'New' },
          { id: qualified.id, name: 'Qualified' },
        ],
      }),
      'conflict',
      /Move the 1 open deal out of “Proposal”/,
    );
    await svc.moveDeal(owner, { id: dealId, expectedVersion: 1, stageId: qualified.id });
    const { version } = await svc.updatePipeline(owner, {
      id: pipeline.id,
      expectedVersion: 1,
      name: 'Sales team',
      stages: [
        { id: qualified.id, name: 'Qualified lead' },
        { id: null, name: 'Won soon' },
        { id: newStage.id, name: 'New' },
      ],
    });
    expect(version).toBe(2);
    const [after] = (await svc.listPipelines(owner)).filter((p) => p.id === pipeline.id);
    expect(after!.name).toBe('Sales team');
    expect(after!.stages.filter((s) => !s.archived).map((s) => s.name)).toEqual([
      'Qualified lead',
      'Won soon',
      'New',
    ]);
    expect(after!.stages.find((s) => s.id === proposal.id)).toMatchObject({ archived: true });
    // Each stage counts its own open deals (the pipeline settings page shows them).
    expect(after!.stages.find((s) => s.id === qualified.id)).toMatchObject({ openDeals: 1 });
    expect(after!.stages.find((s) => s.id === newStage.id)).toMatchObject({ openDeals: 0 });
    // A stale editor is refused.
    await expectAppError(
      svc.updatePipeline(owner, {
        id: pipeline.id,
        expectedVersion: 1,
        name: 'X',
        stages: [{ id: null, name: 'A' }],
      }),
      'conflict',
      /changed this in the meantime/,
    );
    // Archiving waits for open deals to be closed.
    await expectAppError(
      svc.archivePipeline(owner, { id: pipeline.id, expectedVersion: 2 }),
      'conflict',
      /open deal/,
    );
    await svc.closeDeal(owner, { id: dealId, expectedVersion: 2, outcome: 'won' });
    const archived = await svc.archivePipeline(owner, { id: pipeline.id, expectedVersion: 2 });
    expect((await svc.listPipelines(owner)).map((p) => p.id)).not.toContain(pipeline.id);
    await svc.restorePipeline(owner, { id: pipeline.id, expectedVersion: archived.version });
    expect((await svc.listPipelines(owner)).map((p) => p.id)).toContain(pipeline.id);
    const audit = await fx.query<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1 AND action LIKE 'crm.%' ORDER BY occurred_at`,
      [owner.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'crm.pipeline_created',
      'crm.pipeline_updated',
      'crm.pipeline_archived',
      'crm.pipeline_restored',
    ]);
  });

  it('limits the pipelines a company uses at once', async () => {
    const { owner } = await setup();
    for (let i = 1; i < CRM_LIMITS.pipelines; i += 1) {
      await crm().createPipeline(owner, { name: `P${i}`, currency: 'INR', stages: ['A'] });
    }
    await expectAppError(
      crm().createPipeline(owner, { name: 'One too many', currency: 'INR', stages: ['A'] }),
      'conflict',
      /at most 20 pipelines/,
    );
  });
});

describe('crm deals', () => {
  it('moves deals through stages, closes and reopens them, and records every change', async () => {
    const { owner, agent, marketer, pipeline, newStage, qualified } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Bala');

    // Roles: agents work with deals; marketers have no CRM access.
    await expectAppError(svc.board(marketer), 'forbidden');
    await expectAppError(
      svc.createDeal(owner, {
        contactId,
        pipelineId: pipeline.id,
        stageId: newStage.id,
        title: 'Bulk order',
        value: '12.345',
      }),
      'validation_failed',
      /at most 2 decimals/,
    );
    await expectAppError(
      svc.createDeal(owner, {
        contactId,
        pipelineId: pipeline.id,
        stageId: newStage.id,
        title: 'Bulk order',
        ownerMembershipId: marketer.membership.id,
      }),
      'validation_failed',
      /active member who can use the CRM/,
    );
    const { id } = await svc.createDeal(agent, {
      contactId,
      pipelineId: pipeline.id,
      stageId: newStage.id,
      title: 'Bulk order',
      value: '1,20,000.50',
      ownerMembershipId: agent.membership.id,
      expectedCloseOn: '2026-12-31',
    });

    const board = await svc.board(owner, { pipelineId: pipeline.id });
    const column = board!.columns.find((c) => c.stage.id === newStage.id)!;
    expect(column).toMatchObject({ count: 1, valueMinor: 12000050 });
    expect(column.deals[0]).toMatchObject({
      title: 'Bulk order',
      valueMinor: 12000050,
      currency: 'INR',
      owner: { membershipId: agent.membership.id, name: 'Agent' },
      contact: { id: contactId, name: 'Bala', erased: false },
    });
    expect(
      (await svc.board(owner, { pipelineId: pipeline.id, owner: 'none' }))!.columns[0]!.count,
    ).toBe(0);
    expect(
      (await svc.board(agent, { pipelineId: pipeline.id, owner: 'mine' }))!.columns[0]!.count,
    ).toBe(1);

    await svc.moveDeal(agent, { id, expectedVersion: 1, stageId: qualified.id });
    await expectAppError(
      svc.moveDeal(agent, { id, expectedVersion: 1, stageId: newStage.id }),
      'conflict',
      /changed this in the meantime/,
    );
    await svc.updateDeal(owner, {
      id,
      expectedVersion: 2,
      title: 'Bulk order (revised)',
      value: '150000',
      ownerMembershipId: owner.membership.id,
      expectedCloseOn: null,
    });
    // A pipeline in another currency takes the deal only without a value.
    const { id: usdId } = await svc.createPipeline(owner, {
      name: 'Export',
      currency: 'USD',
      stages: ['Lead'],
    });
    const usd = (await svc.listPipelines(owner)).find((p) => p.id === usdId)!;
    await expectAppError(
      svc.moveDeal(owner, {
        id,
        expectedVersion: 3,
        stageId: usd.stages[0]!.id,
        pipelineId: usd.id,
      }),
      'conflict',
      /uses USD/,
    );
    await svc.closeDeal(owner, {
      id,
      expectedVersion: 3,
      outcome: 'lost',
      lostReason: 'Chose a competitor',
    });
    await expectAppError(
      svc.moveDeal(owner, { id, expectedVersion: 4, stageId: newStage.id }),
      'conflict',
      /Reopen/,
    );
    await svc.reopenDeal(owner, { id, expectedVersion: 4 });
    await svc.closeDeal(owner, { id, expectedVersion: 5, outcome: 'won' });

    const deal = await svc.getDeal(owner, id);
    expect(deal).toMatchObject({
      status: 'won',
      stageName: 'Qualified',
      valueMinor: 15000000,
      lostReason: null,
      closedBy: { name: 'Owner' },
      createdBy: { name: 'Agent' },
      version: 6,
    });
    expect(deal.timeline.map((a) => a.kind).reverse()).toEqual([
      'deal_created',
      'stage_changed',
      'deal_updated',
      'owner_changed',
      'deal_lost',
      'deal_reopened',
      'deal_won',
    ]);
    expect(deal.timeline.find((a) => a.kind === 'deal_updated')!.data).toEqual({
      fields: ['title', 'value', 'expected_close_on'],
      valueFrom: 12000050,
      valueTo: 15000000,
    });
    // The timeline cannot be rewritten, even by the table owner.
    await expect(
      fx.dbs.adminPool.query(`UPDATE app.crm_activities SET kind = 'note' WHERE deal_id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      fx.dbs.adminPool.query(`DELETE FROM app.crm_activities WHERE deal_id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
  });

  it('moves an open deal to a stage of another pipeline of its currency (ADR-234)', async () => {
    const { c, owner, agent, pipeline, newStage } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Chitra');
    const { id } = await svc.createDeal(agent, {
      contactId,
      pipelineId: pipeline.id,
      stageId: newStage.id,
      title: 'Renewal',
      value: '5,000',
    });
    const { id: renewalsId } = await svc.createPipeline(owner, {
      name: 'Renewals',
      currency: 'INR',
      stages: ['Due', 'Renewed'],
    });
    const renewals = (await svc.listPipelines(owner)).find((p) => p.id === renewalsId)!;
    const renewed = renewals.stages[1]!;

    // A stage must belong to the pipeline named.
    await expectAppError(
      svc.moveDeal(agent, {
        id,
        expectedVersion: 1,
        pipelineId: renewals.id,
        stageId: newStage.id,
      }),
      'validation_failed',
      /Choose a stage of the pipeline/,
    );
    // Another company's pipeline reads as one that does not exist.
    const other = await setup();
    await expectAppError(
      svc.moveDeal(agent, {
        id,
        expectedVersion: 1,
        pipelineId: other.pipeline.id,
        stageId: other.newStage.id,
      }),
      'validation_failed',
      /Choose a stage of the pipeline/,
    );

    expect(
      await svc.moveDeal(agent, {
        id,
        expectedVersion: 1,
        pipelineId: renewals.id,
        stageId: renewed.id,
      }),
    ).toEqual({ version: 2 });
    const deal = await svc.getDeal(owner, id);
    expect(deal).toMatchObject({
      pipelineId: renewals.id,
      pipelineName: 'Renewals',
      stageId: renewed.id,
      stageName: 'Renewed',
      valueMinor: 500000,
      currency: 'INR',
      version: 2,
    });
    expect(deal.timeline[0]).toMatchObject({
      kind: 'stage_changed',
      data: {
        fromStageId: newStage.id,
        toStageId: renewed.id,
        fromPipelineId: pipeline.id,
        toPipelineId: renewals.id,
      },
    });
    // The board of each pipeline shows it where it is now.
    expect(
      (await svc.board(owner, { pipelineId: pipeline.id }))!.columns.every(
        (col) => col.count === 0,
      ),
    ).toBe(true);
    expect(
      (await svc.board(owner, { pipelineId: renewals.id }))!.columns.find(
        (col) => col.stage.id === renewed.id,
      )?.count,
    ).toBe(1);

    // An archived pipeline takes no deal.
    const { id: archivedId } = await svc.createPipeline(owner, {
      name: 'Old',
      currency: 'INR',
      stages: ['Lead'],
    });
    const archived = (await svc.listPipelines(owner)).find((p) => p.id === archivedId)!;
    await svc.archivePipeline(owner, { id: archived.id, expectedVersion: archived.version });
    await expectAppError(
      svc.moveDeal(agent, {
        id,
        expectedVersion: 2,
        pipelineId: archived.id,
        stageId: archived.stages[0]!.id,
      }),
      'conflict',
      /archived/,
    );
    expect(c.tenant.id).not.toBe(other.c.tenant.id);
  });

  it('weighs open deals by their stage’s chance of winning, for the pipeline and the month (ADR-242)', async () => {
    const { owner, agent, pipeline, newStage, qualified, proposal } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Hema');
    const { version } = await svc.updatePipeline(owner, {
      id: pipeline.id,
      expectedVersion: pipeline.version,
      name: 'Sales',
      stages: [
        { id: newStage.id, name: 'New', winPercent: 10 },
        { id: qualified.id, name: 'Qualified', winPercent: 50 },
        { id: proposal.id, name: 'Proposal' },
      ],
    });
    // Expected to close on the month's last day (company time), the day after, and some day.
    const monthEnd = monthEndIn(new Date(), owner.tenant.timezone);
    const after = new Date(`${monthEnd}T00:00:00Z`);
    after.setUTCDate(after.getUTCDate() + 1);
    const deal = (stageId: string, title: string, value: string, expectedCloseOn: string | null) =>
      svc.createDeal(owner, {
        contactId,
        pipelineId: pipeline.id,
        stageId,
        title,
        value,
        expectedCloseOn,
      });
    await deal(newStage.id, 'Annual plan', '1,000', monthEnd);
    await deal(qualified.id, 'Second store', '500', after.toISOString().slice(0, 10));
    await deal(qualified.id, 'Add-on', '300', null);
    await deal(proposal.id, 'Franchise', '2,000', monthEnd);

    const board = (await svc.board(owner, { pipelineId: pipeline.id }))!;
    expect(board.columns.map((c) => [c.stage.winPercent, c.valueMinor, c.weightedMinor])).toEqual([
      [10, 100_000, 10_000],
      [50, 80_000, 40_000],
      [null, 200_000, null],
    ]);
    // The month counts only the deals of stages with a chance expected to close by its end.
    expect(board.forecast).toEqual({
      hasChances: true,
      weightedMinor: 50_000,
      weightedMonthMinor: 10_000,
      stagesWithoutChance: 1,
      monthEnd,
    });
    // The owner filter applies: none of these deals has an owner.
    expect(
      (await svc.board(agent, { pipelineId: pipeline.id, owner: 'mine' }))!.forecast,
    ).toMatchObject({ weightedMinor: 0, weightedMonthMinor: 0, stagesWithoutChance: 0 });

    // An update that leaves chances out keeps them; one beyond 100% or by an agent changes nothing.
    const names = [
      { id: newStage.id, name: 'New' },
      { id: qualified.id, name: 'Qualified' },
      { id: proposal.id, name: 'Proposal' },
    ];
    await svc.updatePipeline(owner, {
      id: pipeline.id,
      expectedVersion: version,
      name: 'Sales',
      stages: names,
    });
    const kept = (await svc.listPipelines(owner)).find((p) => p.id === pipeline.id)!;
    expect(kept.stages.map((s) => s.winPercent)).toEqual([10, 50, null]);
    await expectAppError(
      svc.updatePipeline(owner, {
        id: pipeline.id,
        expectedVersion: kept.version,
        name: 'Sales',
        stages: [{ ...names[0]!, winPercent: 101 }, names[1]!, names[2]!],
      }),
      'validation_failed',
      /between 0 and 100/,
    );
    await expectAppError(
      svc.updatePipeline(agent, {
        id: pipeline.id,
        expectedVersion: kept.version,
        name: 'Sales',
        stages: [{ ...names[0]!, winPercent: 90 }, names[1]!, names[2]!],
      }),
      'forbidden',
    );
    expect(
      (await svc.listPipelines(owner)).find((p) => p.id === pipeline.id)!.stages[0]!.winPercent,
    ).toBe(10);

    // A new pipeline takes chances with its stages.
    const { id: renewals } = await svc.createPipeline(owner, {
      name: 'Renewals',
      currency: 'INR',
      stages: [{ name: 'Due', winPercent: 80 }, 'Unsure'],
    });
    expect(
      (await svc.listPipelines(owner))
        .find((p) => p.id === renewals)!
        .stages.map((s) => [s.name, s.winPercent]),
    ).toEqual([
      ['Due', 80],
      ['Unsure', null],
    ]);
  });

  it('links a deal to a conversation only for members who can see it', async () => {
    const { c, owner, agent, pipeline, newStage } = await setup();
    const waId = `91${randomInt(7_000_000_000, 9_999_999_999)}`;
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'I want 50 units' }] }));
    const [conv] = await fx.query<{ id: string; contact_id: string }>(
      `SELECT cv.id, cv.contact_id FROM app.conversations cv
         JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
        WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
      [c.tenant.id, waId],
    );
    // Assigned to the owner: the agent cannot see it, so cannot link it.
    await fx.dbs.adminPool.query(
      `UPDATE app.conversations SET assigned_membership_id = $1 WHERE id = $2`,
      [owner.membership.id, conv!.id],
    );
    const input = {
      contactId: conv!.contact_id,
      conversationId: conv!.id,
      pipelineId: pipeline.id,
      stageId: newStage.id,
      title: '50 units',
    };
    await expectAppError(crm().createDeal(agent, input), 'not_found');
    const { id } = await crm().createDeal(owner, input);
    expect((await crm().getDeal(owner, id)).conversationId).toBe(conv!.id);
    expect((await crm().getDeal(agent, id)).conversationId).toBeNull();
    // Another contact's conversation is refused.
    const other = await newContact(owner, 'Chitra');
    await expectAppError(crm().createDeal(owner, { ...input, contactId: other }), 'not_found');
  });

  it('keeps notes and tasks on the contact’s timeline', async () => {
    const { owner, agent, pipeline, newStage } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Divya');
    const { id: dealId } = await svc.createDeal(owner, {
      contactId,
      pipelineId: pipeline.id,
      stageId: newStage.id,
      title: 'Renewal',
    });
    await svc.addNote(agent, { dealId, body: 'Asked for a quote by Friday.' });
    await svc.addNote(agent, { contactId, body: 'Prefers WhatsApp over calls.' });
    const { id: taskId } = await svc.createTask(agent, {
      title: 'Send the quote',
      dealId,
      assigneeMembershipId: agent.membership.id,
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await svc.completeTask(agent, { id: taskId, expectedVersion: 1 });
    const view = await svc.contactCrm(owner, contactId);
    expect(view.contact).toMatchObject({ id: contactId, name: 'Divya', erased: false });
    expect(view.deals.map((d) => d.title)).toEqual(['Renewal']);
    expect(view.tasks).toEqual([]);
    expect(view.timeline.map((a) => [a.kind, a.body, a.taskTitle, a.dealTitle]).reverse()).toEqual([
      ['deal_created', null, null, 'Renewal'],
      ['note', 'Asked for a quote by Friday.', null, 'Renewal'],
      ['note', 'Prefers WhatsApp over calls.', null, null],
      ['task_created', null, 'Send the quote', 'Renewal'],
      ['task_completed', null, 'Send the quote', 'Renewal'],
    ]);
    // A task created for another contact's deal is refused.
    const other = await newContact(owner, 'Esha');
    await expectAppError(
      svc.createTask(agent, {
        title: 'X',
        dealId,
        contactId: other,
        assigneeMembershipId: agent.membership.id,
      }),
      'validation_failed',
      /another contact/,
    );
    // An unknown contact is not found rather than an empty CRM view.
    await expectAppError(svc.contactCrm(owner, crypto.randomUUID()), 'not_found');
  });
});

describe('crm tasks and reminders', () => {
  it('counts due tasks, and emails each reminder exactly once to an active assignee', async () => {
    const { c, owner, agent } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Farah');
    const soon = new Date(Date.now() + 30_000);
    const { id } = await svc.createTask(owner, {
      title: 'Call Farah back',
      contactId,
      assigneeMembershipId: agent.membership.id,
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      remindAt: soon.toISOString(),
    });
    // The reminder is scheduled as a delayed job in the transaction that created the task.
    const [job] = await fx.query<{ start_after: Date }>(
      `SELECT start_after FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
      [QUEUES.crmReminder.name, `${id}:${soon.getTime()}`],
    );
    expect(job!.start_after.getTime()).toBe(soon.getTime());
    expect(await svc.taskCounts(agent)).toEqual({ overdue: 1, dueToday: 0 });
    expect(await svc.taskCounts(owner)).toEqual({ overdue: 0, dueToday: 0 });
    await expectAppError(
      svc.createTask(owner, {
        title: 'Past',
        assigneeMembershipId: agent.membership.id,
        remindAt: new Date(Date.now() - 3600_000).toISOString(),
      }),
      'validation_failed',
      /in the future/,
    );

    const scope = authorizedTenantScope(c.tenant.id, null);
    expect(await sendTaskReminder(reminderDeps(), scope, id)).toBe('not_due');
    // Two workers at once: one email.
    const outcomes = await Promise.all([
      sendTaskReminder(reminderDeps(later(60_000)), scope, id),
      sendTaskReminder(reminderDeps(later(60_000)), scope, id),
    ]);
    expect(outcomes.sort()).toEqual(['idle', 'sent']);
    expect(await sendTaskReminder(reminderDeps(later(60_000)), scope, id)).toBe('idle');
    const emails = await fx.query<{ kind: string; to_address: string }>(
      `SELECT kind, to_address FROM ops.email_outbox WHERE tenant_id = $1 AND kind = 'crm.task_reminder'`,
      [c.tenant.id],
    );
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to_address).toBe(c.agent.email);
    const [task] = (await svc.listTasks(agent, { scope: 'mine' })).filter((t) => t.id === id);
    expect(task).toMatchObject({ reminderState: 'sent', status: 'open' });

    // Changing the reminder time schedules a new one; closing the task skips it.
    await svc.updateTask(agent, {
      id,
      expectedVersion: 1,
      title: 'Call Farah back',
      notes: null,
      dueAt: null,
      remindAt: new Date(Date.now() + 3600_000).toISOString(),
      assigneeMembershipId: agent.membership.id,
    });
    await svc.completeTask(agent, { id, expectedVersion: 2 });
    const [done] = (await svc.listTasks(agent, { scope: 'mine', status: 'done' })).filter(
      (t) => t.id === id,
    );
    expect(done).toMatchObject({
      status: 'done',
      reminderState: 'skipped',
      reminderDetail: 'task_closed',
    });
    await svc.reopenTask(agent, { id, expectedVersion: 3 });
    expect(await sendTaskReminder(reminderDeps(later(2 * 3600_000)), scope, id)).toBe('idle');

    // A reminder more than a day late, or for a member who left, is skipped with the reason.
    const { id: late } = await svc.createTask(owner, {
      title: 'Late one',
      assigneeMembershipId: agent.membership.id,
      remindAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(await sendTaskReminder(reminderDeps(later(25 * 3600_000)), scope, late)).toBe('skipped');
    const { id: gone } = await svc.createTask(owner, {
      title: 'For someone who leaves',
      assigneeMembershipId: agent.membership.id,
      remindAt: new Date(Date.now() + 1000).toISOString(),
    });
    await fx.query(
      `UPDATE app.memberships SET status = 'removed' WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, c.agent.id],
    );
    expect(await sendTaskReminder(reminderDeps(later(5000)), scope, gone)).toBe('skipped');
    const skipped = await fx.query<{ id: string; reminder_detail: string }>(
      `SELECT id, reminder_detail FROM app.crm_tasks WHERE id = ANY($1::uuid[]) ORDER BY title`,
      [[late, gone]],
    );
    expect(skipped.map((s) => s.reminder_detail)).toEqual(['assignee_inactive', 'too_late']);
    await fx.query(
      `UPDATE app.memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, c.agent.id],
    );
  });

  it('signals overdue reminders from the sweep, for active companies only', async () => {
    const { c, owner, agent } = await setup();
    const { id } = await crm().createTask(owner, {
      title: 'Overdue reminder',
      assigneeMembershipId: agent.membership.id,
      remindAt: new Date(Date.now() + 500).toISOString(),
    });
    // Pretend the reminder time passed a minute ago and its job was lost.
    await fx.dbs.adminPool.query(
      `UPDATE app.crm_tasks SET remind_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    expect((await findDueReminders(fx.dbs.app)).map((r) => r.taskId)).toContain(id);
    await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [
      c.tenant.id,
    ]);
    expect((await findDueReminders(fx.dbs.app)).map((r) => r.taskId)).not.toContain(id);
    await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [
      c.tenant.id,
    ]);
  });
});

describe('crm races and edge cases', () => {
  it('runs a CRM change and an erasure of the same contact one after the other', async () => {
    const { owner, agent } = await setup();
    const svc = crm();
    const notesOf = async (contactId: string) =>
      (
        await fx.query<{ n: number }>(
          'select count(*)::int as n from app.crm_activities where contact_id = $1',
          [contactId],
        )
      )[0]?.n;

    // A note written while an erasure holds the contact waits, then sees the erasure and refuses.
    const first = await newContact(owner, 'Farah');
    const erasure = await holdLock('select 1 from app.contacts where id = $1 for update', [first]);
    const note = svc.addNote(agent, { contactId: first, body: 'Lives at 12 Park Street' });
    // Its refusal is expected from the start: once the lock goes it can come before the commit's
    // answer, and a rejection with no handler yet fails the run.
    const noteRefused = expectAppError(note, 'conflict', /erased/);
    await erasure.blocking();
    await erasure.client.query('update app.contacts set erased_at = now() where id = $1', [first]);
    await erasure.commit();
    await noteRefused;
    expect(await notesOf(first)).toBe(0);

    // An erasure started while a CRM change holds the contact waits, then removes what it wrote.
    const second = await newContact(owner, 'Gita');
    const change = await holdLock('select 1 from app.contacts where id = $1 for key share', [
      second,
    ]);
    const erase = createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(
      owner,
      { contactId: second, suppress: false },
    );
    await change.blocking();
    await change.client.query(
      `insert into app.crm_activities (id, tenant_id, contact_id, kind, body)
       values (gen_random_uuid(), $1, $2, 'note', 'Lives at 5 Hill Road')`,
      [owner.tenant.id, second],
    );
    await change.commit();
    await erase;
    expect(await notesOf(second)).toBe(0);
  });

  it('never leaves an open deal in a stage removed at the same time', async () => {
    const { owner, agent, pipeline, proposal } = await setup();
    const contactId = await newContact(owner, 'Hema');
    // A settings change locks the pipeline, finds no open deal in "Proposal" and removes it.
    const settings = await holdLock('select 1 from app.crm_pipelines where id = $1 for update', [
      pipeline.id,
    ]);
    const creating = crm().createDeal(agent, {
      contactId,
      pipelineId: pipeline.id,
      stageId: proposal.id,
      title: 'Late arrival',
    });
    // Expected from the start, as the note's refusal above.
    const refused = expectAppError(creating, 'conflict', /removed/);
    await settings.blocking();
    await settings.client.query('update app.crm_stages set archived_at = now() where id = $1', [
      proposal.id,
    ]);
    await settings.commit();
    await refused;
  });

  it('reopens a deal whose stage was removed in the first stage, but not in an archived pipeline', async () => {
    const { owner, agent, pipeline, newStage, qualified, proposal } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Jaya');
    const { id } = await svc.createDeal(agent, {
      contactId,
      pipelineId: pipeline.id,
      stageId: proposal.id,
      title: 'Renewal',
    });
    await svc.closeDeal(agent, { id, expectedVersion: 1, outcome: 'lost' });
    // "Proposal" has no open deal, so it can be removed; the lost deal stays in it.
    await svc.updatePipeline(owner, {
      id: pipeline.id,
      expectedVersion: pipeline.version,
      name: 'Sales',
      stages: [
        { id: newStage.id, name: 'New' },
        { id: qualified.id, name: 'Qualified' },
      ],
    });
    await svc.reopenDeal(agent, { id, expectedVersion: 2 });
    const deal = await svc.getDeal(agent, id);
    expect(deal).toMatchObject({ status: 'open', stageId: newStage.id, version: 3 });
    expect(
      deal.timeline
        .slice(0, 2)
        .map((a) => a.kind)
        .sort(),
    ).toEqual(['deal_reopened', 'stage_changed']);
    // A closed deal in an archived pipeline waits for the pipeline to be restored.
    await svc.closeDeal(agent, { id, expectedVersion: 3, outcome: 'won' });
    const [current] = (await svc.listPipelines(owner)).filter((p) => p.id === pipeline.id);
    await svc.archivePipeline(owner, { id: pipeline.id, expectedVersion: current!.version });
    await expectAppError(svc.reopenDeal(agent, { id, expectedVersion: 4 }), 'conflict', /archived/);
    // Impossible dates are refused, not rolled over.
    await expectAppError(
      svc.createDeal(agent, {
        contactId,
        pipelineId: pipeline.id,
        stageId: newStage.id,
        title: 'Leap',
        expectedCloseOn: '2026-02-31',
      }),
      'validation_failed',
    );
  });

  it('pages through closed deals without skipping any that changed at the same moment', async () => {
    const { owner, pipeline, newStage } = await setup();
    const contactId = await newContact(owner, 'Isha');
    // 60 deals won in one statement share one change time, to the microsecond.
    await fx.query(
      `insert into app.crm_deals (id, tenant_id, pipeline_id, stage_id, contact_id, title, status,
         closed_at, closed_by_membership_id, created_by_membership_id)
       select gen_random_uuid(), $1, $2, $3, $4, 'Deal ' || g, 'won', now(), $5, $5
         from generate_series(1, 60) g`,
      [owner.tenant.id, pipeline.id, newStage.id, contactId, owner.membership.id],
    );
    const first = await crm().listDeals(owner, { status: 'won' });
    expect(first.deals).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await crm().listDeals(owner, { status: 'won', cursor: first.nextCursor });
    expect(second.deals).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.deals, ...second.deals].map((d) => d.id)).size).toBe(60);
  });
});

describe('crm deal export (ADR-239)', () => {
  /** The export's lines without the byte order mark and the last line break. */
  async function exported(ctx: TenantContext, input: unknown = {}) {
    let csv = '';
    for await (const chunk of crm().exportDeals(ctx, input, { ipAddress: '203.0.113.9' })) {
      csv += chunk;
    }
    expect(csv.startsWith('\uFEFF')).toBe(true);
    return csv.slice(1).split('\r\n').slice(0, -1);
  }

  async function phoneOf(contactId: string) {
    const [row] = await fx.query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM app.contacts WHERE id = $1',
      [contactId],
    );
    return row!.phone_e164;
  }

  it('writes the deals a view shows with its filters, numbers as the member may see them, and audits each export', async () => {
    const { c, owner, agent, marketer, pipeline, newStage, qualified } = await setup();
    const svc = crm();
    const asha = await newContact(owner, 'Asha');
    const bala = await newContact(owner, 'Bala');
    const { id: openId } = await svc.createDeal(owner, {
      contactId: asha,
      pipelineId: pipeline.id,
      stageId: newStage.id,
      title: 'Annual plan',
      value: '25,000.50',
      ownerMembershipId: agent.membership.id,
      expectedCloseOn: '2026-12-31',
    });
    await svc.createTask(owner, {
      title: 'Send the proposal',
      dealId: openId,
      assigneeMembershipId: owner.membership.id,
    });
    const { id: lostId } = await svc.createDeal(owner, {
      contactId: bala,
      pipelineId: pipeline.id,
      stageId: qualified.id,
      title: '=HYPERLINK("http://x")',
    });
    await svc.closeDeal(owner, {
      id: lostId,
      expectedVersion: 1,
      outcome: 'lost',
      lostReason: 'Too expensive',
    });

    // Newest first; the formula in the title neutralised; values exact; times in UTC.
    const all = await exported(owner);
    expect(all).toHaveLength(3);
    expect(all[0]).toBe(DEAL_CSV_COLUMNS.join(','));
    const lost = all[1]!.split(',');
    expect(lost.slice(0, 10)).toEqual([
      lostId,
      `"'=HYPERLINK(""http://x"")"`,
      'Sales',
      'Qualified',
      'lost',
      'INR',
      '',
      '',
      'Bala',
      await phoneOf(bala),
    ]);
    expect(lost.slice(13)).toEqual([expect.stringMatching(/^2\d{3}-.+Z$/), 'Too expensive', '0']);
    const open = all[2]!.split(',');
    expect([...open.slice(0, 11), ...open.slice(13)]).toEqual([
      openId,
      'Annual plan',
      'Sales',
      'New',
      'open',
      'INR',
      '25000.50',
      'Agent',
      'Asha',
      await phoneOf(asha),
      '2026-12-31',
      '',
      '',
      '1',
    ]);
    expect(new Date(open[11]!).toISOString()).toBe(open[11]);

    // The filters of the board and the lists.
    expect(await exported(owner, { status: 'open' })).toHaveLength(2);
    expect(await exported(owner, { status: 'lost', pipelineId: pipeline.id })).toHaveLength(2);
    expect(await exported(owner, { status: 'open', owner: 'mine' })).toHaveLength(1);
    expect(await exported(owner, { owner: agent.membership.id })).toHaveLength(2);
    await expectAppError(exported(owner, { status: 'closed' }), 'validation_failed');
    const other = await setup();
    await expectAppError(exported(owner, { pipelineId: other.pipeline.id }), 'not_found');
    expect(await exported(other.owner)).toEqual([DEAL_CSV_COLUMNS.join(',')]);

    // CRM access without contact exports, or contact exports without CRM access, is refused.
    await expectAppError(exported(agent), 'forbidden');
    await expectAppError(exported(marketer), 'forbidden');

    // A member with both, whose roles the company masks, gets numbers masked (ADR-226).
    const user = await createUser(fx.dbs, { name: 'Sales lead' });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, ['agent', 'marketer']);
    await acceptInvitation(fx.dbs, user, token);
    await fx.query(
      `UPDATE app.tenants SET masked_number_roles = '{agent,marketer}' WHERE id = $1`,
      [c.tenant.id],
    );
    const lead = await fx.ctx(c, user);
    expect(lead.permissions.has('contacts.view_numbers')).toBe(false);
    const masked = await exported(lead, { status: 'open' });
    expect(masked[1]!.split(',')[9]).toBe(`'${maskPhoneNumber(await phoneOf(asha))}`);
    expect(masked.join('\n')).not.toContain(await phoneOf(asha));

    // Each export is audited with its filters; refused ones are not.
    const audit = await fx.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'crm.deals_exported' ORDER BY id`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      { actor_id: c.owner.id, metadata: { status: null, pipelineId: null, owner: 'all' } },
      { actor_id: c.owner.id, metadata: { status: 'open', pipelineId: null, owner: 'all' } },
      { actor_id: c.owner.id, metadata: { status: 'lost', pipelineId: pipeline.id, owner: 'all' } },
      { actor_id: c.owner.id, metadata: { status: 'open', pipelineId: null, owner: 'mine' } },
      {
        actor_id: c.owner.id,
        metadata: { status: null, pipelineId: null, owner: agent.membership.id },
      },
      { actor_id: user.id, metadata: { status: 'open', pipelineId: null, owner: 'all' } },
    ]);
  });

  it('exports more deals than one batch holds, created at the same moment, each once', async () => {
    const { owner, pipeline, newStage } = await setup();
    const contactId = await newContact(owner, 'Isha');
    // Deals created in one statement share one creation time, to the microsecond.
    await fx.query(
      `insert into app.crm_deals (id, tenant_id, pipeline_id, stage_id, contact_id, title,
         created_by_membership_id)
       select gen_random_uuid(), $1, $2, $3, $4, 'Deal ' || g, $5
         from generate_series(1, $6::int) g`,
      [
        owner.tenant.id,
        pipeline.id,
        newStage.id,
        contactId,
        owner.membership.id,
        DEAL_EXPORT_BATCH + 1,
      ],
    );
    const lines = await exported(owner);
    expect(lines).toHaveLength(DEAL_EXPORT_BATCH + 2);
    expect(new Set(lines.slice(1).map((line) => line.split(',')[0])).size).toBe(
      DEAL_EXPORT_BATCH + 1,
    );
  });
});

describe('crm erasure, reports and isolation', () => {
  it('erasure removes the contact’s timeline, notes and tasks and blanks deal text, keeping outcomes', async () => {
    const { owner, pipeline, newStage } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Gita');
    const { id: dealId } = await svc.createDeal(owner, {
      contactId,
      pipelineId: pipeline.id,
      stageId: newStage.id,
      title: 'Gita’s wedding order',
      value: '50000',
    });
    await svc.closeDeal(owner, {
      id: dealId,
      expectedVersion: 1,
      outcome: 'lost',
      lostReason: 'Gita moved abroad',
    });
    await svc.addNote(owner, { contactId, body: 'Gita’s address is 12 Park Street.' });
    await svc.createTask(owner, {
      title: 'Visit Gita',
      contactId,
      assigneeMembershipId: owner.membership.id,
    });
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId,
      suppress: false,
    });
    const deal = await svc.getDeal(owner, dealId);
    expect(deal).toMatchObject({
      title: 'Deal (contact erased)',
      lostReason: null,
      status: 'lost',
      valueMinor: 5000000,
      contact: { erased: true, name: null },
      timeline: [],
    });
    const left = await fx.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM app.crm_tasks WHERE contact_id = $1)::int
            + (SELECT count(*) FROM app.crm_activities WHERE contact_id = $1)::int AS n`,
      [contactId],
    );
    expect(left[0]!.n).toBe(0);
    await expectAppError(
      svc.updateDeal(owner, {
        id: dealId,
        expectedVersion: 2,
        title: 'X',
        value: '',
        ownerMembershipId: null,
        expectedCloseOn: null,
      }),
      'conflict',
      /erased/,
    );
    await expectAppError(svc.addNote(owner, { contactId, body: 'x' }), 'conflict', /erased/);
  });

  it('reports deals won and lost per currency, the win rate, time to win and the open pipeline', async () => {
    const { owner, pipeline, newStage, qualified } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Hari');
    const deal = (title: string, value: string, stageId = newStage.id) =>
      svc.createDeal(owner, { contactId, pipelineId: pipeline.id, stageId, title, value });
    const a = await deal('A', '1000');
    const b = await deal('B', '250.50');
    await deal('C', '400', qualified.id);
    await deal('D', '');
    const e = await deal('E', '99');
    await svc.closeDeal(owner, { id: a.id, expectedVersion: 1, outcome: 'won' });
    await svc.closeDeal(owner, { id: b.id, expectedVersion: 1, outcome: 'won' });
    await svc.closeDeal(owner, { id: e.id, expectedVersion: 1, outcome: 'lost' });
    const { id: usdId } = await svc.createPipeline(owner, {
      name: 'Export',
      currency: 'USD',
      stages: ['Lead'],
    });
    const usd = (await svc.listPipelines(owner)).find((p) => p.id === usdId)!;
    const f = await svc.createDeal(owner, {
      contactId,
      pipelineId: usd.id,
      stageId: usd.stages[0]!.id,
      title: 'F',
      value: '10.25',
    });
    await svc.closeDeal(owner, { id: f.id, expectedVersion: 1, outcome: 'won' });

    const reports = createReportsService({ db: fx.dbs.app, clock: systemClock });
    const report = await reports.getReport(owner, { preset: 'last_7_days' });
    expect(report.deals.won).toEqual([
      { currency: 'INR', deals: 2, valueMinor: 125050 },
      { currency: 'USD', deals: 1, valueMinor: 1025 },
    ]);
    expect(report.deals.lost).toEqual([{ currency: 'INR', deals: 1, valueMinor: 9900 }]);
    expect(report.deals.winRate).toEqual({ numerator: 3, denominator: 4 });
    expect(report.deals.medianSecondsToWin).toBeGreaterThanOrEqual(0);
    const sales = report.deals.pipelines.find((p) => p.id === pipeline.id)!;
    expect(sales.stages.map((s) => [s.name, s.deals, s.valueMinor])).toEqual([
      ['New', 1, 0],
      ['Qualified', 1, 40000],
      ['Proposal', 0, 0],
    ]);
    const current = report.definitions.find((d) => d.key === 'crm.deal_outcomes')!;
    expect(current).toMatchObject({ version: 2, available: true });
    const csv = await reports.exportSection(owner, { preset: 'last_7_days' }, 'deals');
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe('day,time_zone,currency,deals_won,value_won,deals_lost,value_lost');
    expect(lines.slice(1).map((l) => l.split(',').slice(2).join(','))).toEqual([
      'INR,2,1250.50,1,99.00',
      'USD,1,10.25,0,0.00',
    ]);
  });

  it('forecasts the open deals by expected close month in Reports, weighed as on the board (ADR-252)', async () => {
    const { owner, pipeline, newStage, qualified, proposal } = await setup();
    const svc = crm();
    const contactId = await newContact(owner, 'Ira');
    await svc.updatePipeline(owner, {
      id: pipeline.id,
      expectedVersion: pipeline.version,
      name: 'Sales',
      stages: [
        { id: newStage.id, name: 'New', winPercent: 10 },
        { id: qualified.id, name: 'Qualified', winPercent: 50 },
        { id: proposal.id, name: 'Proposal' },
      ],
    });
    const months = forecastMonths(new Date(), owner.tenant.timezone);
    const monthEnd = monthEndIn(new Date(), owner.tenant.timezone);
    const deal = (stageId: string, title: string, value: string, expectedCloseOn: string | null) =>
      svc.createDeal(owner, {
        contactId,
        pipelineId: pipeline.id,
        stageId,
        title,
        value,
        expectedCloseOn,
      });
    // A date already past, this month, the next two months, much later and no date.
    await deal(newStage.id, 'Overdue', '1,000', '2020-01-15');
    await deal(qualified.id, 'This month', '500', monthEnd);
    await deal(qualified.id, 'Next month', '300', `${months[1]}-15`);
    await deal(newStage.id, 'Month after', '200', `${months[2]}-01`);
    await deal(qualified.id, 'Much later', '100', '2099-06-30');
    await deal(proposal.id, 'Undated', '2,000', null);
    // A closed deal is not forecast.
    const closed = await deal(qualified.id, 'Closed', '9,999', monthEnd);
    await svc.closeDeal(owner, { id: closed.id, expectedVersion: 1, outcome: 'won' });

    const reports = createReportsService({ db: fx.dbs.app, clock: systemClock });
    const report = await reports.getReport(owner, { preset: 'last_7_days' });
    const sales = report.deals.pipelines.find((p) => p.id === pipeline.id)!;
    expect(sales.forecast).toEqual({
      months,
      buckets: [
        { bucket: 'this_month', deals: 2, valueMinor: 150_000, weightedMinor: 10_000 + 25_000 },
        { bucket: 'next_month', deals: 1, valueMinor: 30_000, weightedMinor: 15_000 },
        { bucket: 'month_after', deals: 1, valueMinor: 20_000, weightedMinor: 2_000 },
        { bucket: 'later', deals: 1, valueMinor: 10_000, weightedMinor: 5_000 },
        { bucket: 'undated', deals: 1, valueMinor: 200_000, weightedMinor: 0 },
      ],
      hasChances: true,
      dealsWithoutChance: 1,
    });
    // This month's weighted value is the board's.
    const board = (await svc.board(owner, { pipelineId: pipeline.id }))!;
    expect(board.forecast.weightedMonthMinor).toBe(35_000);
    expect(report.definitions.find((d) => d.key === 'crm.forecast')).toMatchObject({
      version: 1,
      available: true,
    });

    // Only a stage without open deals has a chance (found in review): the pipeline has one all the
    // same, as on the board, so its forecast weighs (to 0) instead of saying no stage has one.
    const { id: renewalsId } = await svc.createPipeline(owner, {
      name: 'Renewals',
      currency: 'INR',
      stages: ['Open', 'Likely'],
    });
    const [renewals] = (await svc.listPipelines(owner)).filter((p) => p.id === renewalsId);
    const [opened, likely] = renewals!.stages;
    await svc.updatePipeline(owner, {
      id: renewalsId,
      expectedVersion: renewals!.version,
      name: 'Renewals',
      stages: [
        { id: opened!.id, name: 'Open' },
        { id: likely!.id, name: 'Likely', winPercent: 70 },
      ],
    });
    await svc.createDeal(owner, {
      contactId,
      pipelineId: renewalsId,
      stageId: opened!.id,
      title: 'Renewal',
      value: '700',
      expectedCloseOn: null,
    });
    const later = await reports.getReport(owner, { preset: 'last_7_days' });
    const renewalsForecast = later.deals.pipelines.find((p) => p.id === renewalsId)!.forecast;
    expect(renewalsForecast).toMatchObject({ hasChances: true, dealsWithoutChance: 1 });
    expect(renewalsForecast.buckets.map((b) => b.weightedMinor)).toEqual([0, 0, 0, 0, 0]);
    expect((await svc.board(owner, { pipelineId: renewalsId }))!.forecast.hasChances).toBe(true);
  });

  it('keeps pipelines, deals and tasks inside their company', async () => {
    const a = await setup();
    const b = await setup();
    const contactId = await newContact(a.owner, 'Isha');
    const { id: dealId } = await crm().createDeal(a.owner, {
      contactId,
      pipelineId: a.pipeline.id,
      stageId: a.newStage.id,
      title: 'Private deal',
    });
    const { id: taskId } = await crm().createTask(a.owner, {
      title: 'Private task',
      contactId,
      assigneeMembershipId: a.owner.membership.id,
    });
    await expectAppError(crm().getDeal(b.owner, dealId), 'not_found');
    await expectAppError(crm().board(b.owner, { pipelineId: a.pipeline.id }), 'not_found');
    await expectAppError(
      crm().moveDeal(b.owner, { id: dealId, expectedVersion: 1, stageId: b.newStage.id }),
      'not_found',
    );
    await expectAppError(
      crm().completeTask(b.owner, { id: taskId, expectedVersion: 1 }),
      'not_found',
    );
    await expectAppError(
      crm().createDeal(b.owner, {
        contactId,
        pipelineId: b.pipeline.id,
        stageId: b.newStage.id,
        title: 'Cross-company',
      }),
      'not_found',
    );
    await expectAppError(
      crm().updatePipeline(b.owner, {
        id: a.pipeline.id,
        expectedVersion: 1,
        name: 'Taken',
        stages: [{ id: null, name: 'X' }],
      }),
      'not_found',
    );
    expect((await crm().listTasks(b.owner, { scope: 'all' })).map((t) => t.id)).not.toContain(
      taskId,
    );
    await expectAppError(crm().contactCrm(b.owner, contactId), 'not_found');
  });
});
