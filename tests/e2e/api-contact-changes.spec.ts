import { expect, test } from './fixtures';
import { signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

interface ChangePage {
  data: {
    id: string;
    erased: boolean;
    contact: { name: string | null; tags: string[] } | null;
  }[];
  nextCursor: string;
  hasMore: boolean;
}

test('a key follows contact changes: every contact first, then what members change, an erasure included (ADR-114)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('apichanges');
  const slug = `apichanges-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Kavya Changes', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Change Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  // A key that reads and adds contacts.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('CRM sync');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page
    .getByRole('checkbox', { name: /Create and change contacts and record consent/ })
    .check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const tokenField = page.getByLabel('API key', { exact: true });
  await expect(tokenField).toBeVisible();
  const token = await tokenField.inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };
  const changes = async (cursor?: string) => {
    const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor }).toString()}`;
    const res = await request.get(`/api/v1/contact-changes${query}`, { headers: auth });
    expect(res.status()).toBe(200);
    return (await res.json()) as ChangePage;
  };
  // A change is read once every transaction begun before it has finished, the worker's included,
  // so each read is repeated until the change shows.
  const changesUntil = async (cursor: string | undefined, check: (page: ChangePage) => void) => {
    let page: ChangePage | undefined;
    await expect(async () => {
      page = await changes(cursor);
      check(page);
    }).toPass({ timeout: 30_000 });
    return page!;
  };

  // Two contacts through the API: the feed lists both, oldest change first.
  const digits = String(Date.now()).slice(-7);
  const ids: string[] = [];
  for (const [name, phone] of [
    ['Lata', `+91971${digits}`],
    ['Mohan', `+91972${digits}`],
  ] as const) {
    const created = await request.post('/api/v1/contacts', {
      headers: auth,
      data: { phone, name },
    });
    expect(created.status()).toBe(201);
    ids.push(((await created.json()) as { data: { id: string } }).data.id);
  }
  const [lata, mohan] = ids as [string, string];
  const first = await changesUntil(undefined, (page) =>
    expect(page.data.map((c) => [c.id, c.contact?.name])).toEqual([
      [lata, 'Lata'],
      [mohan, 'Mohan'],
    ]),
  );
  expect(first.hasMore).toBe(false);
  expect((await changes(first.nextCursor)).data).toEqual([]);

  // A member tags Lata in the app: the key reads her change only.
  await page.goto(`/c/${slug}/contacts/${lata}`);
  await expect(page.getByRole('heading', { name: 'Lata', level: 1 })).toBeVisible();
  await page.getByLabel('Add tags').fill('gold');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText('gold');
  const tagged = await changesUntil(first.nextCursor, (page) =>
    expect(page.data.map((c) => [c.id, c.contact?.tags])).toEqual([[lata, ['gold']]]),
  );

  // The member erases Mohan: the key reads him as erased, with nothing about him.
  await page.goto(`/c/${slug}/contacts/${mohan}`);
  await expect(page.getByRole('heading', { name: 'Mohan', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Erase contact' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Erase contact' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/contacts$`));
  await changesUntil(tagged.nextCursor, (page) =>
    expect(page.data).toEqual([{ id: mohan, erased: true, contact: null }]),
  );

  // A cursor the feed did not give is refused, naming it.
  const refused = await request.get('/api/v1/contact-changes?cursor=not-a-cursor', {
    headers: auth,
  });
  expect(refused.status()).toBe(422);
  expect(
    ((await refused.json()) as { error: { issues: { path: string }[] } }).error.issues.map(
      (i) => i.path,
    ),
  ).toEqual(['cursor']);
});
