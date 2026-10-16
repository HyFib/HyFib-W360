import { NextResponse, type NextRequest } from 'next/server';
import { FILE_POLICY, FILE_ROUTE, PROVIDER_PAGES } from '@/lib/document-routes';

/**
 * Runs before every page request: generates a per-request CSP nonce and a correlation id.
 * Authentication and authorisation happen in pages, actions and route handlers against the
 * database; the proxy never makes access decisions.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const requestId = crypto.randomUUID();
  const isDev = process.env.NODE_ENV === 'development';
  const httpsOrigin = (process.env.APP_BASE_URL ?? '').startsWith('https://');
  // Meta Embedded Signup runs Facebook's SDK and login popup on the channels settings page only.
  const facebook = PROVIDER_PAGES.facebook.test(request.nextUrl.pathname);
  // Razorpay Standard Checkout (script plus its payment frame) runs on the billing page only.
  const razorpay = PROVIDER_PAGES.razorpay.test(request.nextUrl.pathname);
  const pagePolicy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${facebook ? ' https://connect.facebook.net' : ''}${razorpay ? ' https://checkout.razorpay.com' : ''}${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self'${isDev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    // Inline style attributes (used by accessible popover positioning) cannot execute script.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' blob: data:${facebook ? ' https://*.facebook.com https://*.fbcdn.net' : ''}`,
    "font-src 'self'",
    `connect-src 'self'${facebook ? ' https://*.facebook.com https://connect.facebook.net' : ''}${razorpay ? ' https://api.razorpay.com https://checkout.razorpay.com' : ''}`,
    ...(facebook
      ? [
          'frame-src https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com',
        ]
      : []),
    ...(razorpay ? ['frame-src https://api.razorpay.com https://checkout.razorpay.com'] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(httpsOrigin ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  // A file passed on from WhatsApp is not a page: nothing in it may run or load (ADR-382).
  const csp = FILE_ROUTE.test(request.nextUrl.pathname) ? FILE_POLICY : pagePolicy;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-request-id', requestId);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-request-id', requestId);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
