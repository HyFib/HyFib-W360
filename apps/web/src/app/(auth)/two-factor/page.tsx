import type { Metadata } from 'next';
import { TwoFactorForm } from '@/components/auth/two-factor-form';

export const metadata: Metadata = { title: 'Two-factor verification' };
export const dynamic = 'force-dynamic';

export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <TwoFactorForm next={typeof next === 'string' ? next : null} />;
}
