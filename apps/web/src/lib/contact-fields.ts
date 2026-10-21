/**
 * A choice field's options for its select on the contact page (ADR-407), in order. A value the
 * options no longer hold (they changed since it was set, which the service's rules prevent but a
 * page read before a change can still show) is listed first, marked `stale`, so the select shows
 * the value the contact has rather than "Not set", disabled so it cannot be chosen again.
 */
export function choiceOptions(
  options: readonly string[] | null,
  value: string,
): { option: string; stale: boolean }[] {
  const list = (options ?? []).map((option) => ({ option, stale: false }));
  return value !== '' && !(options ?? []).includes(value)
    ? [{ option: value, stale: true }, ...list]
    : list;
}

/**
 * The custom field values a contact's form sends when it is saved: those the member changed from
 * what the page showed (an emptied one as an empty value, which clears it), so values left alone
 * are never checked again.
 */
export function changedAttributes(
  initial: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(current).filter(([key, value]) => value !== (initial[key] ?? '')),
  );
}
