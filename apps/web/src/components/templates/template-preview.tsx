import type { RenderedTemplate } from '@w360/domain';

/** Plain-text rendering of a template message (never HTML). */
export function TemplatePreview({
  rendered,
  label,
}: {
  rendered: RenderedTemplate;
  label?: string;
}) {
  return (
    <div
      className="grid gap-1 rounded-lg border border-border bg-background p-3 text-sm"
      aria-label={label ?? 'Template preview'}
    >
      {rendered.header ? <p className="font-semibold">{rendered.header}</p> : null}
      <p className="whitespace-pre-wrap break-words">{rendered.body}</p>
      {rendered.footer ? <p className="text-xs text-muted-foreground">{rendered.footer}</p> : null}
      {rendered.buttons.length > 0 ? (
        <ul className="mt-1 grid gap-1 border-t border-border pt-2">
          {rendered.buttons.map((b, i) => (
            <li key={i} className="text-center text-xs font-medium text-primary">
              {b.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
