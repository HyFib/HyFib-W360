'use client';
import { ClientButton } from '@/components/client-form';

/** Opens the browser's print dialog, which can also save the page as a PDF. */
export function PrintButton({ label = 'Print or save as PDF' }: { label?: string }) {
  return (
    <ClientButton
      variant="outline"
      size="sm"
      className="print:hidden"
      onClick={() => window.print()}
    >
      {label}
    </ClientButton>
  );
}
