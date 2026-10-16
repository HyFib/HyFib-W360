/**
 * The custom field values a new deal is created with (ADR-379): those typed, so a field left empty is
 * never named, and one deleted while the form was open and left empty is no error.
 */
export function givenFieldValues(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, typed]) => typed.trim() !== ''));
}

/**
 * A choice field's options as typed in Settings → Pipelines (ADR-385), one per line: each trimmed,
 * blank lines left out, in order. The server checks the rest (lengths, the limit, duplicates).
 */
export function optionLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}
