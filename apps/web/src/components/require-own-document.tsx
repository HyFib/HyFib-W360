'use client';
import { useEffect } from 'react';

/**
 * Safety net for pages that need their own Content-Security-Policy (see lib/document-routes.ts):
 * if the page was reached by client-side navigation, the document still carries the previous
 * page's policy, so reload once to get this page's policy from the server.
 */
export function RequireOwnDocument() {
  useEffect(() => {
    const [entry] = performance.getEntriesByType('navigation');
    if (!entry) return;
    const strip = (path: string) => path.replace(/\/+$/, '') || '/';
    if (strip(new URL(entry.name).pathname) !== strip(window.location.pathname)) {
      window.location.reload();
    }
  }, []);
  return null;
}
