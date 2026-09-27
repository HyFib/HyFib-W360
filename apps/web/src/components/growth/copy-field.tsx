'use client';
import { useId, useState } from 'react';
import { Field, Input } from '@w360/ui';
import { ClientButton } from '@/components/client-form';

/** A read-only value (a link, an embed tag) with a button that copies it. */
export function CopyField({
  label,
  value,
  description,
  multiline = false,
}: {
  label: string;
  value: string;
  description?: string;
  multiline?: boolean;
}) {
  const id = useId();
  const [status, setStatus] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <Field id={id} label={label} description={description}>
        {(aria) =>
          multiline ? (
            <textarea
              {...aria}
              readOnly
              rows={3}
              value={value}
              className="w-full rounded-md border border-border bg-muted/40 p-2 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : (
            <Input
              {...aria}
              readOnly
              value={value}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
          )
        }
      </Field>
      <div className="flex items-center gap-2">
        <ClientButton
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => setStatus('Copied.'),
              () => setStatus('Copying is not allowed here: select the text and copy it.'),
            );
          }}
        >
          Copy<span className="sr-only"> {label}</span>
        </ClientButton>
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      </div>
    </div>
  );
}
