/**
 * The custom field values a new deal is created with (ADR-379): those typed, so a field left empty is
 * never named, and one deleted while the form was open and left empty is no error.
 */
export function givenFieldValues(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, typed]) => typed.trim() !== ''));
}
