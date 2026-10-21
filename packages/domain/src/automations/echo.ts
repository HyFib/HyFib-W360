/**
 * Whether a value an HTTP step would save holds a secret its request carried (ADR-406, T355): a
 * company server that echoes the request back would otherwise hand the secret to whoever reads the
 * run's answers. The value is checked before it is clipped, as written and in the forms ordinary
 * echoes use (JSON escapes, URL and form encoding, XML and HTML character references), and for the
 * secret in base64 or base64url at any alignment. A value whose end is the start of a secret (at
 * least `ECHO_MIN_OVERLAP` characters), before or after clipping, also counts: a cut inside a
 * secret must not save most of it. Secrets the server transforms in other ways (hashed, split,
 * re-encoded twice, encrypted) are not recognised.
 */

/** Secrets shorter than this are not looked for: any value holding "201" would match a short one. */
export const ECHO_MIN_SECRET_LENGTH = 8;
/** The fewest characters at a value's end that count as the start of a secret. */
export const ECHO_MIN_OVERLAP = 4;

const JSON_ESCAPE = /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
const JSON_SIMPLE: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** JSON string escapes read (`\/`, `\"`, `\u` and four hex digits…); anything else stays as is. */
function jsonUnescaped(text: string): string {
  return text.replace(JSON_ESCAPE, (_, code: string) =>
    code.length === 5
      ? String.fromCharCode(parseInt(code.slice(1), 16))
      : (JSON_SIMPLE[code] ?? code),
  );
}

/** Percent-encoded bytes read as UTF-8 (and `+` as a space for form encoding). */
function urlDecoded(text: string, plusAsSpace: boolean): string {
  const source = plusAsSpace ? text.replace(/\+/g, ' ') : text;
  return source.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) =>
    Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'),
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  sol: '/',
  plus: '+',
  equals: '=',
};

/** XML and HTML character references read (`&amp;`, `&#47;`, `&#x2F;`). */
function entitiesDecoded(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = /^#[xX]/.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** The value as written and as each ordinary encoding would read it. */
export function decodedForms(text: string): string[] {
  return [
    ...new Set([
      text,
      jsonUnescaped(text),
      urlDecoded(text, false),
      urlDecoded(text, true),
      entitiesDecoded(text),
    ]),
  ];
}

/** An escape cut short at the end of a value (`\u00`, `%2`, `&#x2`), which no decoder reads. */
const PARTIAL_ESCAPE_END = /(?:\\u[0-9a-fA-F]{0,3}|\\|%[0-9a-fA-F]?|&#?[xX]?[0-9a-zA-Z]{0,6})$/;

/**
 * The secret's base64 and base64url forms at each of the three alignments it may start at in an
 * encoded stream, without the characters it shares with the bytes before or after it.
 */
function base64Forms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const forms: string[] = [];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    const start = offset === 0 ? 0 : offset + 1;
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    const form = encoded.slice(start, end);
    if (form.length >= ECHO_MIN_OVERLAP) {
      forms.push(form, form.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  return forms;
}

/** Whether the last characters of `text` (at least `ECHO_MIN_OVERLAP`) begin `needle`. */
function endsWithStartOf(text: string, needle: string): boolean {
  for (let k = Math.min(needle.length - 1, text.length); k >= ECHO_MIN_OVERLAP; k -= 1) {
    if (needle.startsWith(text.slice(-k))) return true;
  }
  return false;
}

/**
 * Whether `raw` (the value before clipping) or `clipped` (what would be saved) holds, or ends with
 * the start of, one of `secrets`.
 */
export function holdsSecret(raw: string, clipped: string, secrets: Iterable<string>): boolean {
  const checked = [...new Set(secrets)].filter((s) => s.length >= ECHO_MIN_SECRET_LENGTH);
  if (checked.length === 0) return false;
  const whole = decodedForms(raw);
  const ends = [raw, clipped].flatMap((v) =>
    decodedForms(v.replace(PARTIAL_ESCAPE_END, '')).concat(v),
  );
  for (const secret of checked) {
    if (whole.some((form) => form.includes(secret))) return true;
    if (ends.some((form) => endsWithStartOf(form, secret))) return true;
    for (const encoded of base64Forms(secret)) {
      if (raw.includes(encoded)) return true;
      if (endsWithStartOf(raw, encoded) || endsWithStartOf(clipped, encoded)) return true;
    }
  }
  return false;
}
