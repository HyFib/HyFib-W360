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
  stopped_by_member: 'A member stopped the run.',
  conversation_resolved: 'The conversation was resolved.',
  opted_out: 'The customer opted out.',
  contact_erased: 'The contact was erased.',
  automation_archived: 'The automation was archived.',
  budget_steps: 'Too many steps: the run reached its step limit.',
  budget_loop: 'A step repeated too often: the run reached its loop limit.',
  budget_messages: 'The run reached its message limit.',
  expired: 'The run was older than 7 days.',
  send_blocked: 'A message could not be sent.',
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
};

export const STEP_DETAILS: Record<string, string> = {
  keyword: 'a keyword in the customer’s message',
  conversation_started: 'a new conversation',
  any_message: 'a customer message',
  test: 'a test started by a member',
  window_closed: 'the 24-hour customer service window had closed',
  channel_inactive: 'the WhatsApp number is not active',
  no_phone: 'the contact has no WhatsApp number on this line',
  empty_message: 'the message was empty after filling in placeholders',
  contact_erased: 'the contact was erased',
  too_many_tags: 'the contact already has the maximum number of tags',
  field_missing: 'the contact field no longer exists',
  invalid_value: 'the value did not fit the contact field',
  tester_not_member: 'the member running the test left the company',
  version_unreadable: 'the version could not be read',
  step_error: 'a step failed repeatedly because of an internal error',
  missing_node: 'the step no longer exists',
};

export const TRIGGER_TYPE_LABELS: Record<string, string> = {
  keyword: 'Keyword',
  conversation_started: 'New conversation',
  any_message: 'Any message',
  test: 'Test',
};
