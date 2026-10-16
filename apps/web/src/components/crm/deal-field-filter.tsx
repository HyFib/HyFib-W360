import Link from 'next/link';
import type { DealFieldFilterView } from '@w360/domain';
import { Alert, Button, Label, Select } from '@w360/ui';

/** Why a view shows every deal although its link names a filter that matches nothing (ADR-391). */
export function staleDealFieldFilterNotice(view: string): string {
  return `The deal field filter in this link matches no field or option of the company (it may have been deleted or renamed), so the ${view} is not filtered.`;
}

/**
 * The "Deal field" filter of the board (ADR-391), the won and lost lists (ADR-394) and Reports'
 * deals section (ADR-396): the notice for a filter the view did not apply, and a plain GET form (it
 * works before hydration, no client code) whose hidden inputs carry the view's other parameters. A
 * new filter starts the view again: a list at its newest page.
 */
export function DealFieldFilter({
  action,
  filter,
  notice,
  hidden,
  clearHref,
}: {
  /** The page the form shows again with the filter. */
  action: string;
  filter: DealFieldFilterView;
  /** What the notice says when the view did not apply the filter its link names. */
  notice: string;
  hidden: Record<string, string>;
  /** The view without the filter ("Show all deals"). */
  clearHref: string;
}) {
  const applied = filter.applied?.param ?? '';
  return (
    <>
      {filter.ignored ? (
        <Alert tone="warning" title="Showing every deal">
          {notice}
        </Alert>
      ) : null}
      {filter.fields.length > 0 ? (
        <form
          method="get"
          action={action}
          className="flex flex-wrap items-end gap-3"
          aria-label="Filter deals by a field"
        >
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <div className="grid min-w-0 max-w-full gap-1">
            <Label htmlFor="deal-field-filter">Deal field</Label>
            {/* Keyed by the applied filter: "Show all deals" and the view links navigate in the
                browser, which keeps the page's elements, and a kept select would go on showing
                the filter of the page before. */}
            <Select
              key={applied}
              id="deal-field-filter"
              name="field"
              defaultValue={applied}
              className="w-64 max-w-full"
            >
              <option value="">All deals</option>
              {filter.fields.map((f) => (
                <optgroup key={f.key} label={f.label}>
                  {f.choices.map((choice) => (
                    <option key={choice.param} value={choice.param}>
                      {`${f.label}: ${choice.label}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="outline">
            Filter deals
          </Button>
          {filter.applied ? (
            <Link
              href={clearHref}
              className="self-center text-sm text-primary underline-offset-4 hover:underline"
            >
              Show all deals
            </Link>
          ) : null}
        </form>
      ) : null}
    </>
  );
}
