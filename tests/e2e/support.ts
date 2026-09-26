import { createHmac, randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${Date.now().toString(36)}.${randomBytes(3).toString('hex')}@example.test`;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Waits for an email to arrive in Mailpit and returns its text body. */
export async function waitForEmail(to: string, subjectIncludes: string): Promise<string> {
  let found: MailpitSummary | undefined;
  await expect
    .poll(
      async () => {
        const res = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
        );
        const body = (await res.json()) as { messages: MailpitSummary[] };
        found = body.messages.find((m) => m.Subject.includes(subjectIncludes));
        return Boolean(found);
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  const res = await fetch(`${MAILPIT}/api/v1/message/${found!.ID}`);
  const message = (await res.json()) as { Text: string };
  return message.Text;
}

export function firstLink(text: string): string {
  const match = /https?:\/\/[^\s)]+/.exec(text);
  if (!match) throw new Error('No link in email');
  return match[0];
}

export async function signUpAndVerify(
  page: Page,
  opts: { name: string; email: string; password: string; next?: string },
) {
  await page.goto(opts.next ? `/sign-up?next=${encodeURIComponent(opts.next)}` : '/sign-up');
  await page.getByLabel('Your name').fill(opts.name);
  await page.getByLabel('Work email').fill(opts.email);
  await page.getByLabel('Password').fill(opts.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
  const text = await waitForEmail(opts.email, 'Confirm your email');
  await page.goto(firstLink(text));
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for enrolling test users in two-factor auth. */
export function totp(secretBase32: string, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretBase32.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', bytes).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * WCAG reflow: the page must not scroll sideways at the current viewport (wide tables scroll
 * inside their own container instead).
 */
export async function expectNoHorizontalOverflow(page: Page) {
  const [scrollWidth, viewportWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(viewportWidth);
}
