import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow } from './support';

interface OpenApiDocument {
  servers: { url: string }[];
  paths: Record<string, Record<string, { operationId: string }>>;
  webhooks: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

test('the API reference shows anyone every operation, event and schema of the OpenAPI document', async ({
  page,
  request,
}) => {
  const res = await request.get('/api/v1/openapi.json');
  expect(res.status()).toBe(200);
  const doc = (await res.json()) as OpenApiDocument;
  const expected = [
    ...Object.values(doc.paths).flatMap((item) =>
      Object.entries(item)
        .filter(([method]) => METHODS.has(method))
        .map(([, operation]) => `op-${operation.operationId}`),
    ),
    ...Object.keys(doc.webhooks).map((type) => `event-${type}`),
    ...Object.keys(doc.components.schemas).map((name) => `schema-${name}`),
  ].sort();
  expect(expected.length).toBeGreaterThan(100);

  // No session: the page is public and stays where it is.
  await page.goto('/developers');
  await expect(page).toHaveURL(/\/developers$/);
  await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(doc.servers[0]?.url ?? '', { exact: true })).toBeVisible();
  await expect(page.getByText('Authorization: Bearer <API key>', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'OpenAPI document' })).toHaveAttribute(
    'href',
    '/api/v1/openapi.json',
  );
  await expectNoHorizontalOverflow(page);

  // Exactly one section for every operation, webhook event and schema the document has.
  const sections = await page.evaluate(() =>
    Array.from(document.querySelectorAll('main section[id]'), (section) => section.id),
  );
  expect(sections.filter((id) => /^(op|event|schema)-/.test(id)).sort()).toEqual(expected);

  // The contents lead to an operation, and its body's types lead to their schemas.
  const contents = page.getByRole('navigation', { name: 'Contents' });
  await contents.getByRole('link', { name: 'POST /messages', exact: true }).click();
  await expect(page).toHaveURL(/#op-sendMessage$/);
  const send = page.getByRole('region', { name: 'POST /messages', exact: true });
  await expect(send.getByRole('heading', { level: 3 })).toBeInViewport();
  await expect(send.getByRole('table', { name: 'Parameters of POST /messages' })).toContainText(
    'Idempotency-Key',
  );
  await send.getByRole('link', { name: 'SendText', exact: true }).click();
  await expect(page).toHaveURL(/#schema-SendText$/);
  const sendText = page.getByRole('region', { name: 'SendText', exact: true });
  await expect(sendText.getByRole('heading', { level: 3 })).toBeInViewport();
  await expect(
    sendText.getByRole('table', { name: 'Fields of SendText' }).getByRole('row', { name: /^text/ }),
  ).toBeVisible();
  // Fields inside fields, and each shape of a union, have rows of their own.
  const error = page.getByRole('table', { name: 'Fields of Error' });
  await expect(error.getByRole('row', { name: /^issues/ })).toBeVisible();
  await expect(error.getByRole('row', { name: /^path/ })).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: 'Fields of ContactSearch' })
      .getByRole('row', { name: /^One shape: type = tag/ }),
  ).toBeVisible();

  // An event shows the headers it is signed with and what to answer.
  await contents.getByRole('link', { name: 'message.received', exact: true }).click();
  await expect(page).toHaveURL(/#event-message\.received$/);
  const received = page.getByRole('region', { name: 'message.received', exact: true });
  await expect(received.getByRole('heading', { level: 3 })).toBeInViewport();
  await expect(received.getByRole('table', { name: 'Headers of message.received' })).toContainText(
    'W360-Signature',
  );
  await expect(received.getByRole('list', { name: 'Answers to message.received' })).toContainText(
    '2XX',
  );
  await expectNoHorizontalOverflow(page);
});
