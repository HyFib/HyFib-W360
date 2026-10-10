import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  can,
  WEBHOOK_CAMPAIGN_STATUS_LABELS,
  WEBHOOK_CONTACT_PART_LABELS,
  WEBHOOK_CONVERSATION_STATUS_LABELS,
  WEBHOOK_EVENT_INFO,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_LIMITS,
  WEBHOOK_ORDER_STATUS_LABELS,
  WEBHOOK_ORDER_CHANGE_MAKER_LABELS,
  WEBHOOK_PAYMENT_LINK_STATUS_LABELS,
  WEBHOOK_COD_ANSWER_LABELS,
  WEBHOOK_ORDER_MESSAGE_EVENT_LABELS,
  WEBHOOK_RUN_STEP_OUTCOME_LABELS,
  WEBHOOK_RUN_STEP_NODE_TYPE_LABELS,
  WEBHOOK_DEAL_STATUS_LABELS,
  WEBHOOK_TASK_STATUS_LABELS,
  WEBHOOK_DEAL_DETAIL_LABELS,
  WEBHOOK_TASK_DETAIL_LABELS,
  WEBHOOK_RUN_END_STATUS_LABELS,
  WEBHOOK_RUN_TRIGGER_LABELS,
  WEBHOOK_CONSENT_CHANGE_LABELS,
  WEBHOOK_CONTACT_SOURCE_LABELS,
  WEBHOOK_RECEIVED_MESSAGE_TYPE_LABELS,
  WEBHOOK_RUN_END_REASON_LABELS,
  WEBHOOK_MESSAGE_SENDER_LABELS,
  WEBHOOK_CRM_CHANGE_MAKER_LABELS,
  WEBHOOK_SURVEY_SCORE_LABELS,
  WEBHOOK_MESSAGE_STATUS_LABELS,
  WEBHOOK_TEMPLATE_STATUS_LABELS,
  webhookAssigneeText,
  webhookCampaignText,
  webhookChannelText,
  webhookContactEventFieldValuesText,
  webhookFieldText,
  webhookOAuthText,
  webhookHost,
  webhookMessageWordsText,
  webhookOwnerText,
  webhookPipelineText,
  webhookApiKeyText,
  webhookStageText,
  webhookStoreText,
  webhookTeamText,
  webhookTemplateText,
  type WebhookEndpointView,
} from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  ReplayFailedDeliveriesForm,
  WebhookEndpointActions,
  WebhookEndpointForm,
} from '@/components/settings/webhooks';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Webhooks' };
export const dynamic = 'force-dynamic';

function stateBadge(endpoint: WebhookEndpointView) {
  if (endpoint.state === 'active') return <Badge tone="success">On</Badge>;
  return endpoint.disabledReason === 'failing' ? (
    <Badge tone="danger">Turned off: failing</Badge>
  ) : (
    <Badge tone="neutral">Off</Badge>
  );
}

export default async function WebhooksPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'developer.manage')) notFound();
  const { webhooks } = await getRuntime();
  const [
    endpoints,
    automationChoices,
    runApiKeyChoices,
    messageApiKeyChoices,
    crmApiKeyChoices,
    orderApiKeyChoices,
    paymentLinkApiKeyChoices,
    channelChoices,
    teamChoices,
    templateChoices,
    campaignChoices,
    storeChoices,
    pipelineChoices,
    stageChoices,
    ownerChoices,
    assigneeChoices,
    contactFieldChoices,
  ] = await Promise.all([
    webhooks.list(ctx),
    webhooks.automationChoices(ctx),
    webhooks.runApiKeyChoices(ctx),
    webhooks.messageApiKeyChoices(ctx),
    webhooks.crmApiKeyChoices(ctx),
    webhooks.orderApiKeyChoices(ctx),
    webhooks.paymentLinkApiKeyChoices(ctx),
    webhooks.channelChoices(ctx),
    webhooks.teamChoices(ctx),
    webhooks.templateChoices(ctx),
    webhooks.campaignChoices(ctx),
    webhooks.storeChoices(ctx),
    webhooks.pipelineChoices(ctx),
    webhooks.stageChoices(ctx),
    webhooks.ownerChoices(ctx),
    webhooks.assigneeChoices(ctx),
    webhooks.contactFieldChoices(ctx),
  ]);
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/settings/webhooks`;
  // The fields' labels, for the field values endpoints name (ADR-332).
  const fieldLabels = new Map(contactFieldChoices.map((f) => [f.key, f.label]));
  // A replay of every endpoint (ADR-160) offers the events the endpoints that are on receive.
  const on = endpoints.filter((e) => e.state === 'active');
  const onEvents = WEBHOOK_EVENT_KEYS.filter((t) => on.some((e) => e.eventTypes.includes(t)));
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
          <CardDescription>
            Your systems can receive what happens in HyFib W360 as it happens: messages and their
            status, consent changes, template status, conversations resolved, reopened or assigned,
            contacts added, changed or erased, automations starting and ending, orders customers
            send from your WhatsApp catalog and their status, campaigns changing status, CRM deals
            added, moved, won, lost or reopened, and CRM tasks added, completed, cancelled or
            reopened. Each event is a signed JSON POST to your endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p>
            Check the <code className="font-mono text-xs">W360-Signature</code> header before
            trusting a request: it holds the time and an HMAC-SHA256 of{' '}
            <code className="font-mono text-xs">&lt;time&gt;.&lt;body&gt;</code> made with the
            endpoint’s secret. Answer with a 2xx status within 10 seconds; anything else is retried
            up to {WEBHOOK_LIMITS.attempts} times over about two days.
          </p>
          <p>
            An event can arrive more than once and out of order: use its id to ignore repeats. The
            bodies are described in the{' '}
            <Link
              className="font-medium underline underline-offset-4"
              href="/developers#webhook-events"
            >
              API reference
            </Link>{' '}
            and in the{' '}
            <a
              className="font-medium underline underline-offset-4"
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI document
            </a>{' '}
            under <code className="font-mono text-xs">webhooks</code>. Deliveries are kept{' '}
            {WEBHOOK_LIMITS.retentionDays} days.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
          <CardDescription>
            {endpoints.length} of {WEBHOOK_LIMITS.endpoints} endpoints. An endpoint that fails every
            delivery for {WEBHOOK_LIMITS.disableAfterHours} hours is turned off, and owners and
            administrators are emailed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {endpoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">No endpoints yet.</p>
          ) : (
            <ul className="grid gap-3" aria-label="Endpoints">
              {endpoints.map((e) => {
                const host = webhookHost(e.url) ?? e.url;
                return (
                  <li key={e.id} className="grid gap-2 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{host}</span>
                      {stateBadge(e)}
                    </div>
                    <p className="font-mono text-xs break-all">{e.url}</p>
                    {e.description ? <p className="text-sm">{e.description}</p> : null}
                    {e.messageStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Message statuses sent:{' '}
                        {e.messageStatuses.map((s) => WEBHOOK_MESSAGE_STATUS_LABELS[s]).join(', ')}
                      </p>
                    ) : null}
                    {e.messageSenders ? (
                      <p className="text-xs text-muted-foreground">
                        Statuses of messages sent by:{' '}
                        {e.messageSenders.map((s) => WEBHOOK_MESSAGE_SENDER_LABELS[s]).join(', ')}
                      </p>
                    ) : null}
                    {e.messageApiKeys ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Statuses of messages sent through the API by:{' '}
                        {e.messageApiKeys.map(webhookApiKeyText).join(', ')}
                      </p>
                    ) : null}
                    {e.templateStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Template statuses sent:{' '}
                        {e.templateStatuses
                          .map((t) => WEBHOOK_TEMPLATE_STATUS_LABELS[t])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.conversationStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Conversation statuses sent:{' '}
                        {e.conversationStatuses
                          .map((s) => WEBHOOK_CONVERSATION_STATUS_LABELS[s])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.contactParts ? (
                      <p className="text-xs text-muted-foreground">
                        Contact changes sent:{' '}
                        {e.contactParts.map((p) => WEBHOOK_CONTACT_PART_LABELS[p]).join(', ')}
                      </p>
                    ) : null}
                    {e.contactFields ? (
                      <p className="text-xs text-muted-foreground">
                        Custom fields whose changes are sent:{' '}
                        {e.contactFields.map(webhookFieldText).join(', ')}
                      </p>
                    ) : null}
                    {e.orderStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Order statuses sent:{' '}
                        {e.orderStatuses.map((o) => WEBHOOK_ORDER_STATUS_LABELS[o]).join(', ')}
                      </p>
                    ) : null}
                    {e.orderChangeMakers ? (
                      <p className="text-xs text-muted-foreground">
                        Order changes sent, made by:{' '}
                        {e.orderChangeMakers
                          .map((m) => WEBHOOK_ORDER_CHANGE_MAKER_LABELS[m])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.orderExcludedApiKeys ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Order changes left out, made through the API by:{' '}
                        {e.orderExcludedApiKeys.map(webhookApiKeyText).join(', ')}
                      </p>
                    ) : null}
                    {e.paymentLinkApiKeys ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Payment Links sent, asked for through the API by:{' '}
                        {e.paymentLinkApiKeys.map(webhookApiKeyText).join(', ')}
                      </p>
                    ) : null}
                    {e.paymentLinkStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Payment Link statuses sent:{' '}
                        {e.paymentLinkStatuses
                          .map((s) => WEBHOOK_PAYMENT_LINK_STATUS_LABELS[s])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.codAnswers ? (
                      <p className="text-xs text-muted-foreground">
                        Cash on delivery answers sent:{' '}
                        {e.codAnswers.map((a) => WEBHOOK_COD_ANSWER_LABELS[a]).join(', ')}
                      </p>
                    ) : null}
                    {e.stores ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Stores whose cash on delivery answers, order messages and cart reminders are
                        sent: {e.stores.map(webhookStoreText).join(', ')}
                      </p>
                    ) : null}
                    {e.orderMessageEvents ? (
                      <p className="text-xs text-muted-foreground">
                        Order messages whose events are sent:{' '}
                        {e.orderMessageEvents
                          .map((m) => WEBHOOK_ORDER_MESSAGE_EVENT_LABELS[m])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.orderMessageSkipReasons ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Skip reasons sent:{' '}
                        <span className="font-mono">{e.orderMessageSkipReasons.join(', ')}</span>
                      </p>
                    ) : null}
                    {e.runStepOutcomes ? (
                      <p className="text-xs text-muted-foreground">
                        Automation steps sent:{' '}
                        {e.runStepOutcomes
                          .map((o) => WEBHOOK_RUN_STEP_OUTCOME_LABELS[o])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.runStepNodeTypes ? (
                      <p className="text-xs text-muted-foreground">
                        Kinds of automation step sent:{' '}
                        {e.runStepNodeTypes
                          .map((t) => WEBHOOK_RUN_STEP_NODE_TYPE_LABELS[t])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.dealStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Deal statuses sent:{' '}
                        {e.dealStatuses.map((s) => WEBHOOK_DEAL_STATUS_LABELS[s]).join(', ')}
                      </p>
                    ) : null}
                    {e.taskStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Task statuses sent:{' '}
                        {e.taskStatuses.map((s) => WEBHOOK_TASK_STATUS_LABELS[s]).join(', ')}
                      </p>
                    ) : null}
                    {e.dealDetails ? (
                      <p className="text-xs text-muted-foreground">
                        Deal details whose changes are sent:{' '}
                        {e.dealDetails.map((d) => WEBHOOK_DEAL_DETAIL_LABELS[d]).join(', ')}
                      </p>
                    ) : null}
                    {e.taskDetails ? (
                      <p className="text-xs text-muted-foreground">
                        Task details whose changes are sent:{' '}
                        {e.taskDetails.map((d) => WEBHOOK_TASK_DETAIL_LABELS[d]).join(', ')}
                      </p>
                    ) : null}
                    {e.campaignStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Campaign statuses sent:{' '}
                        {e.campaignStatuses
                          .map((c) => WEBHOOK_CAMPAIGN_STATUS_LABELS[c])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.automations ? (
                      <p className="text-xs text-muted-foreground">
                        Automation runs sent:{' '}
                        {e.automations
                          .map((a) => (a.archived ? `${a.name} (archived)` : a.name))
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.runEndStatuses ? (
                      <p className="text-xs text-muted-foreground">
                        Automation ends sent:{' '}
                        {e.runEndStatuses.map((s) => WEBHOOK_RUN_END_STATUS_LABELS[s]).join(', ')}
                      </p>
                    ) : null}
                    {e.runTriggers ? (
                      <p className="text-xs text-muted-foreground">
                        Automation runs started by:{' '}
                        {e.runTriggers.map((t) => WEBHOOK_RUN_TRIGGER_LABELS[t]).join(', ')}
                      </p>
                    ) : null}
                    {e.runApiKeys ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Automation runs sent, started through the API by:{' '}
                        {e.runApiKeys.map(webhookApiKeyText).join(', ')}
                      </p>
                    ) : null}
                    {e.consentChanges ? (
                      <p className="text-xs text-muted-foreground">
                        Consent changes sent:{' '}
                        {e.consentChanges.map((c) => WEBHOOK_CONSENT_CHANGE_LABELS[c]).join(', ')}
                      </p>
                    ) : null}
                    {e.contactSources ? (
                      <p className="text-xs text-muted-foreground">
                        New contacts sent:{' '}
                        {e.contactSources.map((c) => WEBHOOK_CONTACT_SOURCE_LABELS[c]).join(', ')}
                      </p>
                    ) : null}
                    {e.messageTypes ? (
                      <p className="text-xs text-muted-foreground">
                        Received messages sent:{' '}
                        {e.messageTypes
                          .map((t) => WEBHOOK_RECEIVED_MESSAGE_TYPE_LABELS[t])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.messageWords ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Received messages sent, containing:{' '}
                        {webhookMessageWordsText(e.messageWords)}
                      </p>
                    ) : null}
                    {e.runEndReasons ? (
                      <p className="text-xs text-muted-foreground">
                        Automation ends narrowed to:{' '}
                        {e.runEndReasons.map((r) => WEBHOOK_RUN_END_REASON_LABELS[r]).join(', ')}
                      </p>
                    ) : null}
                    {e.channels ? (
                      <p className="text-xs text-muted-foreground">
                        Numbers whose events are sent:{' '}
                        {e.channels.map(webhookChannelText).join(', ')}
                      </p>
                    ) : null}
                    {e.templates ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Templates whose statuses and changes are sent:{' '}
                        {e.templates.map(webhookTemplateText).join(', ')}
                      </p>
                    ) : null}
                    {e.campaigns ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Campaigns whose statuses and changes are sent:{' '}
                        {e.campaigns.map(webhookCampaignText).join(', ')}
                      </p>
                    ) : null}
                    {e.pipelines ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Pipelines whose deals’ events are sent:{' '}
                        {e.pipelines.map(webhookPipelineText).join(', ')}
                      </p>
                    ) : null}
                    {e.stages ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Stages whose deals’ events are sent:{' '}
                        {e.stages.map(webhookStageText).join(', ')}
                      </p>
                    ) : null}
                    {e.owners ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Members whose deals’ events are sent:{' '}
                        {e.owners.map(webhookOwnerText).join(', ')}
                      </p>
                    ) : null}
                    {e.taskAssignees ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Members whose tasks’ events are sent:{' '}
                        {e.taskAssignees.map(webhookOwnerText).join(', ')}
                      </p>
                    ) : null}
                    {e.taskPipelines ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Pipelines whose deals’ tasks’ events are sent:{' '}
                        {e.taskPipelines.map(webhookPipelineText).join(', ')}
                      </p>
                    ) : null}
                    {e.taskStages ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Stages whose deals’ tasks’ events are sent:{' '}
                        {e.taskStages.map(webhookStageText).join(', ')}
                      </p>
                    ) : null}
                    {e.taskDealOwners ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Members whose deals’ tasks’ events are sent:{' '}
                        {e.taskDealOwners.map(webhookOwnerText).join(', ')}
                      </p>
                    ) : null}
                    {e.notePipelines ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Pipelines whose deals’ notes’ events are sent:{' '}
                        {e.notePipelines.map(webhookPipelineText).join(', ')}
                      </p>
                    ) : null}
                    {e.noteStages ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Stages whose deals’ notes’ events are sent:{' '}
                        {e.noteStages.map(webhookStageText).join(', ')}
                      </p>
                    ) : null}
                    {e.noteDealOwners ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Members whose deals’ notes’ events are sent:{' '}
                        {e.noteDealOwners.map(webhookOwnerText).join(', ')}
                      </p>
                    ) : null}
                    {e.crmChangeMakers ? (
                      <p className="text-xs text-muted-foreground">
                        Deal, task and note changes sent, made by:{' '}
                        {e.crmChangeMakers
                          .map((m) => WEBHOOK_CRM_CHANGE_MAKER_LABELS[m])
                          .join(', ')}
                      </p>
                    ) : null}
                    {e.crmExcludedApiKeys ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Deal, task and note changes left out, made through the API by:{' '}
                        {e.crmExcludedApiKeys.map(webhookApiKeyText).join(', ')}
                      </p>
                    ) : null}
                    {e.surveyScores ? (
                      <p className="text-xs text-muted-foreground">
                        Survey answers sent:{' '}
                        {e.surveyScores.map((s) => WEBHOOK_SURVEY_SCORE_LABELS[s]).join(', ')}
                      </p>
                    ) : null}
                    {e.surveyAssignees ? (
                      <p className="text-xs text-muted-foreground">
                        Survey answers sent, credited to:{' '}
                        {e.surveyAssignees.map(webhookAssigneeText).join(', ')}
                      </p>
                    ) : null}
                    {e.surveyTeams ? (
                      <p className="text-xs text-muted-foreground">
                        Survey answers sent, of conversations in:{' '}
                        {e.surveyTeams.map(webhookTeamText).join(', ')}
                      </p>
                    ) : null}
                    {e.surveyContactTags ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Survey answers sent, of contacts tagged: {e.surveyContactTags.join(', ')}
                      </p>
                    ) : null}
                    {e.surveyConversationTags ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Survey answers sent, of conversations tagged:{' '}
                        {e.surveyConversationTags.join(', ')}
                      </p>
                    ) : null}
                    {e.contactEventTags ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Added and changed contacts sent, of contacts tagged:{' '}
                        {e.contactEventTags.join(', ')}
                      </p>
                    ) : null}
                    {e.contactEventFieldValues ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Added and changed contacts sent, of contacts with these values or changing
                        these fields:{' '}
                        {webhookContactEventFieldValuesText(e.contactEventFieldValues, fieldLabels)}
                      </p>
                    ) : null}
                    {e.teams ? (
                      <p className="text-xs text-muted-foreground">
                        Teams whose conversations’ events are sent:{' '}
                        {e.teams.map(webhookTeamText).join(', ')}
                      </p>
                    ) : null}
                    {e.assignees ? (
                      <p className="text-xs text-muted-foreground">
                        Members whose conversations’ events are sent:{' '}
                        {e.assignees.map(webhookAssigneeText).join(', ')}
                      </p>
                    ) : null}
                    {e.contactTags ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Contact tags whose conversations’ events are sent:{' '}
                        {e.contactTags.join(', ')}
                      </p>
                    ) : null}
                    {e.conversationTags ? (
                      <p className="text-xs break-all text-muted-foreground">
                        Conversation tags whose events are sent: {e.conversationTags.join(', ')}
                      </p>
                    ) : null}
                    {e.headerNames.length > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Headers sent: {e.headerNames.join(', ')} (values hidden)
                      </p>
                    ) : null}
                    {e.oauth ? (
                      <p className="text-xs break-all text-muted-foreground">
                        {webhookOAuthText(e.oauth)}
                      </p>
                    ) : null}
                    <p className="flex flex-wrap gap-1">
                      {e.eventTypes.map((t) => (
                        <Badge key={t} tone="neutral">
                          {WEBHOOK_EVENT_INFO[t].label}
                        </Badge>
                      ))}
                    </p>
                    <dl className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <div>
                        <dt className="inline">Last 24 hours </dt>
                        <dd className="inline">
                          {e.recent.succeeded} delivered, {e.recent.failed} failed,{' '}
                          {e.recent.pending + e.recent.delivering} waiting
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">Last success </dt>
                        <dd className="inline">
                          {e.lastSuccessAt ? formatDateTime(e.lastSuccessAt, tz) : 'none yet'}
                        </dd>
                      </div>
                      {e.failingSince ? (
                        <div>
                          <dt className="inline">Failing since </dt>
                          <dd className="inline">{formatDateTime(e.failingSince, tz)}</dd>
                        </div>
                      ) : null}
                      {e.disabledAt ? (
                        <div>
                          <dt className="inline">Turned off </dt>
                          <dd className="inline">{formatDateTime(e.disabledAt, tz)}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="inline">Secret </dt>
                        <dd className="inline">
                          version {e.secretVersion}
                          {e.previousSecretExpiresAt
                            ? `; the previous one also signs until ${formatDateTime(e.previousSecretExpiresAt, tz)}`
                            : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">Added </dt>
                        <dd className="inline">
                          {formatDateTime(e.createdAt, tz)}
                          {e.createdByKey
                            ? ` by the API key “${e.createdByKey.name}” (${e.createdByKey.keyPrefix}_…)`
                            : e.createdBy
                              ? ` by ${e.createdBy}`
                              : ''}
                        </dd>
                      </div>
                    </dl>
                    <p className="text-sm">
                      <Link
                        className="font-medium underline underline-offset-4"
                        href={`${base}/${e.id}`}
                      >
                        Deliveries and settings<span className="sr-only"> for {host}</span>
                      </Link>
                    </p>
                    <WebhookEndpointActions
                      slug={ctx.tenant.slug}
                      endpointId={e.id}
                      host={host}
                      active={e.state === 'active'}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {on.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Replay failed deliveries</CardTitle>
            <CardDescription>
              Sends every event whose deliveries to an endpoint that is on all failed in the period
              to that endpoint again, or only those of one event or whose last failure was of one
              kind, as each endpoint’s own replay does: {WEBHOOK_LIMITS.replayBatch} at a time
              across the endpoints, in the order they were added. Endpoints that are off are left
              out.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReplayFailedDeliveriesForm
              slug={ctx.tenant.slug}
              endpointId={null}
              events={onEvents}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>New endpoint</CardTitle>
          <CardDescription>
            Choose the events it receives. Its signing secret is shown once, when it is added.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WebhookEndpointForm
            slug={ctx.tenant.slug}
            automationChoices={automationChoices}
            runApiKeyChoices={runApiKeyChoices}
            messageApiKeyChoices={messageApiKeyChoices}
            crmApiKeyChoices={crmApiKeyChoices}
            orderApiKeyChoices={orderApiKeyChoices}
            paymentLinkApiKeyChoices={paymentLinkApiKeyChoices}
            channelChoices={channelChoices}
            teamChoices={teamChoices}
            templateChoices={templateChoices}
            campaignChoices={campaignChoices}
            storeChoices={storeChoices}
            pipelineChoices={pipelineChoices}
            stageChoices={stageChoices}
            ownerChoices={ownerChoices}
            assigneeChoices={assigneeChoices}
            contactFieldChoices={contactFieldChoices}
            atLimit={endpoints.length >= WEBHOOK_LIMITS.endpoints}
          />
        </CardContent>
      </Card>
    </div>
  );
}
