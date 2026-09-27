import 'server-only';
import { AppError } from '@w360/core';
import {
  formatLocalDateTime,
  parseLocalDateTime,
  resolveLocalTime,
  zonedParts,
} from '@w360/domain';

/**
 * Task forms show and take times as wall-clock readings in the company's time zone (like campaign
 * schedules), so every member sees the same due time. These convert to and from instants.
 */
export function localToIso(value: unknown, timeZone: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const local = typeof value === 'string' ? parseLocalDateTime(value.slice(0, 16)) : null;
  if (!local) throw new AppError('validation_failed', 'Enter a valid date and time.');
  return resolveLocalTime(local, timeZone).instant.toISOString();
}

export function isoToLocal(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  return formatLocalDateTime(zonedParts(new Date(iso).getTime(), timeZone));
}
