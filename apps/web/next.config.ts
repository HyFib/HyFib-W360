import path from 'node:path';
import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(self), usb=(), interest-cohort=()',
  },
];

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: false,
  transpilePackages: ['@w360/core', '@w360/db', '@w360/domain', '@w360/contracts', '@w360/ui'],
  serverExternalPackages: ['pg', 'pg-boss', 'nodemailer', 'pino'],
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Authenticated pages and API responses must never be stored by shared caches.
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
      {
        // Meta Embedded Signup's popup must be able to message this page back (later rules win).
        source: '/c/:slug/settings/channels',
        headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' }],
      },
      {
        // Razorpay Checkout may open bank authentication popups and uses its own payment frame.
        source: '/c/:slug/billing',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com"), usb=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default config;
