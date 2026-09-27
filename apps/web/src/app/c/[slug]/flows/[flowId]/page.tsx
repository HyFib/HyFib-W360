import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can, flowHealthSummary } from '@w360/domain';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import type { FlowLifecycleAction } from '@/app/actions/flows';
import { FlowKeyButtons, FlowLifecycleButtons } from '@/components/flows/flow-actions';
import { FlowDraftForm } from '@/components/flows/flow-draft-form';
import { FlowSettingsForm } from '@/components/flows/flow-settings-form';
import { PageHeader } from '@/components/page-header';
import {
  ANSWER_OUTCOME,
  FLOW_CATEGORY_LABELS,
  FLOW_STATUS,
  FLOW_SYNC_OP,
  KEY_UPLOAD_ERRORS,
  flowAnswerText,
} from '@/lib/flow-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Flow' };
export const dynamic = 'force-dynamic';

const TARGET_LABEL = (target: string, fields: Map<string, string>) =>
  target === 'name'
    ? 'the contact’s name'
    : target === 'email'
      ? 'the contact’s email'
      : `“${fields.get(target.slice(6)) ?? target.slice(6)}”`;

export default async function FlowPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; flowId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { slug, flowId } = await params;
  const { before } = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'flows.read')) notFound();
  const { flows, contacts, webRequests } = await getRuntime();
  let detail: Awaited<ReturnType<typeof flows.get>>;
  try {
    detail = await flows.get(ctx, flowId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { flow, counts, canEdit, canPublish } = detail;
  const usesEndpoint = flow.dataApiVersion !== null;
  const [accounts, answered, keys, fieldRows, requestSettings] = await Promise.all([
    flows.accounts(ctx),
    flows.responses(ctx, flow.id, before ? { before } : {}),
    usesEndpoint ? flows.keyStatus(ctx, flow.whatsappAccountId) : Promise.resolve(null),
    can(ctx, 'contacts.read') ? contacts.listFields(ctx) : Promise.resolve([]),
    canEdit && usesEndpoint && (can(ctx, 'automations.read') || can(ctx, 'integrations.read'))
      ? webRequests.settings(ctx)
      : Promise.resolve(null),
  ]);
  const base = `/c/${ctx.tenant.slug}/flows`;
  const tz = ctx.tenant.timezone;
  const now = new Date();
  const account = accounts.find((a) => a.id === flow.whatsappAccountId);
  const fieldLabels = new Map(fieldRows.map((f) => [f.key, f.label]));
  const status = flow.metaStatus ? FLOW_STATUS[flow.metaStatus] : undefined;
  const busy = flow.syncState === 'queued' || flow.syncState === 'running';
  const failed = flow.syncState === 'failed';
  const draft = flow.metaStatus === null || flow.metaStatus === 'DRAFT';
  const archived = flow.archivedAt !== null;
  const failedDelete = failed && flow.syncOp === 'delete';
  const health = flowHealthSummary(flow.health);
  const preview =
    flow.previewUrl && flow.previewExpiresAt && flow.previewExpiresAt > now
      ? { url: flow.previewUrl, expiresAt: flow.previewExpiresAt.toISOString() }
      : null;

  // What the member may do now (the service checks each again).
  const actions: FlowLifecycleAction[] = [];
  if (archived) {
    if (canEdit) actions.push('restore');
  } else if (!busy) {
    const publishOp = flow.syncOp === 'publish' || flow.syncOp === 'deprecate';
    if (failed && canEdit && (!publishOp || canPublish)) actions.push('retry');
    if (
      canPublish &&
      flow.metaStatus === 'DRAFT' &&
      !flow.unsentChanges &&
      flow.validationErrors.length === 0
    ) {
      actions.push('publish');
    }
    if (
      canPublish &&
      (flow.metaStatus === 'PUBLISHED' ||
        flow.metaStatus === 'BLOCKED' ||
        flow.metaStatus === 'THROTTLED')
    ) {
      actions.push('deprecate');
    }
    if (canEdit && flow.metaFlowId && !failedDelete) actions.push('refresh');
    if (canEdit && draft && !failedDelete) actions.push('remove');
    if (canEdit && (flow.metaStatus === 'DEPRECATED' || failedDelete)) actions.push('archive');
  }
  const canDuplicate = canEdit && !archived && !draft;
  const editable = canEdit && draft && !archived;

  return (
    <>
      <Link
        href={base}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Flows
      </Link>
      <PageHeader
        title={flow.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {status ? (
              <Badge tone={status.tone}>{status.label}</Badge>
            ) : (
              <Badge tone="neutral">Not at Meta yet</Badge>
            )}
            {archived ? <Badge tone="neutral">Archived</Badge> : null}
            <span>
              {account?.name ?? 'WhatsApp account'} ·{' '}
              {flow.categories.map((c) => FLOW_CATEGORY_LABELS[c] ?? c).join(', ')}
            </span>
          </span>
        }
      />
      <div className="grid grid-cols-1 gap-6">
        {busy && flow.syncOp ? (
          <Alert tone="info" title={`${FLOW_SYNC_OP[flow.syncOp] ?? flow.syncOp}…`}>
            HyFib is working on this with Meta
            {flow.syncRequestedAt
              ? ` (requested ${formatDateTime(flow.syncRequestedAt.toISOString(), tz)})`
              : ''}
            . Reload the page to see the result.
          </Alert>
        ) : null}
        {failed && flow.syncOp ? (
          <Alert tone="danger" title={`${FLOW_SYNC_OP[flow.syncOp] ?? flow.syncOp} failed`}>
            {flow.syncError ?? 'Meta did not complete the request.'}
          </Alert>
        ) : null}
        {flow.validationErrors.length > 0 ? (
          <Alert tone="warning" title="Meta found problems in the Flow JSON">
            <ul className="mt-1 grid gap-1">
              {flow.validationErrors.map((e, i) => (
                <li key={`${e.error}-${i}`}>
                  {e.message}
                  {e.lineStart !== null
                    ? ` (line ${e.lineStart}${e.columnStart !== null ? `, column ${e.columnStart}` : ''})`
                    : ''}
                  {e.errorType ? (
                    <span className="text-xs text-muted-foreground"> · {e.errorType}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Fix them in the draft and save: it cannot be published until Meta accepts it.
            </p>
          </Alert>
        ) : null}
        {health.problems.length > 0 ? (
          <Alert tone="warning" title="Meta reports a problem with sending this flow">
            <ul className="mt-1 grid gap-1">
              {health.problems.map((p, i) => (
                <li key={`${p.entity}-${i}`}>
                  {p.description}
                  {p.solution ? (
                    <span className="block text-xs text-muted-foreground">{p.solution}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>
              {flow.syncedAt
                ? `Last checked with Meta ${formatDateTime(flow.syncedAt.toISOString(), tz)}.`
                : 'Meta has not confirmed this flow yet.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Flow JSON version</dt>
                <dd>
                  {flow.jsonVersion}
                  {flow.dataApiVersion ? ` · data API ${flow.dataApiVersion}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">First screen</dt>
                <dd className="font-mono text-xs">{flow.firstScreen}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sent · completed · answers kept</dt>
                <dd>
                  {counts.sends} · {counts.completed} · {counts.responses}
                </dd>
              </div>
              {health.canSendMessage ? (
                <div>
                  <dt className="text-muted-foreground">Meta’s sending status</dt>
                  <dd>{health.canSendMessage}</dd>
                </div>
              ) : null}
              {flow.metaFlowId ? (
                <div>
                  <dt className="text-muted-foreground">Meta flow id</dt>
                  <dd className="font-mono text-xs">{flow.metaFlowId}</dd>
                </div>
              ) : null}
              {flow.derivedFromFlowId ? (
                <div>
                  <dt className="text-muted-foreground">Made from</dt>
                  <dd>
                    <Link
                      href={`${base}/${flow.derivedFromFlowId}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      The flow it was copied from
                    </Link>
                  </dd>
                </div>
              ) : null}
            </dl>
            {preview ? (
              <p className="text-sm">
                <a
                  href={preview.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Open Meta’s preview
                </a>{' '}
                <span className="text-muted-foreground">
                  (the link works until {formatDateTime(preview.expiresAt, tz)}; refresh from Meta
                  for a new one)
                </span>
              </p>
            ) : null}
            {actions.length > 0 || canDuplicate ? (
              <FlowLifecycleButtons
                slug={ctx.tenant.slug}
                flowId={flow.id}
                version={flow.version}
                actions={actions}
                canDuplicate={canDuplicate}
              />
            ) : null}
            {draft && !archived && canEdit && !canPublish ? (
              <p className="text-sm text-muted-foreground">
                Publishing is final at Meta, so it needs an owner or administrator.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {editable ? (
          <Card>
            <CardHeader>
              <CardTitle>Draft</CardTitle>
              <CardDescription>
                Saving sends the draft to Meta, which checks it again. Test it by sending the draft
                to your own number from a conversation before publishing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FlowDraftForm
                slug={ctx.tenant.slug}
                draft={{
                  id: flow.id,
                  version: flow.version,
                  name: flow.name,
                  categories: flow.categories,
                  json: flow.flowJson,
                }}
                locked={
                  busy ? 'Meta is still processing the last change: reload to save again.' : null
                }
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Flow JSON</CardTitle>
              <CardDescription>
                {draft
                  ? 'Only members who edit flows can change the draft.'
                  : 'A published flow cannot change. Make a new draft from it to change the form.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                {flow.flowJson}
              </pre>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Answers{usesEndpoint ? ' and your endpoint' : ''}</CardTitle>
            <CardDescription>
              HyFib settings: they can change at any time, also after publishing. Answers are always
              kept with the completed form; saving them on the contact is optional.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canEdit ? (
              <FlowSettingsForm
                slug={ctx.tenant.slug}
                flow={{
                  id: flow.id,
                  version: flow.version,
                  answerKeys: flow.answerKeys,
                  mapping: flow.answerMapping,
                  usesEndpoint,
                  endpointUrl: flow.endpointUrl,
                  endpointSecretName: flow.endpointSecretName,
                }}
                fields={fieldRows.map((f) => ({ key: f.key, label: f.label }))}
                secrets={(requestSettings?.secrets ?? []).map((s) => ({
                  name: s.name,
                  domain: s.domain,
                }))}
                canEdit={canEdit}
              />
            ) : (
              <dl className="grid gap-2 text-sm">
                {flow.answerMapping.length === 0 ? (
                  <p className="text-muted-foreground">Answers are not saved on the contact.</p>
                ) : (
                  flow.answerMapping.map((m) => (
                    <div key={m.key}>
                      <dt className="inline font-medium">“{m.key}”</dt>
                      <dd className="inline"> is saved as {TARGET_LABEL(m.target, fieldLabels)}</dd>
                    </div>
                  ))
                )}
                {usesEndpoint ? (
                  <div>
                    <dt className="inline font-medium">Your endpoint: </dt>
                    <dd className="inline">
                      {flow.endpointUrl ? new URL(flow.endpointUrl).host : 'not set'}
                    </dd>
                  </div>
                ) : null}
              </dl>
            )}
          </CardContent>
        </Card>

        {usesEndpoint && keys ? (
          <Card>
            <CardHeader>
              <CardTitle>Data endpoint and encryption</CardTitle>
              <CardDescription>
                While the form is open, WhatsApp sends encrypted requests to HyFib at the address
                below. HyFib checks Meta’s signature, decrypts them with the WhatsApp account’s key,
                and forwards them to your endpoint. The key is one per WhatsApp account and must be
                uploaded to each of its numbers.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {flow.endpointAddress ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">HyFib’s address for this flow: </span>
                  <code className="break-all font-mono text-xs">{flow.endpointAddress}</code>
                </p>
              ) : null}
              <p className="text-sm">
                {keys.active
                  ? `Key ${keys.active.fingerprint.slice(0, 16)}… created ${formatDateTime(keys.active.createdAt, tz)}.`
                  : 'No key yet: set up encryption before publishing.'}
                {keys.previous
                  ? ' The previous key still opens requests for up to 24 hours after it was replaced.'
                  : ''}
              </p>
              {keys.numbers.length === 0 ? (
                <p className="text-sm text-muted-foreground">This account has no numbers yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Number</TH>
                      <TH>Key at Meta</TH>
                      <TH>Checked</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {keys.numbers.map((n) => (
                      <TR key={n.id}>
                        <TD className="text-sm">
                          {n.name}
                          {n.active ? null : (
                            <span className="block text-xs text-muted-foreground">not active</span>
                          )}
                        </TD>
                        <TD className="text-sm">
                          {!keys.active || n.uploadState === null ? (
                            'Not uploaded'
                          ) : n.uploadState === 'pending' ? (
                            'Uploading…'
                          ) : n.uploadState === 'failed' ? (
                            <span className="text-destructive">
                              Failed
                              {n.errorCode
                                ? `: ${KEY_UPLOAD_ERRORS[n.errorCode] ?? n.errorCode}`
                                : ''}
                            </span>
                          ) : n.signatureStatus === 'VALID' ? (
                            'Uploaded, signature valid'
                          ) : n.signatureStatus === 'MISMATCH' ? (
                            <span className="text-destructive">
                              Uploaded, but Meta reports a signature mismatch
                            </span>
                          ) : (
                            'Uploaded'
                          )}
                        </TD>
                        <TD className="text-sm text-muted-foreground">
                          {n.checkedAt ? formatDateTime(n.checkedAt, tz) : '—'}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
              {canEdit && account?.connected ? (
                <FlowKeyButtons
                  slug={ctx.tenant.slug}
                  whatsappAccountId={flow.whatsappAccountId}
                  hasKey={keys.active !== null}
                  canRotate={canPublish}
                />
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Completed forms</CardTitle>
            <CardDescription>
              {answered.withAnswers
                ? 'Newest first. Erasing a contact deletes their answers.'
                : 'Newest first. Answers and contact names are shown to members who can see contacts.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {answered.responses.length === 0 ? (
              <p className="p-6 pt-0 text-sm text-muted-foreground">
                {before ? 'No older forms.' : 'No completed forms yet.'}
              </p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Received</TH>
                    {answered.withAnswers ? <TH>Contact</TH> : null}
                    {answered.withAnswers ? <TH>Answers</TH> : null}
                    <TH>Saved on the contact</TH>
                  </TR>
                </THead>
                <TBody>
                  {answered.responses.map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-sm">
                        {formatDateTime(r.receivedAt, tz)}
                      </TD>
                      {answered.withAnswers ? (
                        <TD className="text-sm">
                          {r.conversationId ? (
                            <Link
                              href={`/c/${ctx.tenant.slug}/inbox/${r.conversationId}`}
                              className="text-primary underline-offset-4 hover:underline"
                            >
                              {r.contactName ?? 'Contact'}
                            </Link>
                          ) : (
                            (r.contactName ?? 'Contact')
                          )}
                        </TD>
                      ) : null}
                      {answered.withAnswers ? (
                        <TD className="text-sm">
                          <dl className="grid gap-0.5">
                            {Object.entries(r.answers ?? {}).map(([key, value]) => (
                              <div key={key}>
                                <dt className="inline text-muted-foreground">{key}: </dt>
                                <dd className="inline break-words">{flowAnswerText(value)}</dd>
                              </div>
                            ))}
                          </dl>
                        </TD>
                      ) : null}
                      <TD className="text-sm">
                        {r.applied.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="grid gap-0.5">
                            {r.applied.map((a) => (
                              <li key={`${a.key}-${a.target}`}>
                                {TARGET_LABEL(a.target, fieldLabels)}:{' '}
                                <span
                                  className={
                                    a.outcome === 'applied' ? undefined : 'text-muted-foreground'
                                  }
                                >
                                  {ANSWER_OUTCOME[a.outcome] ?? a.outcome}
                                </span>
                                {a.message ? (
                                  <span className="block text-xs text-muted-foreground">
                                    {a.message}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            {answered.older || before ? (
              <div className="flex gap-4 p-4 text-sm">
                {before ? (
                  <Link
                    href={`${base}/${flow.id}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Newest
                  </Link>
                ) : null}
                {answered.older ? (
                  <Link
                    href={`${base}/${flow.id}?before=${encodeURIComponent(answered.older)}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Older
                  </Link>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
