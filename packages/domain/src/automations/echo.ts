/**
 * Whether a value an HTTP step would save holds a secret its request carried (ADR-406, T355): a
 * company server that echoes the request back would otherwise hand the secret to whoever reads the
 * run's answers. The value is checked before it is clipped, as written and in the forms ordinary
 * echoes use (JSON escapes, URL and form encoding, XML and HTML character references), and for the
 * secret (eight characters or more) in base64 or base64url at any alignment, in each of those
 * forms. A secret of six characters or more counts anywhere; a shorter one (a PIN, say) only as a
 * whole token, so the status "201" is not taken for part of a secret, unless the request sent it
 * touching a letter, a digit or another secret (`loose`), when it counts anywhere too. A value whose
 * end is the start of a long secret is a possible cut echo: after other text from
 * `ECHO_MIN_OVERLAP` characters, with nothing before it from `ECHO_LONG_SECRET_LENGTH` (so "live"
 * against `live_9f8a…` is saved), before or after clipping. Secrets the server transforms in other
 * ways (hashed, split, re-encoded twice, encrypted, a number parsed and written again, a prefix
 * followed by an ellipsis) are not recognised.
 */

/** Secrets at least this long are also looked for in base64 and as the start of a cut echo. */
export const ECHO_LONG_SECRET_LENGTH = 8;
/** Secrets at least this long count anywhere in a value; shorter ones only as whole tokens. */
export const ECHO_ANYWHERE_SECRET_LENGTH = 6;
/** The fewest characters at a value's end that count as the start of a secret. */
export const ECHO_MIN_OVERLAP = 4;

/** Why a value is left out: it holds a secret, or it may be an echo cut inside one. */
export type EchoFinding = 'echoed_secret' | 'possible_cut_echo';

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

/**
 * Whether the last characters of `text` begin `needle`: from `ECHO_MIN_OVERLAP` characters after
 * other text, or from `ECHO_LONG_SECRET_LENGTH` when the whole value is the start of the needle. A
 * value that is only a secret's first word ("live" against `live_9f8a…`) is ordinary data; one
 * that is its first eight characters or more is not.
 */
function endsWithStartOf(text: string, needle: string): boolean {
  for (let k = Math.min(needle.length - 1, text.length); k >= ECHO_MIN_OVERLAP; k -= 1) {
    if (k === text.length && k < ECHO_LONG_SECRET_LENGTH) continue;
    if (needle.startsWith(text.slice(-k))) return true;
  }
  return false;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A short secret as a whole token: no letter or digit right before it when it starts with one, nor
 * right after it when it ends with one (`#123` is found in `x#123`).
 */
function tokenPattern(secret: string): RegExp {
  const before = LETTER_OR_DIGIT.test(secret.slice(0, 1)) ? '(?<![\\p{L}\\p{N}])' : '';
  const after = LETTER_OR_DIGIT.test(secret.slice(-1)) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${before}${escapeRegExp(secret)}${after}`, 'u');
}

interface PreparedSecret {
  secret: string;
  /** Set for a short secret matched as a whole token; null when it counts anywhere. */
  token: RegExp | null;
  /** The secret and its base64 forms, for cut echoes (long secrets only). */
  starts: string[];
  /** Its base64 forms, looked for anywhere (long secrets only). */
  encoded: string[];
}

/** Finds secrets in values; built once per response, used for each value it saves. */
export type EchoMatcher = (raw: string, clipped: string) => EchoFinding | null;

/**
 * A matcher for `secrets` (the values the request carried). `loose` are secrets the request sent
 * touching a letter, a digit or another secret, which count anywhere whatever their length.
 */
export function echoMatcher(secrets: Iterable<string>, loose: Iterable<string> = []): EchoMatcher {
  const looseSet = new Set(loose);
  const prepared: PreparedSecret[] = [...new Set(secrets)]
    .filter((s) => s.length > 0)
    .map((secret) => {
      const long = secret.length >= ECHO_LONG_SECRET_LENGTH;
      const anywhere = secret.length >= ECHO_ANYWHERE_SECRET_LENGTH || looseSet.has(secret);
      const encoded = long ? base64Forms(secret) : [];
      return {
        secret,
        token: anywhere ? null : tokenPattern(secret),
        starts: long ? [secret, ...encoded] : [],
        encoded,
      };
    });
  const forms = new Map<string, string[]>();
  const formsOf = (text: string) => {
    let found = forms.get(text);
    if (!found) {
      found = decodedForms(text);
      forms.set(text, found);
    }
    return found;
  };
  return (raw, clipped) => {
    if (prepared.length === 0) return null;
    const whole = formsOf(raw);
    for (const { secret, token, encoded } of prepared) {
      const found = token
        ? whole.some((form) => token.test(form))
        : whole.some((form) => form.includes(secret)) ||
          encoded.some((e) => whole.some((form) => form.includes(e)));
      if (found) return 'echoed_secret';
    }
    // The end of the value, before and (when it was cut) after clipping, an escape cut short ignored.
    const ends = [
      ...formsOf(raw.replace(PARTIAL_ESCAPE_END, '')).concat(raw),
      ...(clipped !== raw ? formsOf(clipped.replace(PARTIAL_ESCAPE_END, '')).concat(clipped) : []),
    ];
    for (const { starts } of prepared) {
      if (starts.some((needle) => ends.some((form) => endsWithStartOf(form, needle)))) {
        return 'possible_cut_echo';
      }
    }
    return null;
  };
}

/**
 * Whether `raw` (the value before clipping) or `clipped` (what would be saved) holds one of
 * `secrets` (`echoed_secret`) or ends with the start of a long one (`possible_cut_echo`); null when
 * neither.
 */
export const echoedSecret = (
  raw: string,
  clipped: string,
  secrets: Iterable<string>,
  loose: Iterable<string> = [],
): EchoFinding | null => echoMatcher(secrets, loose)(raw, clipped);

/** Whether a value holds a secret or may be an echo cut inside one (`echoedSecret` not null). */
export const holdsSecret = (raw: string, clipped: string, secrets: Iterable<string>): boolean =>
  echoedSecret(raw, clipped, secrets) !== null;

/**
 * The secrets a request's headers send touching a letter, a digit or another secret (a step
 * published before ADR-406's separator check): their echoes count anywhere, not only as tokens.
 */
export function adjacentSecrets(
  headers: readonly { parts: readonly ({ text: string } | { secret: string })[] }[],
): Set<string> {
  const names = new Set<string>();
  for (const { parts } of headers) {
    parts.forEach((part, i) => {
      if (!('secret' in part)) return;
      const touches = (
        neighbour: { text: string } | { secret: string } | undefined,
        edge: number,
      ) =>
        neighbour !== undefined &&
        ('secret' in neighbour ||
          LETTER_OR_DIGIT.test(neighbour.text.slice(edge < 0 ? -1 : 0, edge < 0 ? undefined : 1)));
      if (touches(parts[i - 1], -1) || touches(parts[i + 1], 1)) names.add(part.secret);
    });
  }
  return names;
}
