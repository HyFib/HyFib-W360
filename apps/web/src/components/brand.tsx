export function Brand({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <span aria-hidden="true" className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
        W
      </span>
      <span>
        HyFib <span className="text-primary">W360</span>
      </span>
    </span>
  );
}
