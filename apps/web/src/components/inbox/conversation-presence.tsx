'use client';
import { useEffect, useState } from 'react';
import { PRESENCE_REPORT_MS, presenceText, type ConversationViewers } from '@w360/domain/presence';

type Report =
  | { conversationId: string; viewers: ConversationViewers }
  | { conversationId: string; failed: true };

/**
 * Tells the member which other members have the conversation open (ADR-243), so two members do not
 * answer the same customer at once. While the page is visible it reports every 20 seconds that the
 * member has the conversation open, and hears who else has; moving to another conversation or
 * leaving the page says the member left. A report that fails says so until one succeeds.
 */
export function ConversationPresence({
  slug,
  conversationId,
}: {
  slug: string;
  conversationId: string;
}) {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    const url = `/api/c/${encodeURIComponent(slug)}/inbox/${encodeURIComponent(conversationId)}/presence`;
    let stopped = false;
    let pending: AbortController | null = null;

    const send = async () => {
      if (document.visibilityState !== 'visible') return;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        // A signed-out member is redirected: that is a failed report, not a page to read.
        const res = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          redirect: 'manual',
          signal: controller.signal,
        });
        const body = res.ok
          ? ((await res.json()) as { ok: boolean } & Partial<ConversationViewers>)
          : null;
        if (stopped || controller.signal.aborted) return;
        setReport(
          body?.ok && Array.isArray(body.names)
            ? { conversationId, viewers: { names: body.names, total: body.total ?? 0 } }
            : { conversationId, failed: true },
        );
      } catch {
        // A report replaced by the next one, or ended by leaving, changes nothing; any other
        // failure shows until a report succeeds.
        if (stopped || controller.signal.aborted) return;
        setReport({ conversationId, failed: true });
      }
    };
    // Best effort: a member whose leaving is lost drops out once their last report is too old.
    const leave = () => {
      void fetch(url, { method: 'DELETE', keepalive: true, redirect: 'manual' }).catch(
        (error: unknown) => console.warn('presence leave failed', error),
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void send();
    };

    void send();
    const timer = setInterval(() => void send(), PRESENCE_REPORT_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', leave);
    return () => {
      stopped = true;
      clearInterval(timer);
      pending?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [slug, conversationId]);

  // A report about the conversation open before this one shows nothing.
  if (!report || report.conversationId !== conversationId) return null;
  if ('failed' in report) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Could not check whether other members have this conversation open.
      </p>
    );
  }
  const text = presenceText(report.viewers);
  if (!text) return null;
  return (
    <p className="text-sm font-medium text-warning" role="status">
      {text}
    </p>
  );
}
