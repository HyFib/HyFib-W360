'use client';
import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { Alert } from '@w360/ui';
import { countOverdue, overdueNoticeText, type WaitingReply } from '@w360/domain/overdue-notice';

/** The clock moves in steps of this length, so a wait turning overdue shows within it. */
const TICK_MS = 10_000;
const subscribe = (onTick: () => void) => {
  const timer = setInterval(onTick, TICK_MS);
  return () => clearInterval(timer);
};
const currentStep = () => Math.floor(Date.now() / TICK_MS);

/**
 * Says how many customers the member can see are waiting past the reply target (ADR-241). The due
 * times come with the page and the count follows the clock, so a wait turning overdue shows
 * without a reload; live updates bring new waits. The server's time renders first, so the page
 * matches its HTML.
 */
export function OverdueNotice({
  href,
  renderedAt,
  waits,
  capped,
}: {
  /** The inbox's open conversations, longest wait first. */
  href: string;
  renderedAt: string;
  waits: WaitingReply[];
  capped: boolean;
}) {
  const step = useSyncExternalStore(subscribe, currentStep, () =>
    Math.floor(Date.parse(renderedAt) / TICK_MS),
  );
  const text = overdueNoticeText(countOverdue(waits, step * TICK_MS), {
    capped,
    shown: waits.length,
  });
  if (!text) return null;
  return (
    <Alert tone="warning">
      {text}{' '}
      <Link href={href} className="font-medium text-primary underline-offset-4 hover:underline">
        Longest wait first
      </Link>
    </Alert>
  );
}
