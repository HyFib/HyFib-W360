import { chatWidgetConfig, renderWidgetScript } from '@w360/domain';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const JS = 'text/javascript; charset=utf-8';

/**
 * The website widget script (/widget/<id>.js), embedded by companies on their own sites. It is
 * public and holds no secrets: the button text, colours and the chat link's short address. Cache
 * and cross-origin headers are set in next.config.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const publicId = file.endsWith('.js') ? file.slice(0, -3) : '';
  const { db, config } = await getRuntime();
  const widget = publicId ? await chatWidgetConfig(db, publicId) : null;
  if (!widget) {
    return new Response('/* This chat widget is not available. */\n', {
      status: 404,
      headers: { 'content-type': JS },
    });
  }
  return new Response(renderWidgetScript(widget, publicId, config.APP_BASE_URL), {
    status: 200,
    headers: { 'content-type': JS },
  });
}
