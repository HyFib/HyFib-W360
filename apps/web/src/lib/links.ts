/**
 * Whether a stored link is one the inbox opens (ADR-194): https with a host and no user name or
 * password, read as the API reads links when it takes them, so a scheme written `HTTPS:` counts.
 */
export function isHttpsLink(value: string | null): value is string {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
}
