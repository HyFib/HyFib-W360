import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
const configured = Boolean(process.env.DATABASE_URL_MIGRATE && process.env.DATABASE_URL_APP);
const MODERN = '2026-07-28';
const meta = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '1' },
};

interface RpcBody {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

/**
 * The hosted MCP server (ADR-416) end to end: the settings page shows the endpoint, each tool's
 * scope and a client configuration without a key; a JSON-RPC exchange through the endpoint (legacy
 * initialize, its notification, the tool list, a read tool, and a tool refused for a missing scope)
 * goes through the REST API's pipeline, so every authenticated message counts as a request of the
 * key, and requests without a key, from another origin or with GET are refused uncounted.
 */
test('an assistant uses the MCP endpoint with a read-only key, counted as API requests', async ({
  page,
  request,
}) => {
  test.skip(!configured, 'needs DATABASE_URL_MIGRATE and DATABASE_URL_APP');
  test.setTimeout(120_000);
  const email = uniqueEmail('mcp');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `mcp-${suffix}`;
  const companyName = `MCP Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Mira Model', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  // A key that only reads contacts, as the page recommends for an assistant.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Assistant');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();

  // The settings page: endpoint, tools with their scopes, and a snippet with a placeholder.
  await expect(page.getByRole('heading', { name: 'AI assistants (MCP)' })).toBeVisible();
  await expect(page.getByLabel('MCP endpoint', { exact: true })).toHaveValue(/\/api\/mcp$/);
  const tools = page.getByRole('table', { name: 'MCP tools and the scopes they need' });
  await expect(tools.getByRole('row', { name: /search_contacts/ })).toContainText('Read contacts');
  await expect(tools.getByRole('row', { name: /send_template/ })).toContainText(
    'Send utility templates or Send marketing templates',
  );
  await expect(tools.getByRole('row')).toHaveCount(10);
  const snippet = page.getByLabel('Example client configuration', { exact: true });
  await expect(snippet).toHaveValue(/"Authorization": "Bearer <your API key>"/);
  expect(await snippet.inputValue()).not.toContain(token);
  await expect(page.getByText('Give an assistant its own key with read scopes only')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' };
  const post = (data: unknown, headers: Record<string, string> = {}) =>
    request.post('/api/mcp', { data, headers: { ...auth, ...headers } });
  const modern = (method: string, extra: Record<string, string> = {}) => ({
    'MCP-Protocol-Version': MODERN,
    'Mcp-Method': method,
    ...extra,
  });

  // 1. The legacy handshake, without a session.
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    },
  });
  expect(init.status()).toBe(200);
  expect(init.headers()['mcp-session-id']).toBeUndefined();
  const initBody = (await init.json()) as RpcBody;
  expect(initBody.result).toMatchObject({
    protocolVersion: '2025-11-25',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'hyfib-w360' },
  });
  // 2. Its notification: 202 without a body.
  const initialized = await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { 'MCP-Protocol-Version': '2025-11-25' },
  );
  expect(initialized.status()).toBe(202);
  expect(await initialized.text()).toBe('');

  // 3. The tool list, in the stateless revision.
  const list = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } },
    modern('tools/list'),
  );
  expect(list.status()).toBe(200);
  const listed = ((await list.json()) as RpcBody).result as {
    resultType: string;
    tools: { name: string; inputSchema: { type: string } }[];
  };
  expect(listed.resultType).toBe('complete');
  expect(listed.tools.map((t) => t.name)).toContain('send_text_reply');
  expect(listed.tools).toHaveLength(9);

  // 4. A read tool the key may use.
  const search = await post(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search_contacts', arguments: { limit: 5 }, _meta: meta },
    },
    modern('tools/call', { 'Mcp-Name': 'search_contacts' }),
  );
  const searched = ((await search.json()) as RpcBody).result as {
    isError: boolean;
    content: { type: string; text: string }[];
  };
  expect(searched.isError).toBe(false);
  expect(JSON.parse(searched.content[0]!.text)).toEqual({ data: [], nextCursor: null });

  // 5. A tool refused for a scope the key lacks: a tool error with the REST API's words.
  const templates = await post(
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_templates', arguments: {}, _meta: meta },
    },
    modern('tools/call', { 'Mcp-Name': 'list_templates' }),
  );
  expect(templates.status()).toBe(200);
  const refusedTool = ((await templates.json()) as RpcBody).result as {
    isError: boolean;
    content: { text: string }[];
  };
  expect(refusedTool.isError).toBe(true);
  expect(JSON.parse(refusedTool.content[0]!.text)).toMatchObject({
    status: 403,
    error: { code: 'forbidden', message: 'This API key does not have the templates.read scope.' },
  });

  // 6. A body that is not JSON: counted (the pipeline reads it after counting, as for REST) and
  // answered with JSON-RPC's parse error. Sent as bytes: Playwright encodes a string that is not
  // JSON as a JSON string when the content type is JSON, which would be valid JSON.
  const broken = await request.post('/api/mcp', {
    data: Buffer.from('{"jsonrpc":"2.0",', 'utf8'),
    headers: { ...auth, 'Content-Type': 'application/json' },
  });
  expect(broken.status()).toBe(400);
  expect(((await broken.json()) as RpcBody).error).toMatchObject({
    code: -32700,
    message: 'The body is not valid JSON.',
  });

  // Refused before the pipeline counts anything: no key, another origin, GET.
  const anonymous = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: meta } },
    headers: modern('tools/list'),
  });
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()['www-authenticate']).toBe('Bearer');
  expect(((await anonymous.json()) as RpcBody).error).toMatchObject({
    code: 401,
    data: { code: 'unauthenticated' },
  });
  const foreign = await post(
    { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: meta } },
    modern('tools/list', { Origin: 'https://evil.example' }),
  );
  expect(foreign.status()).toBe(403);
  expect(foreign.headers()['access-control-allow-origin']).toBeUndefined();
  const get = await request.get('/api/mcp', { headers: auth });
  expect(get.status()).toBe(405);
  expect(get.headers()['allow']).toBe('POST');

  // A REST request with the same key: six MCP messages and it make seven requests of the key.
  expect((await request.get('/api/v1/contacts', { headers: auth })).status()).toBe(200);
  await page.reload();
  await expect(page.getByText(/Requests this period:\s*7\s*\(no limit of its own\)/)).toBeVisible();
});
