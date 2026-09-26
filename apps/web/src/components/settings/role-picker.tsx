'use client';
import { Checkbox, Label } from '@w360/ui';

export interface RoleOption {
  value: string;
  label: string;
  description: string;
  disabled?: boolean;
}

export function RolePicker({
  idPrefix,
  options,
  value,
  onChange,
}: {
  idPrefix: string;
  options: RoleOption[];
  value: string[];
  onChange: (roles: string[]) => void;
}) {
  return (
    <fieldset className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      <legend className="mb-1 text-sm font-medium">Roles</legend>
      {options.map((o) => {
        const id = `${idPrefix}-${o.value}`;
        const checked = value.includes(o.value);
        return (
          <div key={o.value} className="flex items-start gap-2">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={checked}
              disabled={o.disabled}
              onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((r) => r !== o.value))}
            />
            <Label htmlFor={id} className="grid gap-0.5 font-normal">
              <span className="font-medium">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.description}</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}
