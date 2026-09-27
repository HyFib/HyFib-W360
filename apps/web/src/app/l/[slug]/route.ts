import { followChatLink } from '@w360/domain';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const NOT_AVAILABLE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat link not available</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size: 1.25rem;">This chat link is not available</h1>
<p>The link may have been switched off. Contact the business another way.</p>
</body></html>`;

/**
 * A public short link (/l/<slug>): counts the click for the link and day (nothing about the
 * visitor is stored) and redirects to WhatsApp. The destination is built from the stored link
 * only, so this is never an open redirect.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { db } = await getRuntime();
  const target = await followChatLink(db, slug);
  if (!target) {
    return new Response(NOT_AVAILABLE, {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(null, { status: 302, headers: { location: target } });
}
