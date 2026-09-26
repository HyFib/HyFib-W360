import { Badge } from '@w360/ui';

export function ConsentBadge({
  status,
  purpose,
}: {
  status: 'opted_in' | 'opted_out' | null;
  purpose: 'marketing' | 'utility';
}) {
  const noun = purpose === 'marketing' ? 'Marketing' : 'Utility';
  if (status === 'opted_in') return <Badge tone="success">{noun}: opted in</Badge>;
  if (status === 'opted_out') return <Badge tone="danger">{noun}: opted out</Badge>;
  return <Badge>{noun}: not recorded</Badge>;
}
