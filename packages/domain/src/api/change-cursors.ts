import { AppError, type Keyring } from '@w360/core';

/**
 * Cursors of the change feeds (ADR-114, ADR-116). A position is a database transaction id and a row
 * id, which would show how busy the whole platform is (transaction ids are shared by every
 * company), so a cursor is sealed with the keyring and bound to its feed and its company: another
 * company's cursor, another feed's, a changed one or one sealed with a key the platform no longer
 * holds does not open.
 */
export type ChangeFeed = 'contact-changes' | 'message-changes';

/** A place in a company's feed: after the change with this transaction and id. */
export interface ChangePosition {
  xact: string;
  id: string;
}

/**
 * A cursor of the contact feed (ADR-329): its place, and where the reader's pass through the feed
 * began (`since`), from which the feed counts what changed; null for a cursor sealed before passes
 * were, whose pass began nobody knows where.
 */
export interface ChangePass {
  at: ChangePosition;
  since: ChangePosition | null;
}

const START: ChangePosition = { xact: '0', id: '0' };
const POSITION_RE = /^(\d{1,20})\.(\d{1,19})$/;
const PASS_RE = /^(\d{1,20})\.(\d{1,19})(?:~(\d{1,20})\.(\d{1,19}))?$/;
const INVALID_CURSOR =
  'Invalid cursor: give the nextCursor of a page of this feed, or no cursor to start again from the first change.';

const cursorAad = (feed: ChangeFeed, tenantId: string) => `${feed}|tenant:${tenantId}`;

const invalidCursor = () =>
  new AppError('validation_failed', INVALID_CURSOR, {
    issues: [{ path: 'cursor', message: INVALID_CURSOR }],
  });

/** Seals a place, with where the reader's pass began for the contact feed (ADR-329). */
export function sealChangeCursor(
  keyring: Keyring,
  feed: ChangeFeed,
  tenantId: string,
  at: ChangePosition,
  since: ChangePosition | null = null,
): string {
  const sealed = since ? `${at.xact}.${at.id}~${since.xact}.${since.id}` : `${at.xact}.${at.id}`;
  return Buffer.from(keyring.encrypt(sealed, cursorAad(feed, tenantId))).toString('base64url');
}

function openSealed(keyring: Keyring, feed: ChangeFeed, tenantId: string, cursor: string): string {
  try {
    return keyring.decryptString(
      Buffer.from(cursor, 'base64url').toString('utf8'),
      cursorAad(feed, tenantId),
    );
  } catch {
    // Tampered, another company's or feed's, or sealed with a key the platform no longer holds.
    throw invalidCursor();
  }
}

/** The position a cursor seals; the feed's start without one. */
export function openChangeCursor(
  keyring: Keyring,
  feed: ChangeFeed,
  tenantId: string,
  cursor: string | undefined,
): ChangePosition {
  if (cursor === undefined) return START;
  const match = POSITION_RE.exec(openSealed(keyring, feed, tenantId, cursor));
  if (!match?.[1] || !match[2]) throw invalidCursor();
  return { xact: match[1], id: match[2] };
}

/**
 * The place a contact feed cursor seals and where its pass began (ADR-329): a new pass from the
 * feed's start without a cursor; `since` null for a cursor sealed before passes were.
 */
export function openChangePass(
  keyring: Keyring,
  feed: ChangeFeed,
  tenantId: string,
  cursor: string | undefined,
): ChangePass {
  if (cursor === undefined) return { at: START, since: START };
  const match = PASS_RE.exec(openSealed(keyring, feed, tenantId, cursor));
  if (!match?.[1] || !match[2]) throw invalidCursor();
  return {
    at: { xact: match[1], id: match[2] },
    since: match[3] && match[4] ? { xact: match[3], id: match[4] } : null,
  };
}
