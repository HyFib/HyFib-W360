import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  const { auth } = await getRuntime();
  return auth.handler(request);
}

export { handle as GET, handle as POST };
