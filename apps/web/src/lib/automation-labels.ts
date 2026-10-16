/** Member-facing names for automation states and run outcomes (server and client). */
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const AUTOMATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'info' },
  waiting: { label: 'Waiting', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  handed_off: { label: 'Handed off', tone: 'success' },
  taken_over: { label: 'Taken over', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const END_REASONS: Record<string, string> = {
  end_node: 'Reached an End step.',
  no_next: 'Reached a step with nothing after it.',
  handoff_node: 'Handed the conversation to people.',
  agent_replied: 'A member replied, so the automation stopped.',
  assigned: 'The conversation was assigned to a member.',
  take_over: 'A member took the conversation over.',
  api_replied: 'A reply was sent through the API, so the automation stopped.',
  stopped_by_member: 'A member stopped the run.',
  conversation_resolved: 'The conversation was resolved.',
  opted_out: 'The customer opted out.',
  contact_erased: 'The contact was erased.',
  automation_archived: 'The automation was archived.',
  stopped_by_api: 'Stopped through the API.',
  budget_steps: 'Too many steps: the run reached its step limit.',
  budget_loop: 'A step repeated too often: the run reached its loop limit.',
  budget_messages: 'The run reached its message limit.',
  budget_http: 'The run reached its web request limit.',
  expired: 'The run was older than 7 days.',
  send_blocked: 'A message could not be sent.',
  send_failed: 'A message did not reach the customer.',
  error: 'The run could not continue.',
};

export const STEP_OUTCOMES: Record<string, string> = {
  started: 'Started',
  sent: 'Sent a message',
  asked: 'Asked the customer',
  answered: 'Got an answer',
  retried: 'Asked again',
  timed_out: 'No reply in time',
  branched: 'Checked a condition',
  updated: 'Updated the contact',
  waiting: 'Started waiting',
  resumed: 'Wait ended',
  handed_off: 'Handed off',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  taken_over: 'Taken over',
  requested: 'Made a web request',
  responded: 'Web request finished',
  created: 'Created in the CRM',
  moved: 'Moved the deal',
  closed: 'Closed the deal',
  skipped: 'Skipped the step',
};

export const STEP_DETAILS: Record<string, string> = {
  keyword: 'a keyword in the customer’s message',
  conversation_started: 'a new conversation',
  any_message: 'a customer message',
  test: 'a test started by a member',
  api: 'a call through the HyFib W360 API',
  'store_event:order_placed': 'a new order in a store',
  'store_event:order_shipped': 'an order shipped by a store',
  'store_event:order_delivered': 'an order delivered',
  'store_event:order_cancelled': 'an order cancelled in a store',
  // Form steps (ADR-248, checked again when the step runs).
  flow_unavailable:
    'the form is archived, no longer published, or of another WhatsApp account than the number',
  flows_not_in_plan: 'the company’s plan does not include WhatsApp Flows',
  // Products steps (ADR-383, checked again when the step runs).
  products_unavailable:
    'a product was removed, its catalog disconnected, or the catalog is not of the number’s WhatsApp account',
  commerce_not_in_plan: 'the company’s plan does not include commerce',
  // Template steps (checked again when the step runs).
  template_unavailable: 'the template is no longer approved, or HyFib cannot send it',
  template_changed:
    'the template’s variables or quick-reply buttons changed after the step was set up',
  channel_unavailable: 'the WhatsApp number is not active or does not match the template',
  missing_variable: 'a template variable was empty after filling in placeholders',
  invalid_link:
    'the end of a website button’s link held spaces, was too long or would change the website',
  suppressed: 'the number is on the company’s suppression list',
  opted_out: 'the contact opted out of these messages',
  no_marketing_opt_in: 'the template is a marketing template and the contact has not opted in',
  frequency_capped: 'the contact already received as many marketing messages as the company allows',
  window_closed: 'the 24-hour customer service window had closed',
  channel_inactive: 'the WhatsApp number is not active',
  no_phone: 'the contact has no WhatsApp number on this line',
  empty_message: 'the message was empty after filling in placeholders',
  contact_erased: 'the contact was erased',
  too_many_tags: 'the contact already has the maximum number of tags',
  conversation_too_many_tags: 'the conversation already has the maximum number of tags',
  field_missing: 'the contact field no longer exists',
  invalid_value: 'the value did not fit the contact field',
  // Task and deal steps (ADR-249): the plan's CRM.
  crm_not_in_plan: 'the company’s plan does not include the CRM',
  // Task steps (ADR-244): why no task was created.
  task_title_empty: 'the task’s title was empty after filling in placeholders',
  task_assignee_unavailable:
    'the member the task was for is no longer an active member who can use the CRM',
  // Deal steps (ADR-245): why no deal was created, or what it was created without.
  deal_title_empty: 'the deal’s title was empty after filling in placeholders',
  deal_stage_unavailable: 'the pipeline or the stage was archived or removed',
  deal_already_open: 'the contact already has an open deal in the pipeline',
  deal_owner_unavailable:
    'the deal has no owner: the member chosen is no longer an active member who can use the CRM',
  deal_value_invalid:
    'the deal has no value: the value is not an amount in the pipeline’s currency',
  // Steps that move or close deals (ADR-250, ADR-251): why nothing changed.
  deal_not_open: 'the contact has no open deal in the pipeline',
  deal_ambiguous:
    'the contact has more than one open deal in the pipeline, so which one is meant is not known',
  deal_in_stage: 'the deal was already in the stage',
  tester_not_member: 'the member running the test left the company',
  tester_not_permitted: 'the member running the test may no longer run tests',
  version_unreadable: 'the version could not be read',
  step_error: 'a step failed repeatedly because of an internal error',
  canceled: 'the message was cancelled before it was sent',
  unknown_outcome: 'it is not known whether WhatsApp received the message',
  send_timeout: 'WhatsApp did not accept the message within 10 minutes',
  failed: 'WhatsApp did not accept or deliver the message',
  missing_node: 'the step no longer exists',
  // Web requests (the step log shows a status code, or one of these).
  domain_not_allowed: 'the domain is not on the company’s allowed list',
  secret_missing: 'a secret the request uses no longer exists',
  secret_domain_mismatch: 'a secret the request uses is saved for another domain',
  invalid_url: 'the address was not valid after filling in placeholders',
  not_started: 'the request was not made in time, so it was cancelled',
  no_result: 'no result in time; the server may have received the request',
  missing_call: 'the request record was not found',
  run_ended: 'the run ended before the request was made',
  run_ended_in_flight: 'the run ended before the server answered; it may have received the request',
  address_blocked: 'the address is on a private or reserved network',
  dns_failed: 'the host name could not be resolved',
  connect_failed: 'the server could not be reached',
  timeout: 'no complete response within 10 seconds; the server may have received the request',
  network_error: 'the connection broke during the request; the server may have received it',
  response_too_large: 'the response was larger than 256 KB',
  request_too_large: 'the request body was larger than 64 KB',
  header_not_allowed: 'a header name or value is not allowed',
  scheme_not_allowed: 'only https:// addresses can be called',
  port_not_allowed: 'the port is not allowed (use 443 or 1024 and up)',
  credentials_in_url: 'the address contained a user name or password',
};

/** A web request's state on the run page. */
export const HTTP_CALL_STATE: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Waiting to be made', tone: 'info' },
  in_flight: { label: 'In progress', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Outcome unknown', tone: 'warning' },
  canceled: { label: 'Not made', tone: 'neutral' },
};

/** The order event that started a run (runs started by order messages). */
export const STORE_EVENT_LABELS: Record<string, string> = {
  order_placed: 'Started by a new order',
  order_shipped: 'Started when an order shipped',
  order_delivered: 'Started when an order was delivered',
  order_cancelled: 'Started when an order was cancelled',
};

export const TRIGGER_TYPE_LABELS: Record<string, string> = {
  keyword: 'Keyword',
  conversation_started: 'New conversation',
  any_message: 'Any message',
  test: 'Test',
  store_event: 'Order messages',
  api: 'API',
};

/** Text for a step-log or end detail code, including send failures (`failed:<code>`). */
export function describeDetail(detail: string): string {
  if (/^[1-5]\d\d$/.test(detail)) return `the server answered with status ${detail}`;
  if (detail.startsWith('failed:')) {
    const code = detail.slice('failed:'.length);
    return STEP_DETAILS[code] ?? `WhatsApp did not accept or deliver the message (error ${code})`;
  }
  return STEP_DETAILS[detail] ?? END_REASONS[detail] ?? detail;
}
