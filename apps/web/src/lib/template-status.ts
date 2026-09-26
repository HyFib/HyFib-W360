type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export const TEMPLATE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitting: { label: 'Submitting', tone: 'info' },
  submit_failed: { label: 'Submission failed', tone: 'danger' },
  pending: { label: 'In review', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  paused: { label: 'Paused by Meta', tone: 'warning' },
  disabled: { label: 'Disabled by Meta', tone: 'danger' },
  in_appeal: { label: 'In appeal', tone: 'info' },
  flagged: { label: 'Flagged', tone: 'warning' },
  archived: { label: 'Archived', tone: 'neutral' },
  pending_deletion: { label: 'Being deleted', tone: 'neutral' },
  deleted: { label: 'Deleted', tone: 'neutral' },
  limit_exceeded: { label: 'Limit exceeded', tone: 'warning' },
  locked: { label: 'Locked', tone: 'warning' },
  unknown: { label: 'Unknown status', tone: 'neutral' },
};

export function templateStatus(status: string) {
  return TEMPLATE_STATUS[status] ?? { label: status, tone: 'neutral' as const };
}
