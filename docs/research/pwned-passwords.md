# Pwned Passwords Research: Screening the Passwords People Set

**Retrieval date:** 2026-10-08
**Scope:** The range API HyFib calls to screen a password a person sets (signing up, resetting a
forgotten password, changing one) against passwords exposed in data breaches (SEC-2, ADR-317).

## Method statement

- **Blocked sources.** Direct requests to `haveibeenpwned.com` and `api.pwnedpasswords.com` were
  refused by this environment's egress proxy (403, organization policy): **neither the
  documentation nor the API itself was opened**, and nothing here was tested against the live
  service.
- **Web search.** One search limited to `haveibeenpwned.com` and `troyhunt.com` (the service's owner
  writes about it there). A search result is only a title, a URL and a summary written by a model:
  rows that rely on one are marked OS or SEC, and their wording is not a quote.
- **Library.** Better Auth 1.7.6, already in this repository's lockfile, ships a plugin that calls
  the range API (`better-auth/dist/plugins/haveibeenpwned/index.mjs`): its request and its parsing
  were read (LIB). HyFib does not use the plugin: it calls `fetch` itself so that tests reach only a
  test-only stand-in and production config refuses any other origin (ADR-317).

### Evidence type legend

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| OS   | The official API documentation seen only as a web search summary; the page was not opened |
| SEC  | The service owner's blog seen only as a web search summary                                |
| LIB  | Better Auth 1.7.6's plugin source, read in `node_modules`                                 |
| INF  | Our own inference from the cited evidence                                                 |

## Findings

| ID    | Finding                                                                                                                                                                                        | Source                                                                                                                         | Type    | Confidence |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------- |
| P-001 | `GET https://api.pwnedpasswords.com/range/{prefix}`, where the prefix is the first five hexadecimal characters of the password's SHA-1 hash; no credentials are needed.                        | https://haveibeenpwned.com/API/v3; the plugin's request                                                                        | OS, LIB | Medium     |
| P-002 | The prefix is read in either case; the suffixes come back in upper case, 35 characters each for SHA-1.                                                                                         | https://haveibeenpwned.com/API/v3                                                                                              | OS      | Medium     |
| P-003 | The body is plain text, one `SUFFIX:COUNT` per line: the rest of a breached password's hash and how many times it was seen. The plugin splits on `\r?\n` and reads the count as a whole number. | https://www.troyhunt.com/ive-just-launched-pwned-passwords-version-2/; the plugin's parsing                                    | SEC, LIB | Medium    |
| P-004 | `Add-Padding: true` pads a response to between 800 and 1,000 lines with random suffixes whose count is 0, so a response's size does not tell which prefix was asked for; padding lines can be dropped. | https://haveibeenpwned.com/API/v3; https://www.troyhunt.com/enhancing-pwned-passwords-privacy-with-padding/; the plugin sends the header | OS, SEC, LIB | Medium |
| P-005 | The current reference says no valid prefix answers 404; an older post said a password not found answered 404.                                                                                  | https://haveibeenpwned.com/API/v3; https://www.troyhunt.com/ive-just-launched-pwned-passwords-version-2/                        | OS, SEC | Low (they disagree) |
| P-006 | The plugin sends a `User-Agent`; whether the range API requires one was not confirmed.                                                                                                         | the plugin's request                                                                                                           | LIB, INF | Low       |

## What HyFib relies on (ADR-317)

- Only P-001 to P-004: the five-character prefix is sent with `Add-Padding: true` and a
  `User-Agent`, and a suffix's count is read from lines of 35 hexadecimal characters, a colon and a
  whole number; a count of 0 (padding) or a suffix not listed is no breach.
- Not P-005: any answer other than a 2xx, a body with a line of another shape, a redirect, a failed
  request or one slower than 3 seconds makes the check unavailable, and the password is taken
  unchecked with a warning in the web log (`password breach check unavailable`).
- To verify before relying on it in production: P-001 to P-004 against the live API (one request
  from the production network, with `Add-Padding: true`), and that the production egress policy lets
  the web servers reach `api.pwnedpasswords.com:443`.
