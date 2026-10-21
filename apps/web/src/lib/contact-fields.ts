/**
 * A choice field's options for its select on the contact page (ADR-407), with the contact's value
 * first when it is not one of them (the options changed since the page was read), so the select
 * still shows the value the contact has rather than "Not set".
 */
export function choiceOptions(options: readonly string[] | null, value: string): string[] {
  const list = [...(options ?? [])];
  return value !== '' && !list.includes(value) ? [value, ...list] : list;
}
