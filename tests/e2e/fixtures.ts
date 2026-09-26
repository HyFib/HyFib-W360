import { test as base } from '@playwright/test';
import pg from 'pg';

/**
 * Every test starts with an empty authentication rate-limit table in the disposable test
 * database, so the suite (many sign-ups from one IP across four browser projects) exercises the
 * real limiter without tripping it. Production limits are never loosened for tests.
 */
export const test = base.extend<{ resetRateLimits: undefined }>({
  resetRateLimits: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
    async ({}, use) => {
      const url = process.env.E2E_DATABASE_URL_AUTH;
      if (url) {
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        try {
          await client.query('DELETE FROM auth.rate_limits');
        } finally {
          await client.end();
        }
      }
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
