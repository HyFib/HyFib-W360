'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface LiveEvent {
  conversationId: string | null;
}

/**
 * Subscribes to the company's live-update stream and refreshes server-rendered data when something
 * relevant changes. The stream resumes from `since` (the event-log position read before the page
 * loaded its data), so changes between the render and the connection are not missed. Falls back
 * to polling (with a durable cursor) when streaming keeps failing, and reloads the page when
 * access is revoked.
 */
export function LiveEvents({
  slug,
  conversationId,
  since,
}: {
  slug: string;
  conversationId?: string;
  since?: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'connecting' | 'live' | 'polling' | 'offline'>('connecting');
  const [announcement, setAnnouncement] = useState('');
  // The position of the first render; later renders (router.refresh) must not restart the stream.
  const resumeFrom = useRef<string | null>(since ?? null);

  useEffect(() => {
    let source: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cursor: string | null = resumeFrom.current;
    let failures = 0;
    let stopped = false;

    const scheduleRefresh = (events: LiveEvent[]) => {
      if (conversationId && events.some((e) => e.conversationId === conversationId)) {
        setAnnouncement(`New activity in this conversation at ${new Date().toLocaleTimeString()}`);
      }
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        router.refresh();
      }, 300);
    };

    const poll = async () => {
      if (stopped) return;
      try {
        const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const res = await fetch(`/api/c/${slug}/events?mode=poll${query}`, { cache: 'no-store' });
        if (res.status === 404) {
          window.location.reload();
          return;
        }
        if (res.ok) {
          const body = (await res.json()) as { events: LiveEvent[]; cursor: string };
          cursor = body.cursor;
          resumeFrom.current = body.cursor;
          if (body.events.length > 0) scheduleRefresh(body.events);
          setMode('polling');
        } else {
          setMode('offline');
        }
      } catch {
        setMode('offline');
      }
      if (!stopped) pollTimer = setTimeout(() => void poll(), 10_000);
    };

    const startPolling = () => {
      source?.close();
      source = null;
      // Resynchronise once: events between the stream failing and the first poll are not lost.
      router.refresh();
      void poll();
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      const resume = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      source = new EventSource(`/api/c/${slug}/events${resume}`);
      source.addEventListener('open', () => {
        // After a reconnect, resynchronise once: events older than the log's retention window
        // cannot be replayed from the cursor.
        if (failures > 0) scheduleRefresh([]);
        failures = 0;
        setMode('live');
      });
      source.addEventListener('update', (event) => {
        const message = event as MessageEvent<string>;
        if (message.lastEventId) {
          cursor = message.lastEventId;
          resumeFrom.current = message.lastEventId;
        }
        try {
          scheduleRefresh([JSON.parse(message.data) as LiveEvent]);
        } catch {
          scheduleRefresh([]);
        }
      });
      source.addEventListener('revoked', () => {
        source?.close();
        window.location.reload();
      });
      source.addEventListener('error', () => {
        failures += 1;
        setMode('connecting');
        if (failures >= 3) startPolling();
      });
    }

    return () => {
      stopped = true;
      source?.close();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [slug, conversationId, router]);

  const label = {
    connecting: 'Connecting…',
    live: 'Live',
    polling: 'Updating every 10 seconds',
    offline: 'Offline, retrying',
  }[mode];
  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={
            mode === 'live'
              ? 'size-2 rounded-full bg-success'
              : mode === 'offline'
                ? 'size-2 rounded-full bg-destructive'
                : 'size-2 rounded-full bg-warning'
          }
        />
        {label}
      </span>
    </>
  );
}
