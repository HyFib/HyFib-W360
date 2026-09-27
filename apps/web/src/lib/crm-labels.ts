/** Member-facing names for CRM states and timeline entries (server and client). */
type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const DEAL_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'info' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'neutral' },
};

export const TASK_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const REMINDER_TEXT: Record<string, string> = {
  pending: 'Reminder set',
  sent: 'Reminder emailed',
  skipped: 'Reminder not sent',
};

export const REMINDER_DETAIL: Record<string, string> = {
  task_closed: 'the task was closed first',
  too_late: 'it was more than a day late',
  assignee_inactive: 'the assignee can no longer use the CRM',
};

/** What a timeline entry says happened (the actor is shown separately). */
export const ACTIVITY_TEXT: Record<string, string> = {
  deal_created: 'Deal created',
  deal_updated: 'Deal edited',
  stage_changed: 'Stage changed',
  owner_changed: 'Owner changed',
  deal_won: 'Deal won',
  deal_lost: 'Deal lost',
  deal_reopened: 'Deal reopened',
  task_created: 'Task added',
  task_completed: 'Task done',
  task_reopened: 'Task reopened',
  task_cancelled: 'Task cancelled',
  note: 'Note',
};

export const DEAL_FIELD_TEXT: Record<string, string> = {
  title: 'title',
  value: 'value',
  expected_close_on: 'expected close date',
};

export function contactLabel(contact: {
  name: string | null;
  phone: string | null;
  erased: boolean;
}): string {
  if (contact.erased) return 'Erased contact';
  return contact.name ?? contact.phone ?? 'Unnamed contact';
}
