import type { Clock } from '@w360/core';
import type { Database } from '@w360/db';
import type { BillingNoticeDeps } from './notices';
import type { RazorpayClient, RazorpayResult } from './razorpay';

/**
 * What applying Razorpay's facts needs: the database, the client, the clock and billing notices.
 * Every fact is fetched from Razorpay (never taken from a webhook body, a browser redirect or a
 * checkout signature alone), and companies are resolved from our own provider-id mappings.
 */
export interface BillingProviderDeps {
  db: Database;
  razorpay: RazorpayClient;
  clock: Clock;
  notices: BillingNoticeDeps;
}

/** Razorpay did not answer in a way that settles the question: the caller tries again later. */
export class TransientProviderError extends Error {
  override name = 'TransientProviderError';
}

type Failure = Extract<RazorpayResult<never>, { ok: false }>;

export function transient(result: Failure, what: string): TransientProviderError {
  return new TransientProviderError(`${what}: ${result.kind} ${result.description}`);
}
