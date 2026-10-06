import { csvLine } from '../contacts/csv';

/**
 * Automation runs as CSV (ADR-237): one line per run with what the runs list shows, formula-safe
 * (`csvLine`), times in UTC (ISO 8601). No customer data: neither the contact nor the conversation
 * nor the answers a run captured.
 */
export const RUN_CSV_COLUMNS = [
  'run_id',
  'automation',
  'version',
  'mode',
  'status',
  'end_reason',
  'trigger',
  'started_at',
  'ended_at',
  'steps',
  'messages',
] as const;

export interface RunCsvRow {
  id: string;
  automationName: string;
  versionNumber: number | null;
  mode: string;
  status: string;
  endReason: string | null;
  triggerType: string | null;
  startedAt: Date;
  endedAt: Date | null;
  steps: number;
  messages: number;
}

/** One run's CSV line. */
export function runCsvLine(row: RunCsvRow): string {
  return csvLine([
    row.id,
    row.automationName,
    row.versionNumber,
    row.mode,
    row.status,
    row.endReason,
    row.triggerType,
    row.startedAt.toISOString(),
    row.endedAt?.toISOString() ?? '',
    row.steps,
    row.messages,
  ]);
}
