import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
/** Resolves to 127.0.0.1 on the test machine; see webhooks.spec.ts. */
const HOST = process.env.E2E_HTTP_HOST ?? '';

test.skip(
  !HOST || process.env.W360_EGRESS_ALLOW_LOOPBACK !== 'true',
  'Webhook receiver not provided (E2E_HTTP_HOST resolving to 127.0.0.1, W360_EGRESS_ALLOW_LOOPBACK)',
);

let receiver: Server;
let port = 0;
const received: { path: string; body: string }[] = [];

test.beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body });
      res.writeHead(204);
      res.end();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  port = (receiver.address() as AddressInfo).port;
});

test.afterAll(() => {
  receiver?.close();
});

/** A delivered deal event, as far as this test reads it. */
interface DealEventBody {
  type: string;
  data: { deal: { id: string; pipelineId: string; stageId: string } };
}

test('an endpoint receives the deal events of the pipelines (ADR-263) and stages (ADR-264) it names only, chosen in settings and changed on its page', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('dealhooks');
  const slug = `dealhooks-${Date.now().toString(36)}`;
  const path = `/deals/${slug}`;
  const forUs = () =>
    received.filter((r) => r.path === path).map((r) => JSON.parse(r.body) as DealEventBody);
  await signUpAndVerify(page, { name: 'Dev Deals', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Deal Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  // Two rupee pipelines with the suggested stages.
  for (const name of ['Sales', 'Renewals']) {
    await page.goto(`/c/${slug}/settings/pipelines`);
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Create pipeline' }) });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByRole('button', { name: 'Create pipeline' }).click();
    await expect(page.getByText('Pipeline created.')).toBeVisible();
  }

  // Settings → Webhooks: deals added, in Sales only.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Deal added/ }).check();
  await page
    .getByRole('radio', { name: /Only those of the deals in the pipelines ticked/ })
    .check();
  await page.getByRole('checkbox', { name: 'Sales', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Renewals', exact: true })).not.toBeChecked();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByLabel('Signing secret')).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.reload();
  await expect(
    page.getByText('Pipelines whose deals’ events are sent: Sales', { exact: true }),
  ).toBeVisible();

  // A key adds a contact, then a deal in Renewals and one in Sales.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Deal sync');
  await page.getByRole('checkbox', { name: /Read CRM deals/ }).check();
  await page.getByRole('checkbox', { name: /Create and change CRM deals/ }).check();
  await page
    .getByRole('checkbox', { name: /Create and change contacts and record consent/ })
    .check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const tokenField = page.getByLabel('API key', { exact: true });
  await expect(tokenField).toBeVisible();
  const auth = { Authorization: `Bearer ${await tokenField.inputValue()}` };
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const pipelinesRes = await request.get('/api/v1/pipelines', { headers: auth });
  expect(pipelinesRes.status()).toBe(200);
  const pipelines = (
    (await pipelinesRes.json()) as {
      data: { id: string; name: string; stages: { id: string; name: string }[] }[];
    }
  ).data;
  const pipelineId = (name: string) => pipelines.find((p) => p.name === name)!.id;
  const stageId = (pipeline: string, name: string) =>
    pipelines.find((p) => p.name === pipeline)!.stages.find((st) => st.name === name)!.id;
  const contactRes = await request.post('/api/v1/contacts', {
    headers: auth,
    data: { phone: `+9198${String(Date.now()).slice(-8)}`, name: 'Hari' },
  });
  expect(contactRes.status()).toBe(201);
  const contactId = ((await contactRes.json()) as { data: { id: string } }).data.id;
  // An Idempotency-Key is visible ASCII only, so the title's spaces become hyphens.
  const addDeal = async (pipeline: string, title: string) => {
    const res = await request.post('/api/v1/deals', {
      headers: { ...auth, 'Idempotency-Key': `${slug}-${title.replaceAll(' ', '-')}` },
      data: { contactId, pipelineId: pipelineId(pipeline), title },
    });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };
  await addDeal('Renewals', 'Renewal 2027');
  const sale = await addDeal('Sales', 'Annual plan');

  // Only the Sales deal reaches the endpoint: the renewal was never queued for it.
  await expect
    .poll(() => forUs().map((b) => [b.type, b.data.deal.id, b.data.deal.pipelineId]))
    .toEqual([['deal.created', sale, pipelineId('Sales')]]);
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  await expect(page.getByRole('heading', { name: `Deliveries to ${HOST}` })).toBeVisible();
  const deliveries = page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem');
  await expect(deliveries).toHaveCount(1);
  await expect(deliveries).toContainText('deal.created');

  // On the endpoint's page, Renewals too; the next renewal reaches it.
  await expect(page.getByRole('checkbox', { name: 'Sales', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Renewals', exact: true }).check();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  const renewal = await addDeal('Renewals', 'Renewal 2028');
  await expect
    .poll(() =>
      forUs()
        .map((b) => b.data.deal.id)
        .sort(),
    )
    .toEqual([sale, renewal].sort());
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(
    page.getByText('Pipelines whose deals’ events are sent: Sales, Renewals', { exact: true }),
  ).toBeVisible();

  // On its page again: moves too, of deals in Sales' Qualified stage only (ADR-264). A deal the key
  // adds in New is not sent; moved to Qualified, it is.
  await page.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  await expect(page.getByRole('heading', { name: `Deliveries to ${HOST}` })).toBeVisible();
  await page.getByRole('checkbox', { name: /Deal stage/ }).check();
  await page.getByRole('radio', { name: /Only those of the deals in the stages ticked/ }).check();
  await page.getByRole('checkbox', { name: 'Sales: Qualified', exact: true }).check();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  const lead = await addDeal('Sales', 'Second order');
  const qualified = stageId('Sales', 'Qualified');
  const moved = await request.patch(`/api/v1/deals/${lead}`, {
    headers: auth,
    data: { stageId: qualified },
  });
  expect(moved.status()).toBe(200);
  await expect
    .poll(() =>
      forUs()
        .filter((b) => b.data.deal.id === lead)
        .map((b) => [b.type, b.data.deal.stageId]),
    )
    .toEqual([['deal.stage_changed', qualified]]);
  await page.reload();
  await expect(page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem')).toHaveCount(3);
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(
    page.getByText('Stages whose deals’ events are sent: Sales: Qualified', { exact: true }),
  ).toBeVisible();
});
