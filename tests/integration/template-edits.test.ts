import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, type TenantScope } from '@w360/db';
import {
  createTemplatesService,
  processTemplateEdit,
  processTemplateSubmit,
  syncTemplates,
  templateEditRef,
  toMetaComponents,
  type TemplateDefinition,
  type TemplatesService,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Editing a template Meta has (ADR-404) against real PostgreSQL and the Graph stand-in: the edit is
 * written ahead and sent once, the template read again from Meta and stored as Meta reports it; a
 * lost answer is settled by the sync; Meta's refusal is shown with its code; another company's
 * template is not found, and a member who may not submit templates is refused.
 */
let fx: WhatsAppFixture;
let templates: TemplatesService;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  templates = createTemplatesService({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
  });
});

afterAll(async () => {
  await fx.close();
});

beforeEach(() => {
  fx.standIn.state.templateCreateQueue = [];
  fx.standIn.state.templateEditQueue = [];
  fx.standIn.state.templateReadError = null;
});

const workerDeps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  graph: fx.graph,
  clock,
});
const scopeOf = (c: Company): TenantScope => authorizedTenantScope(c.tenant.id, null);

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

const shipped: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'text', text: 'Order {{1}}', example: 'A-1001' },
  body: { text: 'Hi {{1}}, your order {{2}} is on its way.', examples: ['Asha', 'A-1001'] },
  footer: 'Reply STOP to opt out',
  buttons: [{ type: 'URL', text: 'Help centre', url: 'https://example.test/help' }],
};
const delayed: TemplateDefinition = {
  ...shipped,
  body: { text: 'Hi {{1}}, your order {{2}} is delayed by a day.', examples: ['Asha', 'A-1001'] },
};

interface Row {
  status: string;
  category: string;
  components: unknown[];
  provider_template_id: string | null;
  edit_state: string | null;
  edit_components: unknown[] | null;
  edit_error: string | null;
  edit_requested_by_user_id: string | null;
}

async function templateRow(id: string): Promise<Row> {
  const [row] = await fx.query<Row & Record<string, unknown>>(
    `SELECT status, category, components, provider_template_id, edit_state, edit_components,
            edit_error, edit_requested_by_user_id
       FROM app.message_templates WHERE id = $1`,
    [id],
  );
  return row!;
}

async function history(id: string) {
  return fx.query<{
    status: string;
    source: string;
    reason: string | null;
    actor_user_id: string | null;
  }>(
    `SELECT status, source, reason, actor_user_id FROM app.template_status_events
      WHERE template_id = $1 ORDER BY occurred_at, id`,
    [id],
  );
}

async function audits(c: Company, id: string) {
  return fx.query<{ action: string; actor_type: string; actor_id: string | null; result: string }>(
    `SELECT action, actor_type, actor_id, result FROM app.audit_events
      WHERE tenant_id = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
    [c.tenant.id, id],
  );
}

/** The open edit's job reference, as `writeEditTemplate` queued it. */
async function editRef(id: string): Promise<string> {
  const [row] = await fx.query<{ edit_id: string | null }>(
    'SELECT edit_id FROM app.message_templates WHERE id = $1',
    [id],
  );
  expect(row?.edit_id).toBeTruthy();
  return templateEditRef(id, row!.edit_id!);
}

/** Runs the open edit's job, as the worker would. */
async function runEdit(c: Company, id: string) {
  return processTemplateEdit(workerDeps(), scopeOf(c), await editRef(id));
}

/** Moves an open edit's request back, so its window has run out on the database's clock. */
async function ageEdit(id: string, minutes = 11) {
  await fx.query(
    `UPDATE app.message_templates
        SET edit_requested_at = edit_requested_at - make_interval(mins => $2)
      WHERE id = $1`,
    [id, minutes],
  );
}

const editsTo = (hsmId: string) =>
  fx.standIn.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith(`/${hsmId}`));

/** A template submitted, approved and synced, as Meta has it. */
async function approvedTemplate(c: Company, name: string) {
  const owner = await fx.ctx(c, c.owner);
  const { id } = await templates.createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name,
    language: 'en',
    definition: shipped,
  });
  await templates.submitTemplate(owner, id);
  expect(await processTemplateSubmit(workerDeps(), scopeOf(c), id)).toBe('done');
  const remote = fx.standIn.state.templates.get(c.wabaId)!.find((t) => t.name === name)!;
  remote.status = 'APPROVED';
  expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
  const row = await templateRow(id);
  expect(row.status).toBe('approved');
  return { id, hsmId: row.provider_template_id!, remote };
}

describe('editing a template Meta has', () => {
  let c: Company;
  beforeAll(async () => {
    c = await fx.company();
  });

  it('writes the edit ahead, sends it once and stores what Meta reports after it', async () => {
    const { id, hsmId, remote } = await approvedTemplate(c, 'edit_once');
    const owner = await fx.ctx(c, c.owner);
    await templates.editTemplate(owner, id, { definition: delayed });

    // Written ahead: the content sent and who asked; Meta's status and content are unchanged.
    let row = await templateRow(id);
    expect(row).toMatchObject({
      status: 'approved',
      components: toMetaComponents(shipped),
      edit_state: 'sending',
      edit_components: toMetaComponents(delayed),
      edit_error: null,
      edit_requested_by_user_id: c.owner.id,
    });
    // One edit at a time: another is refused while this one is sending.
    await expectAppError(
      templates.editTemplate(owner, id, { definition: shipped }),
      'precondition_failed',
      /waiting for Meta’s answer/,
    );
    // Deleting waits for Meta's answer too.
    await expectAppError(templates.deleteTemplate(owner, id), 'precondition_failed');

    // Meta takes the edit and, in this stand-in, puts the template back in review.
    fx.standIn.state.templateEditQueue = [{ kind: 'accept', status: 'PENDING' }];
    const before = editsTo(hsmId).length;
    const ref = await editRef(id);
    expect(await processTemplateEdit(workerDeps(), scopeOf(c), ref)).toBe('done');
    expect(editsTo(hsmId).length).toBe(before + 1);
    expect(editsTo(hsmId).at(-1)?.body).toEqual({
      category: 'UTILITY',
      components: toMetaComponents(delayed),
    });
    expect(remote.components).toEqual(toMetaComponents(delayed));
    // The template was read again by id (`GET /{template-id}`).
    expect(
      fx.standIn.state.requests.some((r) => r.method === 'GET' && r.path.endsWith(`/${hsmId}`)),
    ).toBe(true);

    row = await templateRow(id);
    expect(row).toMatchObject({
      status: 'pending',
      category: 'UTILITY',
      components: toMetaComponents(delayed),
      edit_state: null,
      edit_components: null,
      edit_error: null,
      edit_requested_by_user_id: null,
    });
    const events = (await history(id)).filter((e) => e.source === 'edit');
    expect(events.map((e) => [e.status, e.actor_user_id])).toEqual([
      ['edit_requested', c.owner.id],
      ['edited', c.owner.id],
      ['pending', null],
    ]);
    const log = await audits(c, id);
    expect(log.find((a) => a.action === 'template.edit_requested')).toMatchObject({
      actor_type: 'user',
      actor_id: c.owner.id,
      result: 'success',
    });
    expect(log.find((a) => a.action === 'template.edited')).toMatchObject({ result: 'success' });

    // The job again finds nothing to send: the edit is sent once.
    expect(await processTemplateEdit(workerDeps(), scopeOf(c), ref)).toBe('skipped');
    expect(editsTo(hsmId).length).toBe(before + 1);
  });

  it('keeps the status Meta reports, assuming none, and requests a sync when the read fails', async () => {
    const { id, hsmId } = await approvedTemplate(c, 'edit_keeps_status');
    const owner = await fx.ctx(c, c.owner);
    await templates.editTemplate(owner, id, { definition: delayed });
    fx.standIn.state.templateEditQueue = [{ kind: 'accept' }];
    fx.standIn.state.templateReadError = { status: 500, code: 1, message: 'Unknown error' };
    expect(await runEdit(c, id)).toBe('done');
    expect(editsTo(hsmId).length).toBe(1);
    const row = await templateRow(id);
    // The edit is made, the status is still the one Meta last reported (no PENDING assumed), and
    // the content is read at the sync that was requested.
    expect(row).toMatchObject({ status: 'approved', edit_state: null });
    const [account] = await fx.query<{ requested: boolean }>(
      `SELECT templates_sync_requested_at >= templates_synced_at AS requested
         FROM app.whatsapp_accounts WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(account?.requested).toBe(true);
    fx.standIn.state.templateReadError = null;
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect((await templateRow(id)).components).toEqual(toMetaComponents(delayed));
  });

  it('settles a lost answer at the sync: confirmed by Meta’s content, or unconfirmed after the window', async () => {
    const { id: made } = await approvedTemplate(c, 'edit_lost_made');
    const { id: lost } = await approvedTemplate(c, 'edit_lost_never');
    const owner = await fx.ctx(c, c.owner);

    // Meta made the edit, but the answer never arrived.
    await templates.editTemplate(owner, made, { definition: delayed });
    fx.standIn.state.templateEditQueue = [{ kind: 'apply_then_drop' }];
    expect(await runEdit(c, made)).toBe('done');
    expect(await templateRow(made)).toMatchObject({
      edit_state: 'sending',
      edit_error: 'Waiting for Meta to confirm the edit.',
    });

    // The request never reached Meta, and no answer came either.
    await templates.editTemplate(owner, lost, { definition: delayed });
    fx.standIn.state.templateEditQueue = [{ kind: 'drop_connection' }];
    expect(await runEdit(c, lost)).toBe('done');

    // The account is due for a sync every 5 minutes while an edit is sending (migration 0316),
    // and only for that: in a rolled-back transaction every other account is synced now and this
    // account's templates in review are set aside, so the shared database's order cannot hide it.
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE app.whatsapp_accounts SET templates_synced_at = now(), templates_sync_requested_at = NULL
          WHERE id <> $1`,
        [c.whatsappAccountId],
      );
      await client.query(
        `UPDATE app.whatsapp_accounts
            SET templates_synced_at = now() - interval '6 minutes', templates_sync_requested_at = NULL
          WHERE id = $1`,
        [c.whatsappAccountId],
      );
      await client.query(
        `UPDATE app.message_templates SET status = 'approved'
          WHERE whatsapp_account_id = $1 AND status IN ('submitting', 'pending', 'in_appeal')`,
        [c.whatsappAccountId],
      );
      const due = async () =>
        (
          await client.query<{ whatsapp_account_id: string }>(
            'SELECT whatsapp_account_id FROM ops.template_sync_due(500)',
          )
        ).rows.map((r) => r.whatsapp_account_id);
      expect(await due()).toEqual([c.whatsappAccountId]);
      // Without an edit sending, nothing makes it due.
      await client.query(
        `UPDATE app.message_templates SET edit_state = NULL, edit_components = NULL
          WHERE whatsapp_account_id = $1`,
        [c.whatsappAccountId],
      );
      expect(await due()).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // Within the window: the made edit is confirmed, the other waits.
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect(await templateRow(made)).toMatchObject({
      components: toMetaComponents(delayed),
      edit_state: null,
    });
    expect((await history(made)).at(-1)).toMatchObject({
      status: 'edited',
      source: 'sync',
      actor_user_id: c.owner.id,
    });
    expect((await templateRow(lost)).edit_state).toBe('sending');

    // After the window, on the database's clock: unconfirmed, with the content kept to send again.
    await ageEdit(lost);
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    const row = await templateRow(lost);
    expect(row).toMatchObject({
      components: toMetaComponents(shipped),
      edit_state: 'failed',
      edit_components: toMetaComponents(delayed),
    });
    expect(row.edit_error).toMatch(/could not confirm the edit/);
    expect((await history(lost)).at(-1)).toMatchObject({ status: 'edit_failed', source: 'sync' });
    // Nothing was sent again automatically; a member may send it again.
    await templates.editTemplate(owner, lost, { definition: delayed });
    expect((await templateRow(lost)).edit_state).toBe('sending');
  });

  it('shows Meta’s refusal with its code and message, and changes nothing at Meta', async () => {
    const { id, remote } = await approvedTemplate(c, 'edit_refused');
    const owner = await fx.ctx(c, c.owner);
    await templates.editTemplate(owner, id, { definition: delayed });
    fx.standIn.state.templateEditQueue = [
      { kind: 'error', status: 400, code: 2388299, message: 'This template cannot be edited now' },
    ];
    expect(await runEdit(c, id)).toBe('done');
    expect(remote.components).toEqual(toMetaComponents(shipped));
    const row = await templateRow(id);
    expect(row).toMatchObject({
      status: 'approved',
      components: toMetaComponents(shipped),
      edit_state: 'failed',
      edit_components: toMetaComponents(delayed),
      edit_error: 'Meta refused the edit (code 2388299): This template cannot be edited now',
    });
    expect((await history(id)).at(-1)).toMatchObject({
      status: 'edit_failed',
      source: 'edit',
      reason: '2388299: This template cannot be edited now',
      actor_user_id: c.owner.id,
    });
    expect((await audits(c, id)).find((a) => a.action === 'template.edit_failed')).toMatchObject({
      result: 'failure',
    });
    const detail = await templates.getTemplate(owner, id);
    expect(detail.template.editError).toContain('code 2388299');
    expect(detail.editDefinition).toEqual(delayed);
  });

  it('keeps the category and refuses no change', async () => {
    const { id } = await approvedTemplate(c, 'edit_category');
    const owner = await fx.ctx(c, c.owner);
    await expectAppError(
      templates.editTemplate(owner, id, { definition: { ...delayed, category: 'MARKETING' } }),
      'validation_failed',
      /category cannot change/,
    );
    await expectAppError(
      templates.editTemplate(owner, id, { definition: shipped }),
      'precondition_failed',
      /content Meta already has/,
    );
    expect((await templateRow(id)).edit_state).toBeNull();
  });

  it('lists where it is used and refuses while a campaign using it is sending', async () => {
    const { id } = await approvedTemplate(c, 'edit_in_use');
    const owner = await fx.ctx(c, c.owner);
    const draftCampaign = uuidv7();
    await fx.query(
      `INSERT INTO app.campaigns (id, tenant_id, name, status, template_id, timezone)
       VALUES ($1, $2, 'Diwali draft', 'draft', $3, 'Asia/Kolkata')`,
      [draftCampaign, c.tenant.id, id],
    );
    const [membership] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.owner.id],
    );
    const automation = uuidv7();
    const version = uuidv7();
    const graph = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'send_template', templateId: id }],
    };
    await fx.query(
      `INSERT INTO app.automations (id, tenant_id, name, draft_trigger, draft_graph,
              draft_updated_by_membership_id, created_by_membership_id)
       VALUES ($1, $2, 'Order follow-up', '{}', $3, $4, $4)`,
      [automation, c.tenant.id, JSON.stringify(graph), membership!.id],
    );
    await fx.query(
      `INSERT INTO app.automation_versions (id, tenant_id, automation_id, kind, number, trigger,
              graph, definition_sha256, created_by_membership_id)
       VALUES ($1, $2, $3, 'published', 1, '{}', $4, $5, $6)`,
      [version, c.tenant.id, automation, JSON.stringify(graph), 'a'.repeat(64), membership!.id],
    );
    await fx.query(
      `UPDATE app.automations SET status = 'active', active_version_id = $1 WHERE id = $2`,
      [version, automation],
    );

    const usage = await templates.templateUsage(owner, id);
    expect(usage.campaigns).toEqual([{ id: draftCampaign, name: 'Diwali draft', status: 'draft' }]);
    expect(usage.automations).toEqual([
      { id: automation, name: 'Order follow-up', status: 'active' },
    ]);
    expect(usage.storeRules).toEqual([]);

    const running = uuidv7();
    await fx.query(
      `INSERT INTO app.campaigns (id, tenant_id, name, status, channel_account_id, template_id,
              audience_used, timezone)
       VALUES ($1, $2, 'Diwali now', 'running', $3, $4, '{}', 'Asia/Kolkata')`,
      [running, c.tenant.id, c.channelAccountId, id],
    );
    await expectAppError(
      templates.editTemplate(owner, id, { definition: delayed }),
      'precondition_failed',
      /campaign using this template is sending/,
    );
    expect((await templateRow(id)).edit_state).toBeNull();
    // A campaign about to start is waited for in the same way.
    await fx.query(`UPDATE app.campaigns SET status = 'scheduled' WHERE id = $1`, [running]);
    await expectAppError(
      templates.editTemplate(owner, id, { definition: delayed }),
      'precondition_failed',
      /scheduled or sending/,
    );
    await fx.query(`UPDATE app.campaigns SET status = 'paused' WHERE id = $1`, [running]);
    // A change of variables is refused while anything sends it, naming what does.
    const extraVariable: TemplateDefinition = {
      ...delayed,
      body: {
        text: 'Hi {{1}}, your order {{2}} arrives {{3}}.',
        examples: ['Asha', 'A-1001', 'today'],
      },
    };
    await expectAppError(
      templates.editTemplate(owner, id, { definition: extraVariable }),
      'precondition_failed',
      /variables or buttons, which campaign “Diwali draft”, campaign “Diwali now”, automation “Order follow-up” rely on/,
    );
    // Wording alone is allowed.
    await templates.editTemplate(owner, id, { definition: delayed });
    expect((await templateRow(id)).edit_state).toBe('sending');
  });

  it('refuses a draft Meta does not have', async () => {
    const owner = await fx.ctx(c, c.owner);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'edit_draft_only',
      language: 'en',
      definition: shipped,
    });
    await expectAppError(
      templates.editTemplate(owner, id, { definition: delayed }),
      'precondition_failed',
      /Meta does not have this template yet/,
    );
  });
});

describe('who may edit a template Meta has', () => {
  it('does not find another company’s template', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const { id } = await approvedTemplate(a, 'edit_other_company');
    const otherOwner = await fx.ctx(b, b.owner);
    await expectAppError(
      templates.editTemplate(otherOwner, id, { definition: delayed }),
      'not_found',
    );
    await expectAppError(templates.templateUsage(otherOwner, id), 'not_found');
    // Nor does the worker, in the other company's scope.
    expect(await processTemplateEdit(workerDeps(), scopeOf(b), templateEditRef(id, uuidv7()))).toBe(
      'skipped',
    );
    expect((await templateRow(id)).edit_state).toBeNull();
  });

  it('refuses a member who may not submit templates', async () => {
    const c = await fx.company();
    const { id } = await approvedTemplate(c, 'edit_agent');
    const agent = await fx.ctx(c, c.agent);
    await expectAppError(templates.editTemplate(agent, id, { definition: delayed }), 'forbidden');
    await expectAppError(templates.templateUsage(agent, id), 'forbidden');
    expect((await templateRow(id)).edit_state).toBeNull();
    // A marketer submits templates, so may edit one.
    const marketer = await fx.ctx(c, c.marketer);
    await templates.editTemplate(marketer, id, { definition: delayed });
    expect(await templateRow(id)).toMatchObject({
      edit_state: 'sending',
      edit_requested_by_user_id: c.marketer.id,
    });
  });
});

describe('an edit’s one attempt and its window (ADR-404 review)', () => {
  let c: Company;
  beforeAll(async () => {
    c = await fx.company();
  });

  it('never sends an edit twice: a run after an attempt asks for a sync, which confirms it', async () => {
    const { id, hsmId } = await approvedTemplate(c, 'edit_attempt_once');
    const owner = await fx.ctx(c, c.owner);
    await templates.editTemplate(owner, id, { definition: delayed });
    const ref = await editRef(id);
    // Meta applies the edit but the answer is lost; the job's attempt was committed first.
    fx.standIn.state.templateEditQueue = [{ kind: 'apply_then_drop' }];
    expect(await processTemplateEdit(workerDeps(), scopeOf(c), ref)).toBe('done');
    const [attempt] = await fx.query<{ attempted: boolean }>(
      'SELECT edit_attempted_at IS NOT NULL AS attempted FROM app.message_templates WHERE id = $1',
      [id],
    );
    expect(attempt?.attempted).toBe(true);
    // The same job again (a retry, or an expired job): nothing is posted, a sync is asked for.
    fx.standIn.state.templateEditQueue = [
      { kind: 'error', status: 400, code: 2388299, message: 'Edit limit reached' },
    ];
    expect(await processTemplateEdit(workerDeps(), scopeOf(c), ref)).toBe('done');
    expect(editsTo(hsmId).length).toBe(1);
    expect((await templateRow(id)).edit_state).toBe('sending');
    // The sync finds Meta's content and makes the edit; the queued refusal was never used.
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect(await templateRow(id)).toMatchObject({
      components: toMetaComponents(delayed),
      edit_state: null,
    });
    fx.standIn.state.templateEditQueue = [];
  });

  it('does nothing for a job of an older edit', async () => {
    const { id, hsmId } = await approvedTemplate(c, 'edit_stale_job');
    const owner = await fx.ctx(c, c.owner);
    await templates.editTemplate(owner, id, { definition: delayed });
    const oldRef = await editRef(id);
    fx.standIn.state.templateEditQueue = [{ kind: 'drop_connection' }];
    expect(await processTemplateEdit(workerDeps(), scopeOf(c), oldRef)).toBe('done');
    await ageEdit(id);
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect((await templateRow(id)).edit_state).toBe('failed');
    // The member sends a newer edit; the older job (retried late) leaves it alone.
    await templates.editTemplate(owner, id, { definition: delayed });
    const newRef = await editRef(id);
    expect(newRef).not.toBe(oldRef);
    const posts = editsTo(hsmId).length;
    expect(await processTemplateEdit(workerDeps(), scopeOf(c), oldRef)).toBe('skipped');
    expect(editsTo(hsmId).length).toBe(posts);
    expect((await templateRow(id)).edit_state).toBe('sending');
  });

  it('does not send an edit whose window has run out, and settles it as not sent', async () => {
    const { id, hsmId } = await approvedTemplate(c, 'edit_too_late');
    const owner = await fx.ctx(c, c.owner);
    await templates.editTemplate(owner, id, { definition: delayed });
    // Nine and a half minutes old on the database's clock: less than the minute's margin left.
    await fx.query(
      `UPDATE app.message_templates SET edit_requested_at = now() - interval '570 seconds'
        WHERE id = $1`,
      [id],
    );
    expect(await runEdit(c, id)).toBe('done');
    expect(editsTo(hsmId).length).toBe(0);
    const row = await templateRow(id);
    expect(row.edit_state).toBe('failed');
    expect(row.edit_error).toMatch(/could not send the edit to Meta within 10 minutes/);
  });

  it('confirms a failed edit once Meta’s template shows it, so it is not stuck as failed', async () => {
    const { id, remote } = await approvedTemplate(c, 'edit_applied_late');
    const owner = await fx.ctx(c, c.owner);
    await templates.editTemplate(owner, id, { definition: delayed });
    fx.standIn.state.templateEditQueue = [{ kind: 'drop_connection' }];
    expect(await runEdit(c, id)).toBe('done');
    await ageEdit(id);
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect((await templateRow(id)).edit_state).toBe('failed');
    // Meta applies it after the window.
    remote.components = toMetaComponents(delayed);
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect(await templateRow(id)).toMatchObject({
      components: toMetaComponents(delayed),
      edit_state: null,
      edit_error: null,
    });
    expect((await history(id)).at(-1)).toMatchObject({
      status: 'edited',
      source: 'sync',
      actor_user_id: c.owner.id,
    });
  });

  it('gives the runtime role alone the edit columns, and the definer only edit_state to read (migration 0316)', async () => {
    const rows = await fx.query<{
      c: string;
      app_update: boolean;
      definer_select: boolean;
      definer_update: boolean;
      public_update: boolean;
    }>(
      `SELECT c,
              has_column_privilege('w360_app', 'app.message_templates', c, 'UPDATE') AS app_update,
              has_column_privilege('w360_definer', 'app.message_templates', c, 'SELECT')
                AS definer_select,
              has_column_privilege('w360_definer', 'app.message_templates', c, 'UPDATE')
                AS definer_update,
              has_column_privilege('public', 'app.message_templates', c, 'UPDATE') AS public_update
         FROM (VALUES ('edit_id'), ('edit_state'), ('edit_components'), ('edit_error'),
                      ('edit_requested_at'), ('edit_requested_by_user_id'), ('edit_attempted_at')) AS v(c)
        ORDER BY c`,
    );
    expect(rows).toEqual(
      [
        'edit_attempted_at',
        'edit_components',
        'edit_error',
        'edit_id',
        'edit_requested_at',
        'edit_requested_by_user_id',
        'edit_state',
      ].map((c) => ({
        c,
        app_update: true,
        definer_select: c === 'edit_state',
        definer_update: false,
        public_update: false,
      })),
    );
  });
});
