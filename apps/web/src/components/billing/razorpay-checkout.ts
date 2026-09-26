'use client';

/**
 * Razorpay Standard Checkout in the browser (R-004, R-030). Card details are entered inside
 * Razorpay's own frame; this page only receives the payment id, order id and signature, which the
 * server verifies and then checks with Razorpay before anything is credited.
 */
const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export interface CheckoutResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(
    event: 'payment.failed',
    handler: (response: { error?: { description?: string } }) => void,
  ): void;
}

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let loading: Promise<RazorpayConstructor> | null = null;

function loadCheckout(): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;
  loading = new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay Checkout did not load.'));
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Razorpay Checkout could not be loaded. Check your connection.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export class CheckoutClosedError extends Error {
  override name = 'CheckoutClosedError';
}

/** Opens Checkout for a server-created order; resolves with the handler response. */
export async function openCheckout(options: {
  keyId: string;
  orderId: string;
  amountMinor: number;
  companyName: string;
  description: string;
  prefill: { name: string; email: string; contact?: string };
  customerId?: string;
  recurring?: boolean;
  /** Called when an attempt fails inside Checkout (the customer may retry in the same window). */
  onAttemptFailed?: (message: string) => void;
}): Promise<CheckoutResponse> {
  const Razorpay = await loadCheckout();
  return new Promise<CheckoutResponse>((resolve, reject) => {
    let settled = false;
    const instance = new Razorpay({
      key: options.keyId,
      order_id: options.orderId,
      amount: options.amountMinor,
      currency: 'INR',
      name: 'HyFib W360',
      description: options.description,
      prefill: options.prefill,
      notes: { company: options.companyName.slice(0, 200) },
      ...(options.customerId ? { customer_id: options.customerId } : {}),
      ...(options.recurring ? { recurring: true } : {}),
      handler(response: CheckoutResponse) {
        settled = true;
        resolve(response);
      },
      modal: {
        ondismiss() {
          if (!settled) reject(new CheckoutClosedError('Payment window closed.'));
        },
      },
    });
    instance.on('payment.failed', (response) => {
      // Checkout lets the customer retry inside the same window, so the promise settles only on
      // success or when the window is closed.
      options.onAttemptFailed?.(response.error?.description ?? 'The payment attempt failed.');
    });
    instance.open();
  });
}
