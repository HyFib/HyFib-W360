import { describe, expect, it } from 'vitest';
import { FILE_POLICY, FILE_ROUTE, needsOwnDocument } from './document-routes';

const ID = '0192f3a4-5b6c-7d8e-9f00-112233445566';

describe('the policy each answer is given', () => {
  it('gives the inbox’s files a policy under which nothing runs (ADR-382)', () => {
    expect(FILE_POLICY).toBe("default-src 'none'; sandbox");
    for (const path of [`/c/acme/inbox/${ID}/media/${ID}`, `/c/acme/inbox/${ID}/media/${ID}/`]) {
      expect(FILE_ROUTE.test(path), path).toBe(true);
    }
    for (const path of [
      `/c/acme/inbox/${ID}`,
      `/c/acme/inbox/${ID}/media`,
      `/c/acme/inbox/${ID}/media/${ID}/more`,
      `/c/acme/inbox/${ID}/transcript`,
      `/api/v1/messages/${ID}/media`,
      `/x/c/acme/inbox/${ID}/media/${ID}`,
    ]) {
      expect(FILE_ROUTE.test(path), path).toBe(false);
    }
  });

  it('opens the pages with a provider’s script as documents of their own', () => {
    expect(needsOwnDocument('/c/acme/settings/channels')).toBe(true);
    expect(needsOwnDocument('/c/acme/billing/')).toBe(true);
    expect(needsOwnDocument('/c/acme/inbox')).toBe(false);
  });
});
